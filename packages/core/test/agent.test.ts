import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { createTaskTool } from "../src/tools/task.ts";
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

describe("interrupt", () => {
  test("mid-batch abort synthesizes results and keeps history valid", async () => {
    const controller = new AbortController();
    const abortingTool: Tool<{ text: string }> = {
      ...echoTool,
      async execute(input) {
        controller.abort(); // user hits ctrl-c while the first tool runs
        return { output: `echo: ${input.text}` };
      },
    };
    // Only one scripted message: if the loop tried a second API call after
    // the abort, the fake client would throw. maxConcurrentTools: 1 keeps the
    // second call unstarted at abort time, which is what this test exercises.
    const client = fakeClient([
      message(
        [
          { type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "echo", input: { text: "a" } },
          { type: "tool_use", caller: { type: "direct" }, id: "tu_2", name: "echo", input: { text: "b" } },
        ],
        "tool_use",
      ),
    ]);
    const agent = new Agent({
      client,
      tools: [abortingTool],
      cwd: tmpdir(),
      maxConcurrentTools: 1,
    });
    const events = await collect(agent.run("go", { signal: controller.signal }));

    // Second tool never started; run ended as interrupted.
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "interrupted" });

    // Both tool_use blocks still got tool_results, so the next turn is valid.
    const resultsMsg = agent.messages.at(-1)!;
    const blocks = resultsMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["tu_1", "tu_2"]);
    expect(blocks[1]!.is_error).toBe(true);
    expect(blocks[1]!.content).toContain("Interrupted");
  });
});

describe("parallel tool execution", () => {
  test("calls in one batch run concurrently; results stay in tool_use order", async () => {
    const completed: string[] = [];
    const timed: Tool<{ id: string; delay: number }> = {
      name: "timed",
      description: "sleeps then returns",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async execute(input) {
        await new Promise((r) => setTimeout(r, input.delay));
        completed.push(input.id);
        return { output: input.id };
      },
    };
    const client = fakeClient([
      message(
        [
          { type: "tool_use", caller: { type: "direct" }, id: "tu_a", name: "timed", input: { id: "slow", delay: 50 } },
          { type: "tool_use", caller: { type: "direct" }, id: "tu_b", name: "timed", input: { id: "fast", delay: 0 } },
        ],
        "tool_use",
      ),
      message([{ type: "text", text: "done", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({ client, tools: [timed], cwd: tmpdir() });
    await collect(agent.run("go"));

    // The fast call finished first — proof they overlapped.
    expect(completed).toEqual(["fast", "slow"]);
    // But the results message preserves tool_use order.
    const resultsMsg = agent.messages[2]!;
    const blocks = resultsMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["tu_a", "tu_b"]);
    expect(blocks.map((b) => b.content)).toEqual(["slow", "fast"]);
  });

  test("events a tool emits via ctx.emit surface in the run's stream", async () => {
    const emitting: Tool = {
      name: "emitting",
      description: "emits a progress event",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async execute(_input, ctx) {
        ctx.emit?.({ type: "text", text: "progress!" });
        return { output: "ok" };
      },
    };
    const client = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "emitting", input: {} }],
        "tool_use",
      ),
      message([{ type: "text", text: "done", citations: null }], "end_turn"),
    ]);
    const agent = new Agent({ client, tools: [emitting], cwd: tmpdir() });
    const events = await collect(agent.run("go"));
    const types = events.map((e) => e.type);
    // The emitted event lands between tool_start and tool_result.
    expect(types.indexOf("text")).toBeGreaterThan(types.indexOf("tool_start"));
    expect(types.indexOf("text")).toBeLessThan(types.indexOf("tool_result"));
  });
});

