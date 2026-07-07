import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { buildMemorySection, loadProjectInstructions } from "../src/memory.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "carbon-m3-"));
}

describe("loadProjectInstructions", () => {
  test("returns null when no CARBON.md exists", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    expect(loadProjectInstructions(dir)).toBeNull();
  });

  test("loads CARBON.md from cwd in a repo", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "CARBON.md"), "use tabs");
    const result = loadProjectInstructions(dir);
    expect(result).toContain("use tabs");
    expect(result).toContain(`from="${join(dir, "CARBON.md")}"`);
  });

  test("nested: loads both, root first and nearest last", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "CARBON.md"), "root rules");
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "CARBON.md"), "app rules");
    const result = loadProjectInstructions(sub)!;
    expect(result.indexOf("root rules")).toBeLessThan(result.indexOf("app rules"));
  });

  test("outside a repo, ancestor CARBON.md files do not leak in", () => {
    const parent = tempDir(); // no .git anywhere up the temp tree
    writeFileSync(join(parent, "CARBON.md"), "stray ancestor rules");
    const child = join(parent, "project");
    mkdirSync(child);
    expect(loadProjectInstructions(child)).toBeNull();

    writeFileSync(join(child, "CARBON.md"), "local rules");
    const result = loadProjectInstructions(child)!;
    expect(result).toContain("local rules");
    expect(result).not.toContain("stray ancestor rules");
  });
});

describe("buildMemorySection", () => {
  test("injects the MEMORY.md index when it exists", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "MEMORY.md"), "- [thing](thing.md) — a fact");
    const section = buildMemorySection(dir);
    expect(section).toContain(`persistent memory directory at ${dir}`);
    expect(section).toContain("- [thing](thing.md) — a fact");
  });

  test("announces the directory even without an index", () => {
    const dir = tempDir();
    const section = buildMemorySection(dir);
    expect(section).toContain(`persistent memory directory at ${dir}`);
    expect(section).toContain("does not exist yet");
  });
});

describe("Agent system prompt composition", () => {
  test("base + project instructions + memory, in that order", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, "CARBON.md"), "project says hi");
    const memoryDir = tempDir();
    writeFileSync(join(memoryDir, "MEMORY.md"), "remembered fact");

    const agent = new Agent({ cwd, memoryDir, systemPrompt: "BASE" });
    const p = agent.systemPrompt;
    expect(p.indexOf("BASE")).toBe(0);
    expect(p.indexOf("project says hi")).toBeGreaterThan(p.indexOf("BASE"));
    expect(p.indexOf("remembered fact")).toBeGreaterThan(p.indexOf("project says hi"));
  });

  test("projectInstructions: false skips CARBON.md", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, "CARBON.md"), "should not appear");
    const agent = new Agent({ cwd, systemPrompt: "BASE", projectInstructions: false });
    expect(agent.systemPrompt).toBe("BASE");
  });

  test("no CARBON.md and no memoryDir leaves the prompt untouched", () => {
    const agent = new Agent({ cwd: tempDir(), systemPrompt: "BASE" });
    expect(agent.systemPrompt).toBe("BASE");
  });
});
