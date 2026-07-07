#!/usr/bin/env bun
import type Anthropic from "@anthropic-ai/sdk";
import {
  Agent,
  coreTools,
  createTaskTool,
  DEFAULT_MODEL,
  Session,
  type AgentEvent,
  type CanUseTool,
  type Tool,
} from "@carbon/core";
import { createInterface, type Interface } from "node:readline/promises";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface CliArgs {
  yolo: boolean;
  continue_: boolean;
  model: string;
  print?: string;
  memoryDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yolo: false, continue_: false, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-y":
      case "--yolo":
        args.yolo = true;
        break;
      case "-c":
      case "--continue":
        args.continue_ = true;
        break;
      case "-m":
      case "--model":
        args.model = argv[++i] ?? DEFAULT_MODEL;
        break;
      case "-p":
      case "--print":
        args.print = argv[++i];
        break;
      case "--memory":
        args.memoryDir = argv[++i];
        break;
      case "-h":
      case "--help":
        console.log(
          `carbon — a minimal coding agent\n\n` +
            `usage: carbon [options]\n\n` +
            `  -p, --print <prompt>  run one prompt non-interactively and exit\n` +
            `  -c, --continue        resume the most recent session\n` +
            `  -m, --model <id>      model to use (default ${DEFAULT_MODEL})\n` +
            `  -y, --yolo            skip tool permission prompts\n` +
            `      --memory <dir>    mount a persistent memory directory\n`,
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return args;
}

function toolPreview(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "bash") return String(record.command ?? "");
  if (name === "task") return String(record.description ?? "");
  if (typeof record.path === "string") return record.path;
  return JSON.stringify(input);
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
}

/** Task tool wired for the terminal: nested activity lines + shared token totals. */
function makeTaskTool(options: {
  model: string;
  cwd: string;
  hook: CanUseTool;
  totals: Totals;
}): Tool {
  return createTaskTool({
    model: options.model,
    cwd: options.cwd,
    canUseTool: options.hook,
    onEvent: (event, task) => {
      if (event.type === "tool_start") {
        const preview = toolPreview(event.name, event.input);
        const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
        process.stdout.write(dim(`    · [${task.description}] ${event.name} ${short}\n`));
      } else if (event.type === "response_end") {
        options.totals.input +=
          event.usage.input_tokens + (event.usage.cache_creation_input_tokens ?? 0);
        options.totals.cacheRead += event.usage.cache_read_input_tokens ?? 0;
        options.totals.output += event.usage.output_tokens;
      }
    },
  });
}

function makePermissionHook(options: {
  yolo: boolean;
  rl?: Interface;
  alwaysAllowed: Set<string>;
  /** Signal of the currently active run, so Ctrl+C cancels a pending prompt. */
  getSignal?: () => AbortSignal | undefined;
}): CanUseTool {
  return async (tool, input) => {
    if (options.yolo || options.alwaysAllowed.has(tool.name)) {
      return { behavior: "allow" };
    }
    if (!options.rl) {
      return {
        behavior: "deny",
        message: `Tool "${tool.name}" requires approval; rerun with --yolo to allow tools in print mode.`,
      };
    }
    const signal = options.getSignal?.();
    if (signal?.aborted) {
      return { behavior: "deny", message: "Interrupted by user." };
    }
    let answer: string;
    try {
      answer = await options.rl.question(
        `\n${bold(`allow ${tool.name}?`)} ${dim(toolPreview(tool.name, input))} [y/n/a] `,
        signal ? { signal } : {},
      );
    } catch {
      // Question aborted by Ctrl+C mid-prompt.
      return { behavior: "deny", message: "Interrupted by user." };
    }
    const choice = answer.trim().toLowerCase();
    if (choice === "a") {
      options.alwaysAllowed.add(tool.name);
      return { behavior: "allow" };
    }
    if (choice === "y" || choice === "yes") return { behavior: "allow" };
    return { behavior: "deny" };
  };
}