describe("task tool (subagents)", () => {
  test("runs a subagent and returns its final text", async () => {
    const subClient = fakeClient([
      message([{ type: "text", text: "subagent report: 42 files found", citations: null }], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, sessionDir: false });
    const result = await task.execute(
      { description: "count files", prompt: "count the files" },
      { cwd: tmpdir() },
    );
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("subagent report: 42 files found");
  });

  test("subagent activity streams into the parent as subagent_events", async () => {
    const subClient = fakeClient([
      message([{ type: "text", text: "the answer is blue", citations: null }], "end_turn"),
    ]);
    const parentClient = fakeClient([
      message(
        [{
          type: "tool_use", caller: { type: "direct" }, id: "tu_task", name: "task",
          input: { description: "find the answer", prompt: "what color?" },
        }],
        "tool_use",
      ),
      message([{ type: "text", text: "done", citations: null }], "end_turn"),
    ]);
    const parent = new Agent({
      client: parentClient,
      tools: [createTaskTool({ client: subClient, sessionDir: false })],
      cwd: tmpdir(),
    });
    const events = await collect(parent.run("go"));

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && toolResult.type === "tool_result" ? toolResult.result.output : "").toBe(
      "the answer is blue",
    );

    const wrapped = events.filter((e) => e.type === "subagent_event");
    expect(wrapped.length).toBeGreaterThan(0);
    for (const w of wrapped) {
      if (w.type !== "subagent_event") continue;
      expect(w.path).toHaveLength(1);
      expect(w.path[0]!.taskId).toBe("tu_task");
      expect(w.path[0]!.description).toBe("find the answer");
      // Flattening invariant: the wrapped event is never itself a wrapper.
      expect(w.event.type).not.toBe("subagent_event");
    }
    const wrappedTypes = wrapped.map((w) => (w.type === "subagent_event" ? w.event.type : ""));
    expect(wrappedTypes).toContain("text");
    expect(wrappedTypes).toContain("done");
  });

  test("grandchild events arrive flat with a two-hop path", async () => {
    // One shared script serves child then grandchild then child again —
    // execution is sequential across the spawn chain.
    const subClient = fakeClient([
      message(
        [{
          type: "tool_use", caller: { type: "direct" }, id: "tu_gc", name: "task",
          input: { description: "grandchild job", prompt: "dig deeper" },
        }],
        "tool_use",
      ),
      message([{ type: "text", text: "gc-report", citations: null }], "end_turn"),
      message([{ type: "text", text: "child-report", citations: null }], "end_turn"),
    ]);
    const emitted: AgentEvent[] = [];
    const task = createTaskTool({ client: subClient, sessionDir: false });
    const result = await task.execute(
      { description: "child job", prompt: "delegate" },
      { cwd: tmpdir(), toolUseId: "tu_child", emit: (e) => emitted.push(e) },
    );
    expect(result.output).toBe("child-report");

    const deep = emitted.filter(
      (e) => e.type === "subagent_event" && e.path.length === 2,
    );
    expect(deep.length).toBeGreaterThan(0);
    const gcText = deep.find(
      (e) => e.type === "subagent_event" && e.event.type === "text",
    );
    expect(gcText && gcText.type === "subagent_event" ? gcText.path[0]!.taskId : "").toBe("tu_child");
    expect(gcText && gcText.type === "subagent_event" ? gcText.path[1]!.taskId : "").toBe("tu_gc");
  });

  test("maxDepth 1 restores the no-recursion toolset", () => {
    expect(createTaskTool({ maxDepth: 1 }).description).toContain("cannot spawn further subagents");
    expect(createTaskTool({}).description).toContain("can spawn their own subagents");
  });

  test("empty subagent report is surfaced as an error", async () => {
    const subClient = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_x", name: "missing", input: {} }],
        "tool_use",
      ),
      message([], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, sessionDir: false });
    const result = await task.execute(
      { description: "x", prompt: "y" },
      { cwd: tmpdir() },
    );
    expect(result.isError).toBe(true);
  });
});

describe("task tool: structured output", () => {
  test("schema forces a structured_output call and returns its JSON", async () => {
    const subClient = fakeClient([
      message(
        [{
          type: "tool_use", caller: { type: "direct" }, id: "tu_so", name: "structured_output",
          input: { answer: 42 },
        }],
        "tool_use",
      ),
      message([{ type: "text", text: "prose that should be ignored", citations: null }], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, sessionDir: false });
    const result = await task.execute(
      {
        description: "compute",
        prompt: "compute the answer",
        schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
      },
      { cwd: tmpdir() },
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ answer: 42 });
  });

  test("finishing without structured_output is an error the spawner can react to", async () => {
    const subClient = fakeClient([
      message([{ type: "text", text: "here is prose instead", citations: null }], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, sessionDir: false });
    const result = await task.execute(
      {
        description: "compute",
        prompt: "compute",
        schema: { type: "object", properties: { answer: { type: "number" } } },
      },
      { cwd: tmpdir() },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("structured_output");
  });
});

describe("task tool: budgets", () => {
  test("spawn budget exhausts and fails fast", async () => {
    const subClient = fakeClient([
      message([{ type: "text", text: "first report", citations: null }], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, maxSpawns: 1, sessionDir: false });
    const first = await task.execute({ description: "a", prompt: "p" }, { cwd: tmpdir() });
    expect(first.isError).toBeUndefined();
    const second = await task.execute({ description: "b", prompt: "p" }, { cwd: tmpdir() });
    expect(second.isError).toBe(true);
    expect(second.output).toContain("budget");
  });

  test("token budget counts subagent usage and fails fast once exceeded", async () => {
    const subClient = fakeClient([
      message([{ type: "text", text: "report", citations: null }], "end_turn"),
    ]);
    // The fake usage is 15 tokens per response; a 10-token cap exhausts after one spawn.
    const task = createTaskTool({ client: subClient, maxSpawnTokens: 10, sessionDir: false });
    const first = await task.execute({ description: "a", prompt: "p" }, { cwd: tmpdir() });
    expect(first.isError).toBeUndefined();
    const second = await task.execute({ description: "b", prompt: "p" }, { cwd: tmpdir() });
    expect(second.isError).toBe(true);
    expect(second.output).toContain("token budget");
  });
});

describe("task tool: sessions", () => {
  test("each subagent writes a session file carrying the spawn edge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "carbon-subsessions-"));
    const subClient = fakeClient([
      message([{ type: "text", text: "report", citations: null }], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, sessionDir: dir });
    const result = await task.execute(
      { description: "linked job", prompt: "p" },
      { cwd: tmpdir(), sessionId: "parent-session-1", toolUseId: "tu_9" },
    );

    // The result's first line is the machine-readable link to the child session.
    expect(result.output.startsWith("[session: ")).toBe(true);
    expect(result.output).toContain("report");

    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const metaLine = JSON.parse(
      readFileSync(join(dir, files[0]!), "utf8").split("\n")[0]!,
    );
    expect(metaLine.parent).toEqual({ sessionId: "parent-session-1", taskId: "tu_9" });
    expect(metaLine.description).toBe("linked job");
    expect(result.output.split("\n")[0]).toBe(`[session: ${metaLine.id}]`);
  });
});

describe("task tool: kill handle", () => {
  test("onSpawn's abort kills one task and returns an interrupted result", async () => {
    const subClient = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "bash", input: { command: "sleep 999" } }],
        "tool_use",
      ),
    ]);
    const task = createTaskTool({
      client: subClient,
      sessionDir: false,
      onSpawn: (t) => t.abort(), // mount kills the task the moment it spawns
    });
    const result = await task.execute(
      { description: "doomed", prompt: "p" },
      { cwd: tmpdir() },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("interrupted");
  });
});

