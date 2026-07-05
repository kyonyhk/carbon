import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt.ts";
import type { Session } from "./session.ts";
import type {
  AgentEvent,
  CanUseTool,
  Tool,
  ToolContext,
  ToolResult,
} from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-4-8";

const MAX_TOOL_OUTPUT_CHARS = 50_000;

export interface AgentOptions {
  client?: Anthropic;
  model?: string;
  systemPrompt?: string;
  tools?: Tool[];
  cwd?: string;
  maxTokens?: number;
  /** Approval hook for non-read-only tools. Defaults to allowing everything. */
  canUseTool?: CanUseTool;
  /** Transcript store. If set, every message is appended as it happens. */
  session?: Session;
  /** Resume from prior history (e.g. loaded from a session file). */
  messages?: Anthropic.MessageParam[];
}

/**
 * The agent loop: send the conversation, stream the response, execute any
 * tool calls, feed results back, repeat until the model stops calling tools.
 *
 * Headless by design — it yields AgentEvents and never touches stdin/stdout.
 * A mount (CLI, server, cron job) consumes the events and owns all I/O,
 * including how tool permission prompts are presented.
 */
export class Agent {
  readonly client: Anthropic;
  readonly model: string;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly maxTokens: number;
  readonly tools: Map<string, Tool>;
  readonly session?: Session;
  messages: Anthropic.MessageParam[];

  private canUseTool: CanUseTool;

  constructor(options: AgentOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.cwd = options.cwd ?? process.cwd();
    this.maxTokens = options.maxTokens ?? 64_000;
    this.tools = new Map((options.tools ?? []).map((t) => [t.name, t]));
    this.canUseTool = options.canUseTool ?? (async () => ({ behavior: "allow" }));
    this.session = options.session;
    this.messages = options.messages ?? [];
  }

  /**
   * Run one user turn to completion. Aborting the signal interrupts the run
   * cleanly: the in-flight request is cancelled, remaining tool calls get
   * synthetic "interrupted" results (the API requires every tool_use to have
   * a matching tool_result), and the generator ends with a "done" event whose
   * stopReason is "interrupted". The agent stays usable for the next turn.
   */
  async *run(
    input: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent, void> {
    const { signal } = options;
    this.pushMessage({ role: "user", content: input });
    try {
      yield* this.loop(signal);
    } catch (error) {
      if (signal?.aborted) {
        yield { type: "done", stopReason: "interrupted" };
        return;
      }
      throw error;
    }
  }

  private async *loop(signal?: AbortSignal): AsyncGenerator<AgentEvent, void> {
    while (true) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        thinking: { type: "adaptive", display: "summarized" },
        // Breakpoint on the system block caches tools + system; the top-level
        // marker auto-caches the growing conversation prefix each turn.
        cache_control: { type: "ephemeral" },
        system: [
          {
            type: "text",
            text: this.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: this.toolDefinitions(),
        messages: this.messages,
      }, { signal });

      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          yield { type: "thinking", text: event.delta.thinking };
        }
      }

      const message = await stream.finalMessage();
      this.pushMessage({ role: "assistant", content: message.content });
      yield {
        type: "response_end",
        stopReason: message.stop_reason,
        usage: message.usage,
      };

      // Server-side pause — re-send as-is and the API resumes where it left off.
      if (message.stop_reason === "pause_turn") continue;

      if (message.stop_reason !== "tool_use") {
        yield { type: "done", stopReason: message.stop_reason };
        return;
      }

      const toolCalls = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolCalls) {
        // Interrupted mid-batch: the remaining calls still need results or the
        // next request would be rejected for an unanswered tool_use.
        if (signal?.aborted) {
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: "Interrupted by user before this tool ran.",
            is_error: true,
          });
          continue;
        }
        yield { type: "tool_start", id: call.id, name: call.name, input: call.input };
        const result = await this.executeTool(call.name, call.input, signal);
        yield { type: "tool_result", id: call.id, name: call.name, result };
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result.output,
          is_error: result.isError ?? false,
        });
      }
      // All results for one assistant turn go back in a single user message.
      this.pushMessage({ role: "user", content: results });

      if (signal?.aborted) {
        yield { type: "done", stopReason: "interrupted" };
        return;
      }
    }
  }

  private async executeTool(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: `Unknown tool: ${name}`, isError: true };
    }
    if (!tool.readOnly) {
      const decision = await this.canUseTool(tool, input);
      if (decision.behavior === "deny") {
        return {
          output: decision.message ?? "The user denied this tool call.",
          isError: true,
        };
      }
    }
    const ctx: ToolContext = { cwd: this.cwd, signal };
    try {
      const result = await tool.execute(input, ctx);
      return { ...result, output: truncate(result.output) };
    } catch (error) {
      if (signal?.aborted) {
        return { output: "Interrupted by user.", isError: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Tool failed: ${message}`, isError: true };
    }
  }

  private pushMessage(message: Anthropic.MessageParam): void {
    this.messages.push(message);
    this.session?.append(message);
  }

  private toolDefinitions(): Anthropic.Tool[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}

function truncate(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const dropped = output.length - MAX_TOOL_OUTPUT_CHARS;
  return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated: ${dropped} characters dropped]`;
}