const BANNER = [
  "  \x1b[97m&BW$@#@&\x1b[0m      \x1b[97m$#%$\x1b[0m      \x1b[97m@WW@%@#W$@\x1b[0m  \x1b[97m%$W$%$#B8W\x1b[0m      \x1b[97mB#@8#B@%\x1b[0m  \x1b[97m&@\x1b[0m        \x1b[97m#@\x1b[0m",
  "\x1b[97m$%M#\x1b[0m\x1b[38;5;248m<=>i\x1b[0m\x1b[97mM&8%\x1b[0m  \x1b[97mB%@8#M&M\x1b[0m    \x1b[97m8@\x1b[0m\x1b[38;5;248m;!<~=~\x1b[0m\x1b[97mMW$@#&&&\x1b[0m\x1b[38;5;248mi>i>\x1b[0m\x1b[97m@@8M\x1b[0m  \x1b[97m@$8M\x1b[0m\x1b[38;5;248m+<=:\x1b[0m\x1b[97mM&\x1b[0m\x1b[38;5;248m~i\x1b[0m\x1b[97m@M$%\x1b[0m      \x1b[97m8B\x1b[0m\x1b[38;5;248m-<\x1b[0m",
  "\x1b[97mWM\x1b[0m\x1b[38;5;248m;~><\x1b[0m    \x1b[38;5;248m!+~<\x1b[0m\x1b[97m#8\x1b[0m\x1b[38;5;248m<=<-\x1b[0m\x1b[97mB@BB\x1b[0m  \x1b[97m%%\x1b[0m\x1b[38;5;248m:>\x1b[0m    \x1b[97mB88$BW#&\x1b[0m\x1b[38;5;248mii\x1b[0m    \x1b[97m&B\x1b[0m\x1b[38;5;248m!i\x1b[0m\x1b[97m$M\x1b[0m\x1b[38;5;248m!<<<\x1b[0m  \x1b[97mW@MW$%@%MB\x1b[0m    \x1b[97m@&\x1b[0m\x1b[38;5;248mi:\x1b[0m",
  "\x1b[97m@$\x1b[0m\x1b[38;5;248mi~\x1b[0m        \x1b[97m#@&$\x1b[0m\x1b[38;5;248m;-\x1b[0m    \x1b[97mWB\x1b[0m\x1b[38;5;248m+=\x1b[0m\x1b[97m&M@@MMMM8@\x1b[0m\x1b[38;5;248m~;\x1b[0m\x1b[97m&8MB#$%#&B#$\x1b[0m\x1b[38;5;248m!+\x1b[0m\x1b[97m@8\x1b[0m\x1b[38;5;248m!=\x1b[0m    \x1b[97mB&%###&%%%W%\x1b[0m  \x1b[97m%#\x1b[0m\x1b[38;5;248m>=\x1b[0m",
  "\x1b[97m$$\x1b[0m\x1b[38;5;248m+>\x1b[0m        \x1b[97m8%&M&&@%@%M%\x1b[0m\x1b[38;5;248m=-\x1b[0m\x1b[97mM$M&@@W%\x1b[0m\x1b[38;5;248m>~<=\x1b[0m\x1b[97m@WMW@BBB$BMB\x1b[0m\x1b[38;5;248mii\x1b[0m\x1b[97mM&\x1b[0m\x1b[38;5;248m~!\x1b[0m    \x1b[97m#B$$@#\x1b[0m\x1b[38;5;248m~<--\x1b[0m\x1b[97m$8%8#%\x1b[0m\x1b[38;5;248mi=\x1b[0m",
  "\x1b[97m8#\x1b[0m\x1b[38;5;248m<~\x1b[0m        \x1b[97m$&M#W#B#B##$\x1b[0m\x1b[38;5;248m>~\x1b[0m\x1b[97m$B\x1b[0m\x1b[38;5;248m~~\x1b[0m\x1b[97mM@#$\x1b[0m\x1b[38;5;248m=!\x1b[0m  \x1b[97m##M@\x1b[0m\x1b[38;5;248m!:--+:\x1b[0m\x1b[97m@#\x1b[0m\x1b[38;5;248m>!\x1b[0m\x1b[97m$@\x1b[0m\x1b[38;5;248m>=\x1b[0m    \x1b[97m##%8M##M\x1b[0m    \x1b[97m#%#8\x1b[0m\x1b[38;5;248m!-\x1b[0m",
  "\x1b[97mMBW@\x1b[0m    \x1b[97mWM&@%W@%\x1b[0m\x1b[38;5;248m+;~=~+\x1b[0m\x1b[97mBM\x1b[0m\x1b[38;5;248m-;\x1b[0m\x1b[97mWM\x1b[0m\x1b[38;5;248m~-\x1b[0m  \x1b[97mBW#W\x1b[0m  \x1b[97m&W%&\x1b[0m\x1b[38;5;248m=;\x1b[0m  \x1b[97m&$&#\x1b[0m\x1b[38;5;248m>>\x1b[0m\x1b[97m$W&#\x1b[0m    \x1b[97m8#\x1b[0m\x1b[38;5;248m;;\x1b[0m\x1b[97m%@@8\x1b[0m\x1b[38;5;248m+:\x1b[0m    \x1b[97mB8\x1b[0m\x1b[38;5;248m~<\x1b[0m",
  "  \x1b[97m8WB##M&@\x1b[0m\x1b[38;5;248m+:\x1b[0m\x1b[97mBW@8\x1b[0m\x1b[38;5;248m:;\x1b[0m    \x1b[97m8@\x1b[0m\x1b[38;5;248mi-\x1b[0m\x1b[97m@8\x1b[0m\x1b[38;5;248m;>\x1b[0m    \x1b[97m$&#W8B$#%@B8$B\x1b[0m\x1b[38;5;248m-++!\x1b[0m  \x1b[97m%8M#B8&$\x1b[0m\x1b[38;5;248m+:\x1b[0m\x1b[97m$$##\x1b[0m\x1b[38;5;248m-!\x1b[0m    \x1b[97mM%\x1b[0m\x1b[38;5;248m>;\x1b[0m",
  "    \x1b[38;5;248m<>!<!+--\x1b[0m  \x1b[38;5;248m=-~<\x1b[0m      \x1b[38;5;248m=:\x1b[0m  \x1b[38;5;248m~:\x1b[0m      \x1b[38;5;248m;+<~:;<!+i-+:>\x1b[0m      \x1b[38;5;248m~~+>:+==\x1b[0m  \x1b[38;5;248m!=-:\x1b[0m      \x1b[38;5;248m+-\x1b[0m",
];