describe("memoryDir plumbing", () => {
  test("tools receive memoryDir via ToolContext; subagents inherit it", async () => {
    const seen: (string | undefined)[] = [];
    const probe: Tool = {
      name: "probe",
      description: "records ctx.memoryDir",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async execute(_input, ctx) {
        seen.push(ctx.memoryDir);
        return { output: "ok" };
      },
    };
    const client = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_1", name: "probe", input: {} }],
        "tool_use",
      ),
      message([{ type: "text", text: "done", citations: null }], "end_turn"),
    ]);
    const memDir = mkdtempSync(join(tmpdir(), "carbon-mem-"));
    const agent = new Agent({ client, tools: [probe], cwd: tmpdir(), memoryDir: memDir });
    await collect(agent.run("go"));
    expect(seen).toEqual([memDir]);

    // Subagent inherits the parent's memoryDir through ctx.
    const subClient = fakeClient([
      message(
        [{ type: "tool_use", caller: { type: "direct" }, id: "tu_s", name: "probe", input: {} }],
        "tool_use",
      ),
      message([{ type: "text", text: "sub done", citations: null }], "end_turn"),
    ]);
    const task = createTaskTool({ client: subClient, tools: [probe], sessionDir: false });
    const result = await task.execute(
      { description: "probe memory", prompt: "probe" },
      { cwd: tmpdir(), memoryDir: memDir },
    );
    expect(result.output).toBe("sub done");
    expect(seen).toEqual([memDir, memDir]);
  });
});

describe("provider config (thinking / cache opt-out)", () => {
  // Capture the params passed to messages.stream so we can assert on them.
  function capturingClient(captured: any[]): Anthropic {
    return {
      messages: {
        stream(params: any) {
          captured.push(params);
          return {
            async *[Symbol.asyncIterator]() {},
            async finalMessage() {
              return message([{ type: "text", text: "ok", citations: null }], "end_turn");
            },
          };
        },
      },
    } as unknown as Anthropic;
  }

  test("default sends adaptive thinking and cache_control", async () => {
    const captured: any[] = [];
    const agent = new Agent({ client: capturingClient(captured), cwd: tmpdir() });
    await collect(agent.run("hi"));
    expect(captured[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(captured[0].cache_control).toEqual({ type: "ephemeral" });
    expect(captured[0].system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("thinking:null omits the param entirely (Kimi code models)", async () => {
    const captured: any[] = [];
    const agent = new Agent({ client: capturingClient(captured), cwd: tmpdir(), thinking: null });
    await collect(agent.run("hi"));
    expect("thinking" in captured[0]).toBe(false);
  });

  test("cacheControl:false omits all cache_control markers", async () => {
    const captured: any[] = [];
    const agent = new Agent({
      client: capturingClient(captured),
      cwd: tmpdir(),
      cacheControl: false,
    });
    await collect(agent.run("hi"));
    expect("cache_control" in captured[0]).toBe(false);
    expect("cache_control" in captured[0].system[0]).toBe(false);
  });
});
