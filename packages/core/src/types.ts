import type Anthropic from "@anthropic-ai/sdk";

/** Context passed to every tool execution. */
export interface ToolContext {
  /** Working directory the agent operates in. */
  cwd: string;
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

export type StopReason = Anthropic.Message["stop_reason"];

/**
 * Everything the agent does is surfaced as a stream of events. Mounts render
 * these however they like; the core never writes to stdout.
 */
export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: ToolResult }
  | { type: "response_end"; stopReason: StopReason; usage: Anthropic.Usage }
  | { type: "done"; stopReason: StopReason };
