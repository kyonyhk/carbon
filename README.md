# carbon

A minimal agent harness. The structural spine — a headless agent loop, four
tools, and file-based sessions — that future agents get built on.

See [SPEC.md](./SPEC.md) for the architecture and roadmap.

## Setup

```sh
bun install
```

Auth resolves like the Anthropic SDK: `ANTHROPIC_API_KEY`, or a profile from
`ant auth login`.

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
```

Link it globally so `carbon` works anywhere:

```sh
cd packages/cli && bun link && cd - && bun link @carbon/cli
```

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
