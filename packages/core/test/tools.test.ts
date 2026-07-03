import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, editTool, readTool, writeTool } from "../src/tools/index.ts";

const cwd = mkdtempSync(join(tmpdir(), "carbon-test-"));
const ctx = { cwd };

describe("bash", () => {
  test("captures stdout", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(result.output).toBe("hello");
    expect(result.isError).toBeUndefined();
  });

  test("reports non-zero exit as error", async () => {
    const result = await bashTool.execute({ command: "exit 3" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code 3");
  });

  test("runs in the working directory", async () => {
    const result = await bashTool.execute({ command: "pwd" }, ctx);
    // macOS tmpdir may resolve through /private
    expect(result.output.endsWith(cwd) || cwd.endsWith(result.output)).toBe(true);
  });
});

describe("write + read", () => {
  test("round-trips a file with line numbers", async () => {
    const write = await writeTool.execute(
      { path: "sub/dir/file.txt", content: "alpha\nbeta\ngamma" },
      ctx,
    );
    expect(write.isError).toBeUndefined();

    const read = await readTool.execute({ path: "sub/dir/file.txt" }, ctx);
    expect(read.output).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  test("read respects offset and limit", async () => {
    const read = await readTool.execute(
      { path: "sub/dir/file.txt", offset: 2, limit: 1 },
      ctx,
    );
    expect(read.output).toContain("2\tbeta");
    expect(read.output).toContain("1 more lines");
  });

  test("read errors on a missing file", async () => {
    const read = await readTool.execute({ path: "nope.txt" }, ctx);
    expect(read.isError).toBe(true);
  });
});

describe("edit", () => {
  const file = join(cwd, "edit-me.txt");

  test("replaces a unique string", async () => {
    writeFileSync(file, "one two three");
    const result = await editTool.execute(
      { path: file, old_string: "two", new_string: "2" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("one 2 three");
  });

  test("rejects an ambiguous match without replace_all", async () => {
    writeFileSync(file, "x x x");
    const result = await editTool.execute(
      { path: file, old_string: "x", new_string: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("x x x");
  });

  test("replace_all replaces every occurrence", async () => {
    writeFileSync(file, "x x x");
    const result = await editTool.execute(
      { path: file, old_string: "x", new_string: "y", replace_all: true },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("y y y");
  });

  test("errors when old_string is missing", async () => {
    writeFileSync(file, "abc");
    const result = await editTool.execute(
      { path: file, old_string: "zzz", new_string: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});
