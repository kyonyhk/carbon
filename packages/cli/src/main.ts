#!/usr/bin/env bun
import type Anthropic from "@anthropic-ai/sdk";
import {
  Agent,
  coreTools,
  createTaskTool,
  DEFAULT_MODEL,
  Session,
  type AgentEvent,
  type AgentOptions,
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
  noBanner: boolean;
  noThinking: boolean;
  noCache: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  // Env defaults let you point carbon at a cheaper endpoint once instead of
  // passing flags every run: set ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY,
  // CARBON_MODEL, and CARBON_NO_THINKING=1 (for Kimi code models).
  const args: CliArgs = {
    yolo: false,
    continue_: false,
    model: process.env.CARBON_MODEL ?? DEFAULT_MODEL,
    noBanner: false,
    noThinking: process.env.CARBON_NO_THINKING === "1",
    noCache: process.env.CARBON_NO_CACHE === "1",
  };
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
      case "--no-banner":
        // Lets a wrapping mount (e.g. graphite) suppress carbon's wordmark
        // and print its own. The info lines still print.
        args.noBanner = true;
        break;
      case "--no-thinking":
        // Omit the thinking param — needed for Anthropic-compatible endpoints
        // whose model rejects it (e.g. Kimi's kimi-k2.7-code).
        args.noThinking = true;
        break;
      case "--no-cache":
        // Omit cache_control markers, for endpoints that reject them.
        args.noCache = true;
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
            `      --memory <dir>    mount a persistent memory directory\n` +
            `      --no-thinking     omit the thinking param (e.g. for Kimi code models)\n` +
            `      --no-cache        omit prompt-cache markers\n` +
            `      --no-banner       suppress the wordmark (for wrapping mounts)\n\n` +
            `To use a non-Anthropic endpoint (e.g. Kimi), set ANTHROPIC_BASE_URL\n` +
            `and ANTHROPIC_API_KEY, then pass -m <model> (and --no-thinking if needed).\n`,
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

/** Task tool wired for the terminal. Subagent activity arrives as subagent_events in the main stream. */
function makeTaskTool(options: {
  model: string;
  cwd: string;
  hook: CanUseTool;
  thinking: AgentOptions["thinking"];
  cacheControl: boolean;
}): Tool {
  return createTaskTool({
    model: options.model,
    cwd: options.cwd,
    canUseTool: options.hook,
    thinking: options.thinking,
    cacheControl: options.cacheControl,
  });
}

/**
 * Tool calls now run concurrently, so approval requests can arrive at the
 * same time — chain them so the terminal shows one question at a time.
 */
function serializePrompts(hook: CanUseTool): CanUseTool {
  let chain: Promise<unknown> = Promise.resolve();
  return (tool, input) => {
    const next = chain.then(() => hook(tool, input));
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

function makePermissionHook(options: {
  yolo: boolean;
  rl?: Interface;
  alwaysAllowed: Set<string>;
  /** Signal of the currently active run, so Ctrl+C cancels a pending prompt. */
  getSignal?: () => AbortSignal | undefined;
}): CanUseTool {
  return serializePrompts(async (tool, input) => {
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
  });
}

const BANNER = [
  "  \u001b[97m#B&M%B\u001b[0m        \u001b[97m(%%&\u001b[0m      \u001b[97m@$#WYB#$\u001b[0m    \u001b[97m#WMW@*&W@&\u001b[0m    \u001b[97m##WW$W%@\u001b[0m    \u001b[97m%8\u001b[0m      \u001b[97m8$\u001b[0m",
  "\u001b[97m&8\u001b[0m  \u001b[38;5;248m>'!-\u001b[0m\u001b[97m%X\u001b[0m    \u001b[97mm$%&]&*@\u001b[0m    \u001b[97m#M\u001b[0m\u001b[38;5;248m+>~i\u001b[0m\u001b[97mZ#M%\u001b[0m  \u001b[97m#$\u001b[0m\u001b[38;5;248m~+-,!+\u001b[0m\u001b[97mW@\u001b[0m\u001b[38;5;248m-=\u001b[0m  \u001b[97m)$\u001b[0m\u001b[38;5;248m~:<<\u001b[0m\u001b[97m&8\u001b[0m\u001b[38;5;248mli\u001b[0m  \u001b[97m%W\u001b[0m\u001b[38;5;248m;=\u001b[0m    \u001b[97m&@\u001b[0m\u001b[38;5;248m+l\u001b[0m",
  "\u001b[97mW$\u001b[0m\u001b[38;5;248m\"~\u001b[0m      \u001b[38;5;248m\"-\u001b[0m\u001b[97mYXm%\u001b[0m\u001b[38;5;248m+'=,\u001b[0m\u001b[97m#O\u001b[0m\u001b[38;5;248m:-\u001b[0m  \u001b[97mWM\u001b[0m\u001b[38;5;248m;l\u001b[0m  \u001b[97m$M*B\u001b[0m\u001b[38;5;248m!,\u001b[0m\u001b[97m&8\u001b[0m\u001b[38;5;248mi~\u001b[0m    \u001b[97m$W\u001b[0m\u001b[38;5;248mi=\u001b[0m  \u001b[97mWW\u001b[0m\u001b[38;5;248m~'\u001b[0m  \u001b[97m@]\u001b[0m\u001b[38;5;248ml=\u001b[0m  \u001b[97m\\8%$\u001b[0m    \u001b[97m$B\u001b[0m\u001b[38;5;248m'+\u001b[0m",
  "\u001b[97m0#\u001b[0m\u001b[38;5;248mi=\u001b[0m        \u001b[97m#@B#\u001b[0m\u001b[38;5;248m+l\u001b[0m  \u001b[97mwX\u001b[0m\u001b[38;5;248m+'\u001b[0m  \u001b[97m&W&B%@$X\u001b[0m\u001b[38;5;248m\"l:i\u001b[0m\u001b[97mkMW&W&*m@a\u001b[0m\u001b[38;5;248m`'\u001b[0m  \u001b[97mWW\u001b[0m\u001b[38;5;248m=>\u001b[0m  \u001b[97m#@\u001b[0m\u001b[38;5;248m,i\u001b[0m  \u001b[97m#M\u001b[0m\u001b[38;5;248m+;\u001b[0m\u001b[97mM#\u001b[0m  \u001b[97m88\u001b[0m\u001b[38;5;248m=i\u001b[0m",
  "\u001b[97mB%\u001b[0m\u001b[38;5;248mi=\u001b[0m        \u001b[97m0&)&@h8M\\M\u001b[0m\u001b[38;5;248m.-\u001b[0m  \u001b[97m8%M8MM\u001b[0m\u001b[38;5;248m+-\">\u001b[0m  \u001b[97m&8\u001b[0m\u001b[38;5;248m.++~!=\u001b[0m\u001b[97mW$\u001b[0m\u001b[38;5;248m,`\u001b[0m  \u001b[97m%#\u001b[0m\u001b[38;5;248m>;\u001b[0m  \u001b[97m0w\u001b[0m\u001b[38;5;248m+!\u001b[0m  \u001b[97mO%\u001b[0m\u001b[38;5;248m!'\u001b[0m  \u001b[97m#M#$\u001b[0m\u001b[38;5;248m:<\u001b[0m",
  "\u001b[97mW#\u001b[0m\u001b[38;5;248m!!\u001b[0m    \u001b[97m$m\u001b[0m  \u001b[97mB@8t\u001b[0m\u001b[38;5;248m+<l+\u001b[0m\u001b[97m&&\u001b[0m\u001b[38;5;248m.;\u001b[0m  \u001b[97mvB\u001b[0m\u001b[38;5;248m\"~\u001b[0m\u001b[97m&tX8\u001b[0m    \u001b[97mMB\u001b[0m\u001b[38;5;248m:<\u001b[0m    \u001b[97m$m\u001b[0m\u001b[38;5;248m;=\u001b[0m  \u001b[97m&8\u001b[0m\u001b[38;5;248m!!\u001b[0m  \u001b[97mZ#\u001b[0m\u001b[38;5;248m:-\u001b[0m  \u001b[97m*O\u001b[0m\u001b[38;5;248m;;\u001b[0m    \u001b[97mW|\u001b[0m\u001b[38;5;248m:=\u001b[0m",
  "  \u001b[97m$&MO@M\u001b[0m  \u001b[38;5;248m~l\u001b[0m\u001b[97mhmvB\u001b[0m\u001b[38;5;248m>;\u001b[0m  \u001b[97mW8\u001b[0m\u001b[38;5;248m=l\u001b[0m  \u001b[97m@W\u001b[0m\u001b[38;5;248m~i\u001b[0m  \u001b[97mBBBM\u001b[0m  \u001b[97mk0@k#Bk0h%\u001b[0m\u001b[38;5;248ml;\u001b[0m  \u001b[97m##*$#%#$\u001b[0m\u001b[38;5;248m:\"\u001b[0m  \u001b[97m8@\u001b[0m\u001b[38;5;248m!!\u001b[0m    \u001b[97m8B\u001b[0m\u001b[38;5;248m::\u001b[0m",
  "    \u001b[38;5;248m.`=\"\";\u001b[0m    \u001b[38;5;248m<<+;\u001b[0m    \u001b[38;5;248m``\u001b[0m    \u001b[38;5;248m+>\u001b[0m    \u001b[38;5;248m:,'>\u001b[0m  \u001b[38;5;248m<l;'~>+-'<\u001b[0m    \u001b[38;5;248m~;;<,;=`\u001b[0m    \u001b[38;5;248m+,\u001b[0m      \u001b[38;5;248m\"-\u001b[0m",
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
      case "subagent_event": {
        // One dim line per subagent tool call, indented by spawn depth;
        // subagent usage folds into the shared totals.
        const inner = event.event;
        if (inner.type === "tool_start") {
          const label = event.path.map((ref) => ref.description).join(" › ");
          const preview = toolPreview(inner.name, inner.input);
          const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
          const indent = "  ".repeat(event.path.length - 1);
          process.stdout.write(dim(`    ${indent}· [${label}] ${inner.name} ${short}\n`));
        } else if (inner.type === "response_end") {
          const usage = inner.usage as Anthropic.Usage;
          totals.input +=
            usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
          totals.cacheRead += usage.cache_read_input_tokens ?? 0;
          totals.output += usage.output_tokens;
        }
        break;
      }
      case "compaction_start":
        process.stdout.write(dim("\n[compacting context…]"));
        mode = "idle";
        break;
      case "compaction_end":
        process.stdout.write(
          dim(` folded ${event.foldedMessages} messages into a summary\n`),
        );
        break;
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
  // Provider settings: undefined thinking means the core default (adaptive);
  // null disables it for endpoints/models that reject the param.
  const thinking: AgentOptions["thinking"] = args.noThinking ? null : undefined;
  const cacheControl = !args.noCache;

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
      thinking,
      cacheControl,
      tools: [
        ...coreTools(),
        makeTaskTool({ model: args.model, cwd, hook, thinking, cacheControl }),
      ],
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
    thinking,
    cacheControl,
    tools: [
      ...coreTools(),
      makeTaskTool({ model: args.model, cwd, hook, thinking, cacheControl }),
    ],
    session,
    messages,
    canUseTool: hook,
  });

  if (args.noBanner) {
    // Wrapping mount owns the wordmark; just print the info line.
    console.log(dim(`${args.model} · ${cwd}`));
  } else if ((process.stdout.columns ?? 80) >= 78) {
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
    if (trimmed === "/compact") {
      process.stdout.write(dim("compacting…"));
      try {
        const result = await agent.compact();
        process.stdout.write(
          result
            ? dim(` folded ${result.foldedMessages} messages\n\n`)
            : dim(" nothing to compact\n\n"),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(red(`\nerror: ${message}`));
      }
      continue;
    }

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
