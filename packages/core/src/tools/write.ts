import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Tool } from "../types.ts";

export const writeTool: Tool<{ path: string; content: string }> = {
  name: "write",
  description:
    "Write a file, creating parent directories as needed and overwriting any existing content. " +
    "For partial changes to an existing file, prefer the edit tool.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file, absolute or relative to the working directory." },
      content: { type: "string", description: "Full contents to write." },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const path = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.content);
    const lines = input.content.split("\n").length;
    return { output: `Wrote ${lines} lines to ${path}` };
  },
};
