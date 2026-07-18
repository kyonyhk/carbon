# M6 — orchestration

> **Status: implemented.** This is the design document; the condensed
> milestone record lives in [SPEC.md](./SPEC.md). Deviations from the draft:
> none of substance — `TaskInput.model` was added alongside `schema` (cheap,
> and the orchestrator is the right party to choose worker models), and
> subagent sessions gained a `sessionDir` option (`false` disables, for
> consumers that don't want files).

**Thesis:** the model is the orchestrator. Existing frameworks make the
developer define the orchestration (graphs, crews, handoffs) and the model
fill in the nodes. Current models are trained the other way around: given the
right primitives, the model decides at runtime whether to fan out, how many
agents to spawn, and what each one does. M6 supplies those primitives — and
nothing else. What to orchestrate, when, and with which patterns stays a
consumer decision (the product mount's, graphite's), per the mechanism/policy
rule.

M2 closed with two explicit revisits: subagent session files and parallel
`task` calls. M6 is those two plus the minimum around them to make
model-driven fan-out observable, bounded, and replayable.

## What changes, at a glance

1. Subagent events flow through the parent's own event stream (no more
   `onEvent` callback) — one new event type, existing events untouched.
2. Tool calls in one assistant batch execute concurrently, capped.
3. `task` gains optional `schema` input — schema-forced structured output.
4. Every subagent writes its own session file, linked from the parent's.
5. The hard one-level delegation rule becomes depth + spawn + token budgets.
6. Mounts get a kill handle per spawned task.

## 1. Event tree

The core problem: `Tool.execute` returns a promise, so a subagent running
inside a tool call has no way to yield into the parent's generator. M2 worked
around this with the `onEvent` callback — a side channel that bypasses the
"everything is one event stream" principle and doesn't compose past one level.

**Mechanism:** `ToolContext` gains `emit?: (event: AgentEvent) => void`. The
agent loop drains emitted events into its own stream while tool executions are
in flight (an internal async channel: tools push, the loop interleaves yields
with awaiting the batch). Any tool can now stream progress; the task tool is
just the first user.

**Wrapping rule — flat, not nested:** subagent events arrive in the root
stream as

```ts
| { type: "subagent_event";
    path: TaskRef[];            // spawn chain, root's child first
    event: AgentEvent }         // the raw leaf event, never itself a subagent_event

interface TaskRef {
  taskId: string;               // the task tool_use id — ties to tool_start
  agentId: string;              // the spawned agent's session id
  description: string;          // the model's 3-6 word label
}
```

A depth-2 agent's `text` event is emitted by its own task tool wrapped with
`path: [child]`; the intermediate agent's task tool re-emits it prepending its
own ref: `path: [child, grandchild]`. Mounts reconstruct the live tree from
`path` alone; a mount that ignores `subagent_event` behaves exactly like an M2
mount. `TaskToolOptions.onEvent` is removed (pre-1.0, no deprecation dance).

Lifecycle needs no new events: the parent's `tool_start`/`tool_result` for the
task call bracket the spawn, and the child's wrapped `done` marks completion.

## 2. Parallel tool execution

(Removes the "parallel tool execution" non-goal.)

All tool calls in one assistant batch start concurrently, capped by
`AgentOptions.maxConcurrentTools` (default 8; excess queue). Results are
collected and appended in tool_use order, so transcripts stay deterministic.
Permission checks happen at each execution's start as today; a mount that
can't prompt concurrently serializes inside its own `canUseTool` (the server
mount already awaits async decisions — no core change needed). Interrupt
aborts the whole batch via the existing signal; unstarted calls get synthetic
interrupted results, same as M1.

This is general (parallel greps benefit too), but the motivating case is a
batch of `task` calls: fan-out is now genuinely concurrent.

## 3. Structured output

Ten subagents returning prose forces the parent to parse ten essays. The fix
is schema-forced results, and — mechanism, not policy — the **spawner model**
supplies the schema, because the orchestrator knows what shape it needs:

```ts
interface TaskInput {
  description: string;
  prompt: string;
  schema?: object;              // JSON Schema for the result (optional)
  model?: string;               // override, e.g. a cheaper model for grunt work
}
```

