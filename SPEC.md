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
- **M3 — memory:** filesystem memory directory injected into the system
  prompt; a CARBON.md project-instructions file loaded from cwd.
  Co-design with graphite (the self-improvement experiment repo that mounts
  carbon): memory files are graphite's primary mutation surface.
- **M4 — context management:** token-threshold compaction (summarize the
  transcript, restart with the summary) using the session file as source.
- **M5 — second mount:** something non-terminal (Slack, cron, or HTTP) to
  prove the core/mount boundary held.

## Non-goals (for now)

Multi-provider abstraction, plugin/config systems, TUI polish, sandboxing
beyond permission prompts, parallel tool execution.
