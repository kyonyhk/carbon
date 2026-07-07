# @carbon/server

An HTTP + SSE mount for the carbon agent — the second mount, built to prove the
`@carbon/core` boundary holds. Everything here is ordinary client code around
the same `Agent` the CLI uses; the core was not changed to support it.

## Run

```sh
bun run packages/server/src/main.ts
```

Env: `CARBON_SERVER_PORT` (default 4600), `CARBON_SERVER_HOST` (default
127.0.0.1), `CARBON_SERVER_TOKEN` (optional bearer token; when unset the server
is localhost-only with auth disabled). Needs `ANTHROPIC_API_KEY` like any mount.

## Endpoints

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/sessions` | `{cwd?, model?, permissionMode?}` | `{id}` |
| `GET`  | `/sessions` | — | `{sessions: [{id, running}]}` |
| `POST` | `/sessions/:id/messages` | `{text}` | SSE stream of the turn's events |
| `POST` | `/sessions/:id/permissions/:reqId` | `{allow, message?}` | `{ok}` |
| `POST` | `/sessions/:id/interrupt` | — | `{interrupted}` |

`permissionMode` is `"prompt"` (default) or `"auto"`. In prompt mode, a
non-read-only tool emits a `permission_request` event on the SSE stream and the
turn blocks until you `POST` a decision to `/permissions/:reqId` (120s timeout →
deny). This is the boundary proof: `canUseTool` is just an async function, so
the wire round-trip needed no core change.

One turn per session at a time — `POST /messages` on a running session returns
409 (a single `Agent`'s `run()` must not be invoked concurrently; it shares
`messages[]`).

## SSE events

The stream carries the core `AgentEvent`s (`text`, `thinking`, `tool_start`,
`tool_result`, `response_end`, `compaction_start`/`_end`, `done`) plus two
server-only events: `permission_request` (`{id, tool, input}`) and `error`
(`{message}`).