When `schema` is present, the subagent gets one extra tool,
`structured_output`, whose `input_schema` *is* the given schema, plus a system
prompt suffix: call it exactly once with your result as its input; that ends
the task. The tool captures its input and the task returns the captured JSON
as the tool result (`finalAssistantText` remains the no-schema path).
Validation is free — the API enforces tool input schemas server-side, and the
model retries on mismatch. If the run ends without a `structured_output` call,
the task result is an error naming what's missing, so the orchestrator can
respawn rather than guess.

## 4. Subagent sessions

Every spawned agent creates a real `Session` in the ordinary sessions dir.
`SessionMeta` gains optional fields (backward compatible — old files still
load):

```ts
interface SessionMeta {
  id: string; createdAt: string; cwd: string; model: string;
  parent?: { sessionId: string; taskId: string };   // spawn edge
  description?: string;                              // the task label
}
```

The parent's transcript already records the task tool_use/tool_result pair;
the tool result is prefixed with a machine-readable first line
(`[session: <child-session-id>]`) so the edge is walkable from either side
with no extra index. What this buys, in order of importance: post-run
debugging of any subagent, graphite reflecting over whole orchestrations,
and later resume/continue (see non-goals).

## 5. Budgets replace the one-level rule

M2's "delegation stays one level deep" was policy hiding in mechanism. It
becomes three knobs on `createTaskTool`:

```ts
interface TaskToolOptions {
  // ...existing options...
  maxDepth?: number;        // default 2 (root → orchestrator → workers)
  maxSpawns?: number;       // total spawns for the tool's lifetime, default 32
  maxSpawnTokens?: number;  // aggregate subagent usage cap, default none
}
```

Budget lifetime is the factory call's, not one run's — a long-lived mount
that keeps one agent across turns shares the budget across the session
(there is no run boundary visible to a tool). Mounts that want per-turn
budgets create the task tool per turn.

One shared mutable budget object is created per factory call and threaded to
every descendant task tool. Subagents at depth < maxDepth receive a task tool
themselves; at maxDepth they get the four core tools, exactly as M2. A spawn
that would exceed any budget fails fast with an error result naming the
exhausted budget — the orchestrator sees it and adapts instead of hanging.
Token accounting: each subagent `response_end`'s usage sum (the same
`promptTokens` arithmetic compaction uses) increments the budget.

Defaults are deliberately conservative: unbounded recursion mostly produces
expensive garbage, and depth 2 covers nearly every real pattern.

## 6. Kill handle

Interrupting the root already cascades (the signal flows into every spawn).
Killing *one* subagent without nuking the run is a mount concern, but the
mount needs a handle:

```ts
// TaskToolOptions
onSpawn?: (task: { taskId: string; agentId: string; description: string;
                   abort: () => void }) => void;
```

The task tool wraps the parent signal and its own controller
(`AbortSignal.any`), and hands `abort` to the mount at spawn time. An aborted
task returns the standard interrupted error result; the orchestrator decides
whether to respawn.

## Non-goals (for now)

- **Background spawns.** A task call blocks its slot until done. Letting the
  parent keep reasoning while spawns run changes the loop's shape (injected
  results mid-turn); the event model above is designed so this can be added
  without breaking mounts, but it is not M6.
- **Deterministic orchestration scripts** (a JS harness calling `agent()` in
  loops). A whole product surface; model-driven spawning covers most of the
  value first.
- **Continuing a subagent** (spawn with a prior child session's context).
  Falls out cheaply once sessions are files — `TaskInput.resumeSession` — but
  it's additive and waits for a demonstrated need.
- **Worktree isolation, agent-to-agent messaging, journal-based resume of a
  whole orchestration.** All wait for the product mount to demand them.

## Build order & pass/fail

1. Event channel: `ToolContext.emit`, loop drains during tool execution,
   `subagent_event` type, task tool rewired, `onEvent` removed. (CLI mount
   updated to render from the stream.)
2. Parallel batches with `maxConcurrentTools`, ordered results.
3. `schema` + `model` on TaskInput; `structured_output` capture.
4. Subagent sessions + meta fields + result linking.
5. Budgets + `onSpawn`.

Each step lands independently and is useful alone. **Pass/fail, in the M5
tradition:** the CLI mount renders a live tree of a three-agent parallel
fan-out with structured results, using only the public event stream; graphite
runs unchanged against the new core; and every subagent of that fan-out is
replayable afterward from its own session file.
