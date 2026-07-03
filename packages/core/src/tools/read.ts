import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Tool } from "../types.ts";

const DEFAULT_LIMIT = 2_000;
const MAX_LINE_CHARS = 2_000;

export const readTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: "read",
  description:
    "Read a text file and return its contents with line numbers. " +
    "Use offset (1-based line number) and limit to read part of a large file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file, absolute or relative to the working directory." },
      offset: { type: "number", description: "1-based line number to start from." },
      limit: { type: "number", description: `Number of lines to read (default ${DEFAULT_LIMIT}).` },
    },
    required: ["path"],
  },
  readOnly: true,
  async execute(input, ctx) {
    const path = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return { output: `File not found: ${path}`, isError: true };
    }
    if (stat.isDirectory()) {
      return { output: `${path} is a directory, not a file.`, isError: true };
    }
    const lines = readFileSync(path, "utf8").split("\n");
    const offset = Math.max(input.offset ?? 1, 1);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) {
      return { output: `File has ${lines.length} lines; offset ${offset} is past the end.`, isError: true };
    }
    const numbered = slice
      .map((line, i) => {
        const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        return `${offset + i}\t${text}`;
      })
      .join("\n");
    const remaining = lines.length - (offset - 1 + slice.length);
    const footer = remaining > 0 ? `\n[${remaining} more lines — use offset to continue]` : "";
    return { output: numbered + footer };
  },
};
