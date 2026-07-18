import type Anthropic from "@anthropic-ai/sdk";
import { Agent, DEFAULT_MODEL } from "../agent.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../prompt.ts";
import { Session } from "../session.ts";
import type { CanUseTool, TaskRef, Tool, ToolResult } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export interface TaskToolOptions {
  client?: Anthropic;
  model?: string;
  cwd?: string;
  /**
   * Tools available to subagents. When set, it is used verbatim at every
   * depth — the consumer owns the toolset. When unset, subagents get the four
   * core tools, plus a task tool of their own while their depth is below
   * maxDepth.
   */
  tools?: Tool[];
  /** Permission hook for the subagent's tool calls. Pass the mount's hook. */
  canUseTool?: CanUseTool;
  systemPrompt?: string;
  maxTokens?: number;
  /** Memory directory for subagents. Defaults to the spawning agent's own. */
  memoryDir?: string;
  /** Thinking config for subagents (pass null to disable, e.g. for Kimi code models). */
  thinking?: Anthropic.ThinkingConfigParam | null;
  /** Send cache_control markers for subagents. */
  cacheControl?: boolean;
  /** How deep spawn chains may go. Default 2: root → orchestrator → workers. */
  maxDepth?: number;
  /**
   * Total spawns shared by every descendant for this tool's lifetime — in a
   * long-lived mount that keeps one agent across turns, that is the whole
   * session. Default 32.
   */
  maxSpawns?: number;
  /** Aggregate token cap across all subagents (usage sum), same lifetime. Default: none. */
  maxSpawnTokens?: number;
  /**
   * Where subagent session files go. Defaults to the ordinary sessions dir;
   * pass false to disable subagent sessions entirely.
   */
  sessionDir?: string | false;
  /** Called at each spawn with a handle to kill that one task. */
  onSpawn?: (task: {
    taskId: string;
    agentId: string;
    description: string;
    abort: () => void;
  }) => void;
}

const SUBAGENT_SUFFIX = `

You are running as a subagent spawned for one task. The text of your final
message is returned verbatim to the agent that spawned you — it is the only
thing that agent sees of your work, so make it a complete, self-contained
report. Don't reference files or findings without saying what they are.`;

const STRUCTURED_SUFFIX = `

This task requires a structured result. When your work is complete, call the
structured_output tool exactly once — its input is the result returned to the
spawner. Plain text is not returned; only the structured_output call is.`;

export interface TaskInput {
  description: string;
  prompt: string;
  schema?: Anthropic.Tool["input_schema"];
  model?: string;
}

/** Mutable budget shared by every task tool in one spawn tree. */
interface SpawnBudget {
  spawns: number;
  tokens: number;
}

/**
 * The harness invoking itself: a subagent is a fresh Agent with its own
 * context window, run to completion inside a tool call. Use it to keep large
 * exploration out of the parent's context or to hand off self-contained work.
 * Fan-out is bounded by shared depth/spawn/token budgets, and every subagent's
 * activity streams into the parent's event stream as subagent_events.
 */
export function createTaskTool(options: TaskToolOptions = {}): Tool<TaskInput> {
  return taskToolAtDepth(options, { spawns: 0, tokens: 0 }, 1);
}

