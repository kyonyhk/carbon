import type Anthropic from "@anthropic-ai/sdk";

/** Context passed to every tool execution. */
export interface ToolContext {
  /** Working directory the agent operates in. */
  cwd: string;
  /** Aborted when the user interrupts the run; long-running tools should honor it. */
  signal?: AbortSignal;
  /** The agent's memory directory, if one is mounted — lets consumers build memory-aware tools without re-plumbing paths. */
  memoryDir?: string;
  /**
   * Push an event into the running agent's own event stream. The loop drains
   * emitted events while tool executions are in flight, so a tool can stream
   * progress (e.g. subagent activity) instead of being silent until it returns.
   */
  emit?: (event: AgentEvent) => void;
  /** The tool_use id of this call — ties emitted events back to the call. */
  toolUseId?: string;
  /** The session id of the agent making this call, if it has a session. */
  sessionId?: string;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

/**
 * A tool is plain data plus an execute function. The agent converts
 * `name`/`description`/`inputSchema` into the API tool definition and calls
 * `execute` when the model requests it.
 */
export interface Tool<Input = any> {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool["input_schema"];
  /** Read-only tools are safe to run without user approval. */
  readOnly?: boolean;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message?: string };

/**
 * Permission hook. The mount (CLI, server, ...) decides how to ask —
 * the core only knows a tool call must be approved before it runs.
 */
export type CanUseTool = (
  tool: Tool,
  input: unknown,
) => Promise<PermissionDecision>;

export type StopReason = Anthropic.Message["stop_reason"] | "interrupted";

/** One edge in a spawn chain: which task call created which agent. */
export interface TaskRef {
  /** The task tool_use id — ties to the parent's tool_start/tool_result. */
  taskId: string;
  /** The spawned agent's session id (or a generated id if sessions are off). */
  agentId: string;
  /** The spawner's 3-6 word label for the task. */
  description: string;
}

/**
 * Everything the agent does is surfaced as a stream of events. Mounts render
 * these however they like; the core never writes to stdout.
 *
 * Subagent activity arrives flat, never nested: a `subagent_event` wraps a raw
 * leaf event with the full spawn chain in `path` (root's child first), and
 * `event` is itself never a `subagent_event`. Mounts reconstruct the live tree
 * from `path` alone; mounts that ignore the type behave as before.
 */
export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: ToolResult }
  | { type: "response_end"; stopReason: StopReason; usage: Anthropic.Usage }
  | { type: "compaction_start" }
  | { type: "compaction_end"; summary: string; foldedMessages: number }
  | { type: "subagent_event"; path: TaskRef[]; event: AgentEvent }
  | { type: "done"; stopReason: StopReason };
