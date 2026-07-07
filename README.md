<img src="assets/carbon.png" alt="CARBON" width="100%" />

# carbon

A minimal agent harness. The structural spine — a headless agent loop, four
tools, and file-based sessions — that future agents get built on.

See [SPEC.md](./SPEC.md) for the architecture and roadmap.

## Setup

```sh
bun install
```

Auth is the Anthropic SDK default: set `ANTHROPIC_API_KEY` in your environment.

## Use

```sh
# interactive REPL in the current directory
bun run packages/cli/src/main.ts

# one-shot, non-interactive
bun run packages/cli/src/main.ts -p "what does this repo do?"

# resume the latest session
bun run packages/cli/src/main.ts -c

# skip permission prompts
bun run packages/cli/src/main.ts -y

# mount a persistent memory directory
bun run packages/cli/src/main.ts --memory ~/.carbon-memory
```

Ctrl+C during a run interrupts the current turn (the conversation stays usable);
Ctrl+C at the idle prompt exits. Sessions are append-only JSONL, so `carbon -c`
always resumes exactly where you were.

If a `CARBON.md` exists in the working directory (or between it and the repo
root), its contents are appended to the system prompt as project instructions —
nearest file wins. With `--memory <dir>`, the directory's `MEMORY.md` index is
injected at session start and the agent reads/writes memory files with its
ordinary file tools; what to store and when is up to the agent and you.

## Install globally

```sh
cd packages/cli && bun link
```

This puts a `carbon` command on your PATH (via `~/.bun/bin`) that runs the live
source — like `claude`, you run it inside any project folder and it operates on
that folder. Edits to this repo take effect immediately, no reinstall needed.

## Develop

```sh
bun run typecheck
bun test
```

## Build on it

```ts
import { Agent, coreTools } from "@carbon/core";

const agent = new Agent({ tools: coreTools(), cwd: "/path/to/project" });
for await (const event of agent.run("fix the failing test")) {
  if (event.type === "text") process.stdout.write(event.text);
}
```

The core is headless — a new agent is a new *mount* that consumes `AgentEvent`s
and supplies its own tools and permission hook.