/** Renders the agent's event stream to the terminal. Returns cumulative usage. */
async function renderRun(
  events: AsyncGenerator<AgentEvent>,
  totals: { input: number; output: number; cacheRead: number },
): Promise<void> {
  // Track what we're printing so we can insert separators between modes.
  let mode: "idle" | "thinking" | "text" = "idle";
  const switchTo = (next: "thinking" | "text") => {
    if (mode !== next && mode !== "idle") process.stdout.write("\n\n");
    if (mode === "idle") process.stdout.write("\n");
    mode = next;
  };

  for await (const event of events) {
    switch (event.type) {
      case "thinking":
        switchTo("thinking");
        process.stdout.write(dim(event.text));
        break;
      case "text":
        switchTo("text");
        process.stdout.write(event.text);
        break;
      case "tool_start":
        process.stdout.write(
          `\n${cyan(`⏺ ${event.name}`)} ${dim(toolPreview(event.name, event.input))}\n`,
        );
        mode = "idle";
        break;
      case "tool_result": {
        const firstLine = event.result.output.split("\n")[0] ?? "";
        const summary = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
        process.stdout.write(
          event.result.isError ? `  ${red(`⎿ ${summary}`)}\n` : dim(`  ⎿ ${summary}\n`),
        );
        break;
      }
      case "response_end": {
        const usage = event.usage as Anthropic.Usage;
        totals.input +=
          usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
        totals.cacheRead += usage.cache_read_input_tokens ?? 0;
        totals.output += usage.output_tokens;
        break;
      }
      case "done":
        process.stdout.write("\n");
        if (event.stopReason === "interrupted") {
          process.stdout.write(dim("[interrupted — type a new message to continue]\n"));
        } else if (event.stopReason === "refusal") {
          process.stdout.write(red("\n[the model declined this request]\n"));
        } else if (event.stopReason === "max_tokens") {
          process.stdout.write(red("\n[response hit the output token limit]\n"));
        }
        break;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(red("No API key found. Set ANTHROPIC_API_KEY in your environment."));
    process.exit(1);
  }
  const cwd = process.cwd();
  const alwaysAllowed = new Set<string>();

  let session: Session;
  let messages: Anthropic.MessageParam[] = [];
  if (args.continue_) {
    const latest = Session.latestPath();
    if (!latest) {
      console.error("No previous session to continue.");
      process.exit(1);
    }
    const loaded = Session.load(latest);
    session = loaded.session;
    messages = loaded.messages;
  } else {
    session = Session.create({ cwd, model: args.model });
  }

  // Non-interactive print mode: one prompt, render, exit.
  if (args.print !== undefined) {
    const totals: Totals = { input: 0, output: 0, cacheRead: 0 };
    const hook = makePermissionHook({ yolo: args.yolo, alwaysAllowed });
    const agent = new Agent({
      model: args.model,
      cwd,
      memoryDir: args.memoryDir,
      tools: [...coreTools(), makeTaskTool({ model: args.model, cwd, hook, totals })],
      session,
      messages,
      canUseTool: hook,
    });
    try {
      await renderRun(agent.run(args.print), totals);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(red(`\nerror: ${message}`));
      process.exit(1);
    }
    process.stdout.write(
      dim(`\n[tokens: ${totals.input} in, ${totals.cacheRead} cached, ${totals.output} out]\n`),
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl+C during a run interrupts the run; at the idle prompt it exits.
  let activeController: AbortController | null = null;
  const onInterrupt = () => {
    if (activeController) {
      activeController.abort();
    } else {
      process.stdout.write("\n");
      process.exit(0);
    }
  };
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  const totals: Totals = { input: 0, output: 0, cacheRead: 0 };
  const hook = makePermissionHook({
    yolo: args.yolo,
    rl,
    alwaysAllowed,
    getSignal: () => activeController?.signal,
  });
  const agent = new Agent({
    model: args.model,
    cwd,
    memoryDir: args.memoryDir,
    tools: [...coreTools(), makeTaskTool({ model: args.model, cwd, hook, totals })],
    session,
    messages,
    canUseTool: hook,
  });

  if ((process.stdout.columns ?? 80) >= 78) {
    console.log("\n" + BANNER.join("\n") + "\n");
    console.log(dim(`${args.model} · ${cwd}`));
  } else {
    console.log(bold("carbon") + dim(` · ${args.model} · ${cwd}`));
  }
  console.log(dim(`session: ${session.filePath}`));
  console.log(dim(`type a message, or "exit" to quit\n`));

  while (true) {
    let input: string;
    try {
      input = await rl.question(bold("> "));
    } catch {
      break; // ctrl-d / closed stdin
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "exit" || trimmed === "quit") break;

    activeController = new AbortController();
    try {
      await renderRun(agent.run(trimmed, { signal: activeController.signal }), totals);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(red(`\nerror: ${message}`));
    } finally {
      activeController = null;
    }
    process.stdout.write(
      dim(`[tokens: ${totals.input} in, ${totals.cacheRead} cached, ${totals.output} out]\n\n`),
    );
  }
  rl.close();
}

main();
