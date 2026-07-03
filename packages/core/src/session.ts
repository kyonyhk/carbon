import type Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
}

type SessionLine =
  | ({ type: "meta" } & SessionMeta)
  | { type: "message"; ts: string; role: Anthropic.MessageParam["role"]; content: Anthropic.MessageParam["content"] };

/**
 * Append-only JSONL transcript. One file per session; first line is metadata,
 * every following line is a message. Cheap to write, trivial to replay.
 */
export class Session {
  private constructor(
    readonly filePath: string,
    readonly meta: SessionMeta,
  ) {}

  static dir(): string {
    return join(homedir(), ".carbon", "sessions");
  }

  static create(options: { cwd: string; model: string }): Session {
    const createdAt = new Date();
    const id = `${createdAt.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: SessionMeta = {
      id,
      createdAt: createdAt.toISOString(),
      cwd: options.cwd,
      model: options.model,
    };
    mkdirSync(Session.dir(), { recursive: true });
    const filePath = join(Session.dir(), `${id}.jsonl`);
    appendFileSync(filePath, `${JSON.stringify({ type: "meta", ...meta })}\n`);
    return new Session(filePath, meta);
  }

  /** Most recently modified session file, or null if none exist. */
  static latestPath(): string | null {
    let files: string[];
    try {
      files = readdirSync(Session.dir()).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return null;
    }
    if (files.length === 0) return null;
    const paths = files.map((f) => join(Session.dir(), f));
    paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return paths[0] ?? null;
  }

  static load(filePath: string): {
    session: Session;
    messages: Anthropic.MessageParam[];
  } {
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionLine);

    const metaLine = lines.find((l) => l.type === "meta");
    if (!metaLine || metaLine.type !== "meta") {
      throw new Error(`Not a carbon session file (no meta line): ${filePath}`);
    }
    const { type: _type, ...meta } = metaLine;
    const messages = lines
      .filter((l): l is Extract<SessionLine, { type: "message" }> => l.type === "message")
      .map((l) => ({ role: l.role, content: l.content }));
    return { session: new Session(filePath, meta), messages };
  }

  append(message: Anthropic.MessageParam): void {
    const line: SessionLine = {
      type: "message",
      ts: new Date().toISOString(),
      role: message.role,
      content: message.content,
    };
    appendFileSync(this.filePath, `${JSON.stringify(line)}\n`);
  }
}
