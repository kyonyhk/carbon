import type Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../agent.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../prompt.ts";
import type { AgentEvent, CanUseTool, Tool } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export interface TaskToolOptions {
  client?: Anthropic;
  model?: string;
  cwd?: string;
  /**
   * Tools available to subagents. Defaults to the four core tools — and
   * deliberately not another task tool, so delegation stays one level deep.
   */
  tools?: Tool[];
  /** Permission hook for the subagent's tool calls. Pass the mount's hook. */
  canUseTool?: CanUseTool;
  systemPrompt?: string;
  maxTokens?: number;
  /** Memory directory for subagents. Defaults to the spawning agent's own. */
  memoryDir?: string;
  /** Observe subagent events, e.g. to render nested activity in a mount. */
  onEvent?: (event: AgentEvent, task: { description: string }) => void;
}

const SUBAGENT_SUFFIX = `

You are running as a subagent spawned for one task. The text of your final
message is returned verbatim to the agent that spawned you — it is the only
thing that agent sees of your work, so make it a complete, self-contained
report. Don't reference files or findings without saying what they are.`;

export interface TaskInput {
  description: string;
  prompt: string;
}

/**
 * The harness invoking itself: a subagent is a fresh Agent with its own
 * context window, run to completion inside a tool call. Use it to keep large
 * exploration out of the parent's context or to hand off self-contained work.
 */
export function createTaskTool(options: TaskToolOptions = {}): Tool<TaskInput> {
  return {
    name: "task",
    description:
      "Spawn a subagent with a fresh, empty context to handle a self-contained task, and get back " +
      "its final report. Use this to keep your own context clean: exploring a large codebase, " +
      "reading many files to answer one question, or a well-scoped independent subtask. The " +
      "subagent has the bash/read/write/edit tools but cannot spawn further subagents, and it " +
      "sees nothing of this conversation — the prompt must contain every detail it needs " +
      "(paths, constraints, what to return).",
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
      },
      required: ["description", "prompt"],
    },
    // Spawning is safe in itself: every tool call the subagent makes goes
    // through the permission hook individually.
    readOnly: true,
    async execute(input, ctx) {
      const agent = new Agent({
        client: options.client,
        model: options.model,
        cwd: options.cwd ?? ctx.cwd,
        // Subagents share the parent's memory unless the factory overrides it.
        memoryDir: options.memoryDir ?? ctx.memoryDir,
        maxTokens: options.maxTokens,
        tools: options.tools ?? [bashTool, readTool, writeTool, editTool],
        canUseTool: options.canUseTool,
        systemPrompt: (options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) + SUBAGENT_SUFFIX,
      });

      for await (const event of agent.run(input.prompt, { signal: ctx.signal })) {
        options.onEvent?.(event, { description: input.description });
      }

      if (ctx.signal?.aborted) {
        return { output: "Task interrupted before completion.", isError: true };
      }
      const report = finalAssistantText(agent.messages);
      return report.length > 0
        ? { output: report }
        : { output: "The subagent finished without a final report.", isError: true };
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
