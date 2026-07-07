import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Collect CARBON.md project-instructions files from cwd up to the repo root
 * (the nearest directory containing .git). Returns their combined contents,
 * root first and nearest last so nearer instructions take precedence — or
 * null if there are none. Outside a git repo only cwd's own CARBON.md
 * applies; a stray file in some ancestor directory should not leak into
 * every project below it.
 */
export function loadProjectInstructions(cwd: string): string | null {
  const start = resolve(cwd);
  const found: string[] = []; // nearest first
  let dir = start;
  let inRepo = false;
  while (true) {
    const candidate = join(dir, "CARBON.md");
    if (existsSync(candidate)) found.push(candidate);
    if (existsSync(join(dir, ".git"))) {
      inRepo = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const files = inRepo ? found : found.filter((f) => dirname(f) === start);
  if (files.length === 0) return null;
  return files
    .reverse()
    .map((f) => `<project-instructions from="${f}">\n${readFileSync(f, "utf8").trim()}\n</project-instructions>`)
    .join("\n\n");
}

/**
 * The system-prompt section for a mounted memory directory: the MEMORY.md
 * index plus a short note that the directory is readable and writable with
 * the ordinary file tools. Carbon injects the index and keeps it current —
 * what to store, in what format, and when is the consumer's policy.
 */
export function buildMemorySection(memoryDir: string): string {
  const indexPath = join(memoryDir, "MEMORY.md");
  let index: string | null = null;
  try {
    index = readFileSync(indexPath, "utf8").trim() || null;
  } catch {
    // no index yet — the section still announces the directory
  }
  const lines = [
    "# Memory",
    "",
    `You have a persistent memory directory at ${memoryDir}. Its files survive across sessions. ` +
      "Read them with the read tool; create and update them with the write and edit tools. " +
      `Keep the index file ${indexPath} up to date when you change memory files — it is what you see here at the start of every session.`,
  ];
  if (index) {
    lines.push("", `Contents of ${indexPath}:`, "", index);
  } else {
    lines.push("", "The index does not exist yet; create it the first time you save a memory.");
  }
  return lines.join("\n");
}