/** The tool that spawns agents at `depth` (root's children are depth 1). */
function taskToolAtDepth(
  options: TaskToolOptions,
  budget: SpawnBudget,
  depth: number,
): Tool<TaskInput> {
  const maxDepth = options.maxDepth ?? 2;
  const maxSpawns = options.maxSpawns ?? 32;
  const canSpawnDeeper = depth < maxDepth;

  return {
    name: "task",
    description:
      "Spawn a subagent with a fresh, empty context to handle a self-contained task, and get back " +
      "its result. Use this to keep your own context clean: exploring a large codebase, " +
      "reading many files to answer one question, or a well-scoped independent subtask. " +
      "Multiple task calls in one batch run concurrently — decompose independent work and " +
      "fan it out. Pass a schema when you need the result in a specific shape. The subagent " +
      "sees nothing of this conversation — the prompt must contain every detail it needs " +
      "(paths, constraints, what to return). " +
      (canSpawnDeeper
        ? "Subagents can spawn their own subagents, within shared depth and spawn budgets."
        : "The subagent cannot spawn further subagents."),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A 3-6 word label for the task, shown to the user.",
        },
        prompt: {
          type: "string",
          description:
            "Complete instructions for the subagent, including all context it needs and what its final report should contain.",
        },
        schema: {
          type: "object",
          description:
            "Optional JSON Schema (type: object) for the result. The subagent is forced to " +
            "return exactly this shape, and the tool result is that JSON — use it whenever " +
            "you need structured data back instead of prose.",
        },
        model: {
          type: "string",
          description: "Optional model override for this subagent, e.g. a cheaper model for grunt work.",
        },
      },
      required: ["description", "prompt"],
    },
    // Spawning is safe in itself: every tool call the subagent makes goes
    // through the permission hook individually.
    readOnly: true,
    async execute(input, ctx) {
      if (budget.spawns >= maxSpawns) {
        return {
          output: `Spawn budget exhausted (${maxSpawns} spawns for this session). Work with the results you have.`,
          isError: true,
        };
      }
      if (options.maxSpawnTokens !== undefined && budget.tokens >= options.maxSpawnTokens) {
        return {
          output: `Subagent token budget exhausted (${options.maxSpawnTokens} tokens for this session). Work with the results you have.`,
          isError: true,
        };
      }
      budget.spawns++;

      const model = input.model ?? options.model ?? DEFAULT_MODEL;
      const cwd = options.cwd ?? ctx.cwd;
      const taskId = ctx.toolUseId ?? `task_${Math.random().toString(36).slice(2, 10)}`;

      const session =
        options.sessionDir === false
          ? undefined
          : Session.create({
              cwd,
              model,
              dir: options.sessionDir,
              parent: ctx.sessionId ? { sessionId: ctx.sessionId, taskId } : undefined,
              description: input.description,
            });
      const agentId = session?.meta.id ?? `agent_${Math.random().toString(36).slice(2, 10)}`;
      const ref: TaskRef = { taskId, agentId, description: input.description };

      // Kill handle: the mount can abort this one task without touching the
      // run; the parent's interrupt still cascades through the joined signal.
      const own = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, own.signal]) : own.signal;
      options.onSpawn?.({ taskId, agentId, description: input.description, abort: () => own.abort() });

      // Structured output: the schema the spawner asked for *is* the tool's
      // input schema, so validation rides on the API's server-side enforcement.
      let captured: string | null = null;
      const tools: Tool[] = options.tools
        ? [...options.tools]
        : [
            bashTool,
            readTool,
            writeTool,
            editTool,
            ...(canSpawnDeeper ? [taskToolAtDepth(options, budget, depth + 1)] : []),
          ];
      if (input.schema) {
        tools.push({
          name: "structured_output",
          description:
            "Record the structured result of this task. Call exactly once, when your work is " +
            "complete — the input of this call is the result returned to the spawner.",
          inputSchema: input.schema,
          readOnly: true,
          async execute(result) {
            captured = JSON.stringify(result);
            return { output: "Result recorded. End your turn." };
          },
        });
      }

      const agent = new Agent({
        client: options.client,
        model,
        cwd,
        // Subagents share the parent's memory unless the factory overrides it.
        memoryDir: options.memoryDir ?? ctx.memoryDir,
        maxTokens: options.maxTokens,
        ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
        ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
        tools,
        canUseTool: options.canUseTool,
        session,
        systemPrompt:
          (options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) +
          SUBAGENT_SUFFIX +
          (input.schema ? STRUCTURED_SUFFIX : ""),
      });

      for await (const event of agent.run(input.prompt, { signal })) {
        if (event.type === "response_end") {
          budget.tokens += usageSum(event.usage);
        }
        // Flatten, don't nest: a descendant's already-wrapped event gets this
        // spawn's ref prepended; the child's own events wrap once.
        if (event.type === "subagent_event") {
          ctx.emit?.({ type: "subagent_event", path: [ref, ...event.path], event: event.event });
        } else {
          ctx.emit?.({ type: "subagent_event", path: [ref], event });
        }
      }

      // First line of every result is machine-readable, so the spawn edge is
      // walkable from the parent transcript without an index.
      const link = session ? `[session: ${session.meta.id}]\n` : "";
      if (signal.aborted) {
        return { output: `${link}Task interrupted before completion.`, isError: true };
      }
      if (input.schema) {
        return captured !== null
          ? { output: link + captured }
          : {
              output: `${link}The subagent finished without calling structured_output; no structured result was recorded.`,
              isError: true,
            };
      }
      const report = finalAssistantText(agent.messages);
      return report.length > 0
        ? { output: link + report }
        : { output: `${link}The subagent finished without a final report.`, isError: true };
    },
  };
}

function finalAssistantText(messages: Anthropic.MessageParam[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return "";
  return last.content
    .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Total tokens a response consumed, for the shared spawn budget. */
function usageSum(usage: Anthropic.Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens
  );
}
