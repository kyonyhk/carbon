import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Tool } from "../types.ts";

export const editTool: Tool<{
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}> = {
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must match the file contents exactly " +
    "(including whitespace) and must be unique unless replace_all is true. " +
    "Read the file first so your old_string matches.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file, absolute or relative to the working directory." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Text to replace it with." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    const path = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return { output: `File not found: ${path}`, isError: true };
    }
    if (input.old_string === input.new_string) {
      return { output: "old_string and new_string are identical.", isError: true };
    }
    const occurrences = content.split(input.old_string).length - 1;
    if (occurrences === 0) {
      return { output: `old_string not found in ${path}. Read the file and match the text exactly.`, isError: true };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        output: `old_string matches ${occurrences} times in ${path}. Add surrounding context to make it unique, or set replace_all.`,
        isError: true,
      };
    }
    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);
    writeFileSync(path, updated);
    const count = input.replace_all ? occurrences : 1;
    return { output: `Edited ${path} (${count} replacement${count === 1 ? "" : "s"})` };
  },
};
