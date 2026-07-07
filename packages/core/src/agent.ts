import Anthropic from "@anthropic-ai/sdk";
import { buildMemorySection, loadProjectInstructions } from "./memory.ts";
import { COMPACTION_INSTRUCTION, DEFAULT_SYSTEM_PROMPT } from "./prompt.ts";
import type { Session } from "./session.ts";
import type {
  AgentEvent,
  CanUseTool,
  StopReason,
  Tool,
  ToolContext,
  ToolResult,
} from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-4-8";

const MAX_TOOL_OUTPUT_CHARS = 50_000;
const DEFAULT_COMPACTION_THRESHOLD = 150_000;
const SUMMARY_MAX_TOKENS = 8_000;

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
  /** Append CARBON.md project instructions from cwd (walking up to the repo root). Default true. */
  projectInstructions?: boolean;
  /** Persistent memory directory. If set, its MEMORY.md index is injected into the system prompt at session start. */
  memoryDir?: string;
  /** Compact when the estimated prompt size crosses this many tokens. Default 150k. */
  compactionThreshold?: number;
  /** Automatically compact when the threshold is crossed. Default true. */
  autoCompact?: boolean;
  /**
   * Thinking config sent on every request. Defaults to adaptive/summarized.
   * Pass `null` to omit it entirely — required for Anthropic-compatible
   * endpoints whose model doesn't accept the param (e.g. kimi-k2.7-code).
   */
  thinking?: Anthropic.ThinkingConfigParam | null;
  /**
   * Send `cache_control` prompt-caching markers. Default true. Turn off for
   * endpoints that reject the field.
   */
  cacheControl?: boolean;
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
  readonly memoryDir?: string;
  readonly compactionThreshold: number;
  readonly autoCompact: boolean;
  readonly thinking: Anthropic.ThinkingConfigParam | null;
  readonly cacheControl: boolean;
  messages: Anthropic.MessageParam[];

  /** Estimated size of the next prompt, from the previous response's usage. */
  private lastPromptTokens = 0;
  private canUseTool: CanUseTool;

  constructor(options: AgentOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
    this.cwd = options.cwd ?? process.cwd();
    this.memoryDir = options.memoryDir;
    // System prompt = base + CARBON.md project instructions + memory index.
    // Composed once at construction: it must stay byte-stable for the whole
    // session or the prompt cache prefix breaks.
    const parts = [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT];
    if (options.projectInstructions !== false) {
      const project = loadProjectInstructions(options.cwd ?? process.cwd());
      if (project) parts.push(project);
    }
    if (this.memoryDir) parts.push(buildMemorySection(this.memoryDir));
    this.systemPrompt = parts.join("\n\n");
    this.maxTokens = options.maxTokens ?? 64_000;
    this.compactionThreshold = options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    this.autoCompact = options.autoCompact ?? true;
    this.thinking =
      options.thinking === undefined ? { type: "adaptive", display: "summarized" } : options.thinking;
    this.cacheControl = options.cacheControl ?? true;
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
      // Proactive compaction: the previous response's usage tells us roughly
      // how big the next prompt is, for free — no count_tokens call.
      if (this.autoCompact && this.lastPromptTokens > this.compactionThreshold) {
        yield* this.maybeCompact(signal);
      }

      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          ...(this.thinking ? { thinking: this.thinking } : {}),
          // Breakpoint on the system block caches tools + system; the top-level
          // marker auto-caches the growing conversation prefix each turn.
          ...(this.cacheControl ? { cache_control: { type: "ephemeral" as const } } : {}),
          system: this.systemBlocks(),
          tools: this.toolDefinitions(),
          messages: this.messages,
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          yield { type: "thinking", text: event.delta.thinking };
        }
      }

      const message = await stream.finalMessage();

      // Reactive fallback: the request overflowed the context window. Don't
      // record the (empty) response — compact and retry the same turn once.
      // (Cast: this stop_reason isn't in the SDK's union yet.)
      if ((message.stop_reason as string) === "model_context_window_exceeded") {
        const compacted = yield* this.maybeCompact(signal);
        if (compacted) continue;
        yield { type: "done", stopReason: "model_context_window_exceeded" as StopReason };
        return;
      }

      this.pushMessage({ role: "assistant", content: message.content });
      this.lastPromptTokens = promptTokens(message.usage);
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

  /**
   * Summarize the conversation and fold everything before the most recent
   * real user turn into a single summary message, keeping that turn and
   * whatever followed it verbatim. The tail must start at a real user turn
   * (text content, not tool results) so tool_use/tool_result pairing is never
   * severed. Returns null when there is nothing safe to fold (a single turn
   * larger than the window — the accepted v1 limitation).
   */
  async compact(
    signal?: AbortSignal,
  ): Promise<{ summary: string; foldedMessages: number } | null> {
    const cut = this.lastRealUserTurnIndex();
    if (cut <= 0) return null;
    const summary = await this.summarize(signal);
    const tail = this.messages.slice(cut);
    this.messages = [
      { role: "user", content: `<compaction-summary>\n${summary}\n</compaction-summary>` },
      ...tail,
    ];
    this.lastPromptTokens = 0;
    this.session?.appendCompaction(this.messages, summary);
    return { summary, foldedMessages: cut };
  }

  private async *maybeCompact(signal?: AbortSignal): AsyncGenerator<AgentEvent, boolean> {
    if (this.lastRealUserTurnIndex() <= 0) return false;
    yield { type: "compaction_start" };
    const result = await this.compact(signal);
    if (!result) return false;
    yield { type: "compaction_end", summary: result.summary, foldedMessages: result.foldedMessages };
    return true;
  }

  /** Index of the most recent user message that is a real turn, not tool results. */
  private lastRealUserTurnIndex(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role !== "user") continue;
      if (typeof m.content === "string") return i;
      if (Array.isArray(m.content) && m.content.some((b) => b.type !== "tool_result")) {
        return i;
      }
    }
    return -1;
  }

  private async summarize(signal?: AbortSignal): Promise<string> {
    // Reuse the exact system prompt and tools so the history stays a cache
    // read; append the instruction as a final user message. No thinking —
    // this is a plain summarization.
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: this.systemBlocks(),
        tools: this.toolDefinitions(),
        messages: [...this.messages, { role: "user", content: COMPACTION_INSTRUCTION }],
      },
      { signal },
    );
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || "(summary unavailable)";
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
    const ctx: ToolContext = { cwd: this.cwd, signal, memoryDir: this.memoryDir };
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

  private systemBlocks(): Anthropic.TextBlockParam[] {
    return [
      {
        type: "text",
        text: this.systemPrompt,
        ...(this.cacheControl ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ];
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

/** Total tokens a response occupied — approximates the next prompt's size. */
function promptTokens(usage: Anthropic.Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens
  );
}
