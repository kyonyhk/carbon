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
      agent.ts     Agent: the loop, tool execution, permission hook
      types.ts     Tool, ToolResult, AgentEvent, CanUseTool
      tools/       bash, read, write, edit
      session.ts   JSONL transcript store
      prompt.ts    default system prompt
  cli/           the first mount — readline REPL + print mode
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
- **M3 — memory (next):** the *mechanism* for persistent context, with zero
  policy. Three pieces, all in core:
  1. **Project instructions:** if a `CARBON.md` exists in cwd, append its
     contents to the system prompt. (Also walk up to the repo root, nearest
     file wins; both loaded if nested.)
  2. **Memory mount:** `AgentOptions.memoryDir?: string` — if set, inject the
     directory's index file (`MEMORY.md`) into the system prompt at session
     start, plus a short instruction telling the model the directory exists
     and is readable/writable with the ordinary file tools. Carbon does not
     define the file format, when to write, or what to store.
  3. **Tool awareness:** `ToolContext.memoryDir?: string` so consumers can
     build memory-specific tools without re-plumbing paths.

  Explicitly out of core (consumer policy): what counts as memorable, file
  format/frontmatter conventions, reflection/consolidation/decay, whether
  injection is index-only or content, embeddings or search. The design
  authority for these choices is graphite (see `~/Desktop/graphite-spec.md`)
  as first consumer; the API must also read sensibly for a chat-product mount
  and a cron mount (the "second consumer test") before it lands.
- **M4 — compaction:** client-side, in core. Server-side compaction (the
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
  - **Mechanics:** summarize `messages[]` with a dedicated prompt (in
    `prompt.ts`, overridable via `AgentOptions`) that must capture task
    state, decisions, files touched and their relevant state, unresolved
    threads, and user preferences. Summarizer uses the session's own model.
    Rebuild history as: one user message containing the summary in
    `<compaction-summary>` tags → verbatim tail → new input.
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
- **M5 — second mount, HTTP + SSE server (`@carbon/server`):** M5 is a test
  with a pass/fail criterion: **the mount must be buildable with zero
  changes to `@carbon/core`** — any core change it forces is a documented
  API finding, not a workaround. Chosen over Slack/cron because it stresses
  the boundary hardest and everything else (web UI, chat bridges,
  Omaru-shaped clients) becomes a thin client of it later.
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

## Non-goals (for now)

Multi-provider abstraction, plugin/config systems, TUI polish, sandboxing
beyond permission prompts, parallel tool execution.
