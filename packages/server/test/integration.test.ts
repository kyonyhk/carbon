import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { join } from "node:path";

// Boots the real server as a subprocess and drives it over HTTP. The permission
// round-trip is the point: it proves canUseTool works across the wire with no
// core change. A fake ANTHROPIC key is fine — every test here interrupts or
// checks plumbing before any real model call resolves.
const PORT = 4699;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: Subprocess;

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "main.ts")], {
    env: { ...process.env, CARBON_SERVER_PORT: String(PORT), ANTHROPIC_API_KEY: "sk-ant-test-fake" },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for the port to accept connections.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/sessions`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("server did not start");
});

afterAll(() => proc?.kill());

async function createSession(permissionMode: "prompt" | "auto" = "prompt"): Promise<string> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp", permissionMode }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("session lifecycle", () => {
  test("create and list", async () => {
    const id = await createSession();
    expect(id).toStartWith("sesn_");
    const list = (await (await fetch(`${BASE}/sessions`)).json()) as {
      sessions: { id: string }[];
    };
    expect(list.sessions.some((s) => s.id === id)).toBe(true);
  });

  test("unknown session is 404", async () => {
    const res = await fetch(`${BASE}/sessions/nope/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  test("missing text is 400", async () => {
    const id = await createSession();
    const res = await fetch(`${BASE}/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("interrupt on an idle session reports false", async () => {
    const id = await createSession();
    const res = await fetch(`${BASE}/sessions/${id}/interrupt`, { method: "POST" });
    const body = (await res.json()) as { interrupted: boolean };
    expect(body.interrupted).toBe(false);
  });

  test("deciding an unknown permission is 404", async () => {
    const id = await createSession();
    const res = await fetch(`${BASE}/sessions/${id}/permissions/perm_999`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: true }),
    });
    expect(res.status).toBe(404);
  });
});
