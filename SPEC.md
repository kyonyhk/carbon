# carbon — architecture spec

carbon is a minimal agent harness: the structural spine that future agents are
built on. The thesis is that every useful agent starts as a coding agent,
because bash plus a filesystem is the universal tool — so the foundation is a
small, headless agent loop with four tools, and everything else is a layer.

## Design principles

1. **Headless core.** `@carbon/core` never touches stdin/stdout. It exposes an
   `Agent` whose `run()` yields a stream of `AgentEvent`s; a *mount* (CLI,
   Slack bot, cron job, server) consumes those events and owns all I/O,
   including permission prompts. Any future agent is a new mount, not a fork.
2. **Tools are data plus a function.** A `Tool` is `{name, description,
   inputSchema, readOnly?, execute}`. No plugin system, no registry — tools are
   plain TypeScript values passed to the Agent constructor. Extension is
   `import`, not configuration.
3. **Transcripts are files.** Sessions are append-only JSONL on disk
   (`~/.carbon/sessions/`). Cheap to write, trivial to replay, and later the raw
   material for memory and compaction.
4. **One provider, thin seam.** The core targets the Anthropic API directly
   via the official SDK and uses SDK types (`Anthropic.MessageParam`, etc.)
   as its message representation. Provider abstraction waits until there is a
   second provider.

## The loop

```
user input ─▶ messages[] ─▶ stream API response
                 ▲                │
                 │                ├─ text/thinking deltas ──▶ AgentEvent
                 │                ▼
                 │          stop_reason?
                 │            ├─ tool_use ─▶ permission hook ─▶ execute tools
                 │            │                                    │
                 └────────────┴◀── single user msg of tool_results ┘
                              ├─ pause_turn ─▶ re-send (server resumes)
                              └─ end_turn / refusal / max_tokens ─▶ done
```

API details (per current Anthropic guidance): model `claude-opus-4-8` by
default, adaptive thinking with summarized display, streaming always,
`max_tokens` 64k. Prompt caching: one breakpoint on the system block (caches
tools + system), plus top-level auto-caching for the growing conversation.
All tool results for one assistant turn are returned in a single user message.

## Layout

```
packages/
  core/          the harness — no I/O, no rendering
    src/
      agent.ts     Agent: the loop, tool execution, permission hook, compaction
      types.ts     Tool, ToolResult, AgentEvent, CanUseTool
      tools/       bash, read, write, edit, task (subagents)
      session.ts   JSONL transcript store (+ compaction records)
      memory.ts    CARBON.md + memory-directory injection
      prompt.ts    default system prompt + compaction instruction
  cli/           the first mount — readline REPL + print mode
  server/        the second mount — HTTP + SSE, proves the core/mount boundary
```

## Permissions

The core enforces *that* non-read-only tools need approval; the mount decides
*how* to ask. `canUseTool(tool, input)` returns allow/deny — the CLI implements
it as a y/n/a prompt, a server mount might implement it as a Slack message.
Tools marked `readOnly: true` skip the hook entirely.

## Milestones

- **M1 (this repo, done):** headless core, four tools, JSONL sessions,
  streaming, CLI mount with permission prompts, `--continue`, print mode.
- **M2 — subagents (done):** `createTaskTool()` — a `task` tool that runs a
  fresh `Agent` to completion inside a tool call and returns its final message
  text. The harness invoking itself. Design decisions: delegation is one level
  deep (subagents get the four core tools, no task tool); the task tool is
  `readOnly` because each subagent tool call is permission-checked
  individually; the parent's abort signal flows into the subagent; mounts
  observe subagent activity via an `onEvent` callback. Subagent turns are not
  yet written to their own session files, and parallel `task` calls in one
  batch still execute sequentially — both revisit later.
