import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { Session } from "../src/session.ts";
import type { AgentEvent, Tool } from "../src/types.ts";

/**
 * Client whose .stream() replays scripted messages and whose .create() (used
 * by the summarizer) returns a fixed summary. Lets us drive compaction
 * deterministically without the API.
 */
function fakeClient(script: Anthropic.Message[], summary = "SUMMARY"): Anthropic {
  let call = 0;
  return {
    messages: {
      stream() {
        const msg = script[call++];
        if (!msg) throw new Error("ran out of scripted messages");
        const deltas = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => ({ type: "content_block_delta", delta: { type: "text_delta", text: b.text } }));
        return {
          async *[Symbol.asyncIterator]() {
            yield* deltas as any;
          },
          async finalMessage() {
            return msg;
          },
        };
      },
      async create() {
        return { content: [{ type: "text", text: summary }] };
      },
    },
  } as unknown as Anthropic;
}

function msg(
  content: Anthropic.ContentBlock[],
  stopReason: string,
  usage?: Partial<Anthropic.Usage>,
): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content,
    stop_reason: stopReason as Anthropic.Message["stop_reason"],
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: { input_tokens: 10, output_tokens: 5, ...usage } as Anthropic.Usage,
  };
}

const text = (t: string): Anthropic.TextBlock => ({ type: "text", text: t, citations: null });

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("compact()", () => {
  test("folds history before the last real user turn, keeps it verbatim", async () => {
    const client = fakeClient([], "the summary");
    const agent = new Agent({ client, cwd: tmpdir() });
    agent.messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [text("first answer")] },
      { role: "user", content: "second question" },
      { role: "assistant", content: [text("second answer")] },
    ];
    const result = await agent.compact();
    expect(result).not.toBeNull();
    expect(result!.foldedMessages).toBe(2); // first Q + first A folded
    expect(agent.messages).toHaveLength(3); // summary + last user turn + its answer
    expect(agent.messages[0]!.content).toContain("the summary");
    expect(agent.messages[0]!.content).toContain("<compaction-summary>");
    expect(agent.messages[1]!.content).toBe("second question");
  });

  test("does not sever tool_use/tool_result pairing", async () => {
    const client = fakeClient([], "s");
    const agent = new Agent({ client, cwd: tmpdir() });
    // A real user turn, then a tool cycle. The cut must land on the user turn,
    // never between the tool_use and its tool_result.
    agent.messages = [
      { role: "user", content: "old turn" },
      { role: "assistant", content: [text("old")] },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "tool_use", caller: { type: "direct" }, id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    await agent.compact();
    // Tail starts at "do the thing" so the tool cycle stays intact.
    expect(agent.messages[1]!.content).toBe("do the thing");
    const last = agent.messages.at(-1)!;
    expect(Array.isArray(last.content) && last.content[0]!.type === "tool_result").toBe(true);
  });

  test("returns null when the only real turn is at the start (nothing to fold)", async () => {
    const client = fakeClient([], "s");
    const agent = new Agent({ client, cwd: tmpdir() });
    agent.messages = [
      { role: "user", content: "single big turn" },
      { role: "assistant", content: [text("answer")] },
    ];
    expect(await agent.compact()).toBeNull();
    expect(agent.messages).toHaveLength(2); // untouched
  });
});

describe("automatic compaction", () => {
  test("triggers when the previous response crossed the threshold", async () => {
    // First response reports huge usage → next iteration should compact.
    const client = fakeClient(
      [
        msg([{ type: "tool_use", caller: { type: "direct" }, id: "t1", name: "noop", input: {} }], "tool_use", {
          input_tokens: 200_000,
        }),
        msg([text("done")], "end_turn"),
      ],
      "compacted summary",
    );
    const noop: Tool = {
      name: "noop",
      description: "noop",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async execute() {
        return { output: "ok" };
      },
    };
    const agent = new Agent({ client, tools: [noop], cwd: tmpdir(), compactionThreshold: 150_000 });
    // Prior completed turn so there is something safe to fold once the tool
    // cycle from this turn pushes usage over the threshold.
    agent.messages = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: [text("earlier answer")] },
    ];
    const events = await collect(agent.run("go"));
    const types = events.map((e) => e.type);
    expect(types).toContain("compaction_start");
    expect(types).toContain("compaction_end");
  });

  test("autoCompact:false suppresses automatic compaction", async () => {
    const client = fakeClient(
      [
        msg([{ type: "tool_use", caller: { type: "direct" }, id: "t1", name: "noop", input: {} }], "tool_use", {
          input_tokens: 200_000,
        }),
        msg([text("done")], "end_turn"),
      ],
    );
    const noop: Tool = {
      name: "noop",
      description: "noop",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async execute() {
        return { output: "ok" };
      },
    };
    const agent = new Agent({ client, tools: [noop], cwd: tmpdir(), autoCompact: false });
    const events = await collect(agent.run("go"));
    expect(events.map((e) => e.type)).not.toContain("compaction_start");
  });
});

describe("session round-trip across compaction", () => {
  test("load reconstructs the post-compaction message list", () => {
    const session = Session.create({ cwd: tmpdir(), model: "claude-opus-4-8" });
    session.append({ role: "user", content: "q1" });
    session.append({ role: "assistant", content: [text("a1")] });
    // Compaction folds q1/a1 into a summary, keeps a fresh tail.
    session.appendCompaction(
      [
        { role: "user", content: "<compaction-summary>\nSUM\n</compaction-summary>" },
        { role: "user", content: "q2" },
      ],
      "SUM",
    );
    session.append({ role: "assistant", content: [text("a2")] });

    const { messages } = Session.load(session.filePath);
    // summary + q2 + a2 — the pre-compaction q1/a1 lines are superseded.
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toContain("SUM");
    expect(messages[1]!.content).toBe("q2");
    expect(messages[2]!.content).toEqual([text("a2")]);
  });
});
