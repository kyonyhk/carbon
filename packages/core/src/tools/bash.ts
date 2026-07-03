import { exec } from "node:child_process";
import type { Tool } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const bashTool: Tool<{ command: string; timeout?: number }> = {
  name: "bash",
  description:
    "Execute a shell command in the working directory and return its combined stdout and stderr. " +
    "Each call runs in a fresh shell — environment variables and cd do not persist between calls. " +
    "Use this for running builds, tests, git, and anything the other tools don't cover.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeout: {
        type: "number",
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    return new Promise((resolve) => {
      exec(
        input.command,
        { cwd: ctx.cwd, timeout, maxBuffer: 10 * 1024 * 1024, shell: "/bin/bash" },
        (error, stdout, stderr) => {
          const output = [stdout, stderr].filter((s) => s.length > 0).join("\n").trimEnd();
          if (error) {
            const reason = error.killed
              ? `Command timed out after ${timeout}ms`
              : `Exit code ${error.code ?? "unknown"}`;
            resolve({ output: output ? `${output}\n${reason}` : reason, isError: true });
          } else {
            resolve({ output: output || "(no output)" });
          }
        },
      );
    });
  },
};