- **M3 — memory (done):** the *mechanism* for persistent context, with zero
  policy. Three pieces, all in core (`memory.ts`):
  1. **Project instructions:** `loadProjectInstructions(cwd)` collects
     `CARBON.md` files from cwd up to the repo root (`.git` marker) —
     both loaded if nested, root first and nearest last so nearer wins.
     Outside a repo only cwd's own file applies (ancestor files don't leak).
     On by default; `AgentOptions.projectInstructions: false` opts out.
  2. **Memory mount:** `AgentOptions.memoryDir` — injects the directory's
     `MEMORY.md` index into the system prompt at construction (once per
     session: the prompt must stay byte-stable for the cache prefix), plus a
     policy-free instruction that the directory is readable/writable with
     the ordinary file tools. No index yet → the section says to create one.
  3. **Tool awareness:** `ToolContext.memoryDir`; subagents inherit the
     spawning agent's memoryDir unless the task-tool factory overrides it.

  System prompt composition: base + project instructions + memory section.
  CLI exposes `--memory <dir>` (opt-in — memory-by-default is a consumer
  policy, e.g. graphite's). Explicitly out of core: what counts as
  memorable, file formats, reflection/consolidation/decay, embeddings or
  search. graphite (a self-improving agent built on carbon) is the first
  consumer and design authority for those choices.
- **M4 — compaction (done):** client-side, in core. Server-side compaction (the
  API beta) is rejected deliberately: it's provider-specific surface that
  won't exist on Anthropic-compatible endpoints, it makes transcripts
  non-self-describing, and it outsources a layer carbon exists to own.
  The summarizer is a fresh no-tools `Agent` — the harness invoking itself.
  - **Trigger:** the previous response's usage sum (`input + cache_read +
    cache_creation + output`) approximates the next prompt size — no
    `count_tokens` calls. When it crosses `AgentOptions.compactionThreshold`
    (default 150k tokens), compact at the next safe boundary: start of
    `run()`, or between loop iterations before the next API call.
    Emergency fallback: on `model_context_window_exceeded`, compact and
    retry once.
  - **Mechanics:** the summarizer is a direct `messages.create` call reusing
    the session's *exact* system prompt and tool definitions, with
    `COMPACTION_INSTRUCTION` (`prompt.ts`) appended as a final user message —
    not a separate Agent. This keeps the history a cache read (~0.1x) instead
    of a full re-read, and satisfies the API's requirement that tool
    definitions accompany histories containing tool blocks. No thinking; 8k
    output cap. Rebuild history as: one user message with the summary in
    `<compaction-summary>` tags → verbatim tail.
  - **Cut boundary rule:** the verbatim tail starts at the most recent
    *real* user turn (text content, not tool results) so tool_use/
    tool_result pairing is never severed. Keep that last complete turn —
    recency in exact form is worth its tokens.
  - **Transcript honesty:** append `{type: "compaction", summary,
    replacedThrough}` to the session JSONL; `Session.load()` reconstructs
    post-compaction state so `--continue` works across compactions. The
    file remains the full record; the line marks where the working set
    folded.
  - **Surface:** `compaction_start` / `compaction_end` AgentEvents (CLI
    renders `[compacting…]`); public `agent.compact()` for manual use
    (CLI `/compact` command).
  - **v1 limitation (accepted):** a single turn whose tool results outgrow
    the window between checks errors rather than attempting mid-turn
    surgery.
- **M5 — second mount, HTTP + SSE server (`@carbon/server`) (done):** the
  pass/fail criterion held — **built with zero changes to `@carbon/core`**
  (the three-package typecheck confirms it; the live permission round-trip
  proves it). Chosen over Slack/cron because it stresses the boundary
  hardest and everything else (web UI, chat bridges, Omaru-shaped clients)
  becomes a thin client of it later.
  - **Endpoints:** `POST /sessions {cwd, model, permissionMode}` → `{id}` ·
    `POST /sessions/:id/messages {text}` → SSE stream of that turn's
    AgentEvents · `POST /sessions/:id/permissions/:reqId {allow|deny}` ·
    `POST /sessions/:id/interrupt` · `GET /sessions` → list. Sessions are
    JSONL-backed as always, so a server restart resumes.
  - **Concurrency rule:** one `Agent` per session in a registry; a single
    Agent's `run()` is never invoked concurrently (shared `messages[]`) —
    the mount serializes per session (409 or queue). Core stays
    instance-per-agent.
  - **The boundary proof:** `canUseTool` is an async function the mount
    owns — the server implementation emits a `permission_request` SSE
    event and awaits the HTTP decision (timeout = deny). Working without
    core changes is the point.
  - **Interrupt:** per-session `AbortController`, same plumbing as Ctrl+C.
  - **Auth (non-goal beyond this):** single bearer token from env, bind
    localhost by default. Multi-user auth is explicitly out.
- **M6 — orchestration (done):** the model as the orchestrator — the
  primitives for bounded, observable, replayable fan-out, with what/when/how
  left to consumers. Full design rationale in
  [ORCHESTRATION.md](./ORCHESTRATION.md). Six pieces:
  1. **Event tree:** `ToolContext.emit` lets any tool stream events into the
     running agent's own stream (an internal channel the loop drains while
     tool batches execute); subagent activity arrives as `subagent_event`
     wrapping a raw leaf event with the spawn chain in `path` — flat, never
     nested. Replaces the M2 `onEvent` side channel. Mounts that ignore the
     type behave as before; the server mount needed zero changes, again.
  2. **Parallel tool batches:** all calls in one assistant turn start
     concurrently, capped by `AgentOptions.maxConcurrentTools` (default 8);
     results append in tool_use order so transcripts stay deterministic.
     (Removes the parallel-execution non-goal. The CLI serializes its
     permission prompts; core needed nothing.)
  3. **Structured output:** the spawner model may pass `schema` in the task
     input; the subagent gets a `structured_output` tool whose input schema
     *is* that schema — validation rides on the API's server-side
     enforcement. Finishing without calling it is an error the orchestrator
     can react to. `model` override rides along for cheap grunt work.
  4. **Subagent sessions:** every spawn writes a real session file;
     `SessionMeta.parent` records the spawn edge, and the task result's
     first line (`[session: <id>]`) makes it walkable from the parent
     transcript. Raw material for replay, debugging, and graphite's
     reflection over whole orchestrations.
  5. **Budgets replace the one-level rule:** `maxDepth` (default 2),
     `maxSpawns` (default 32), `maxSpawnTokens` (off) — one shared budget
     across the spawn tree; exhaustion fails fast with a message the
     orchestrator sees. M2's hard rule was policy hiding in mechanism.
  6. **Kill handle:** `onSpawn` hands the mount an `abort()` per task —
     kill one subagent without nuking the run (parent interrupt still
     cascades via joined signals).

  Explicitly deferred: background spawns (the event model is shaped so they
  can land later without breaking mounts), deterministic orchestration
  scripts, subagent continuation, worktree isolation.

## Non-goals (for now)

Multi-provider abstraction, plugin/config systems, TUI polish, sandboxing
beyond permission prompts.
