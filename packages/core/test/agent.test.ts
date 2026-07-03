import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, Tool } from "../src/types.ts";

/**
 * A scripted stand-in for the Anthropic client: each call to messages.stream
 * pops the next scripted message, replays its text as deltas, and returns it
 * from finalMessage(). Lets us exercise the full loop without the API.
 */
function fakeClient(script: Anthropic.Message[]): Anthropic {
  let call = 0;
  return {
    messages: {
      stream() {
        const message = script[call++];
        if (!message) throw new Error("fake client ran out of scripted messages");
        const deltas = message.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => ({
            type: "content_block_delta",
            delta: { type: "text_delta", text: b.text },
          }));
        return {
          async *[Symbol.asyncIterator]() {
            yield* deltas as any;
          },
          async finalMessage() {
            return message;
          },
        };
      },
    },
  } as unknown as Anthropic;
}

function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message["stop_reason"],
): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
  };
}

const echoTool: Tool<{ text: string }> = {
  name: "echo",
  description: "echoes",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(input) {
    return { output: `echo: ${input.text}` };
  },
};

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
}

describe("agent loop", () => {
  test("runs a tool round-trip and finishes on end_turn", async () => {
    const client = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "echo", input: { text: "hi" } }],
        "tool_use",
      ),
      message([{ type: "text", text: "done", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({ client, tools: [echoTool], cwd: tmpdir() });
    const events = await collect(agent.run("go"));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response_end",
      "tool_start",
      "tool_result",
      "text",
      "response_end",
      "done",
    ]);

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.result.output : "").toBe(
      "echo: hi",
    );

    // History: user, assistant(tool_use), user(tool_results), assistant(text)
    expect(agent.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const resultsMsg = agent.messages[2]!;
    expect(Array.isArray(resultsMsg.content)).toBe(true);
    const block = (resultsMsg.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("tu_1");
  });

  test("denied tools return an error result to the model", async () => {
    const client = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "echo", input: { text: "hi" } }],
        "tool_use",
      ),
      message([{ type: "text", text: "ok", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({
      client,
      tools: [echoTool],
      cwd: tmpdir(),
      canUseTool: async () => ({ behavior: "deny", message: "nope" }),
    });
    const events = await collect(agent.run("go"));
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.result : null).toEqual({
      output: "nope",
      isError: true,
    });
  });

  test("read-only tools skip the permission hook", async () => {
    let asked = false;
    const readOnlyEcho: Tool = { ...echoTool, readOnly: true };
    const client = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "echo", input: { text: "hi" } }],
        "tool_use",
      ),
      message([{ type: "text", text: "ok", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({
      client,
      tools: [readOnlyEcho],
      cwd: tmpdir(),
      canUseTool: async () => {
        asked = true;
        return { behavior: "deny" };
      },
    });
    await collect(agent.run("go"));
    expect(asked).toBe(false);
  });

  test("unknown tool names surface as error results", async () => {
    const client = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "missing", input: {} }],
        "tool_use",
      ),
      message([{ type: "text", text: "ok", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({ client, tools: [], cwd: tmpdir() });
    const events = await collect(agent.run("go"));
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(
      toolResult && toolResult.type === "tool_result" ? toolResult.result.isError : false,
    ).toBe(true);
  });

  test("streams text deltas before the final message lands", async () => {
    const client = fakeClient([
      message([{ type: "text", text: "hello world", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({ client, cwd: mkdtempSync(join(tmpdir(), "carbon-agent-")) });
    const events = await collect(agent.run("hi"));
    expect(events[0]).toEqual({ type: "text", text: "hello world" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });
});
