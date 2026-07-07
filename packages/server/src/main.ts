#!/usr/bin/env bun
import type { PermissionDecision } from "@carbon/core";
import {
  SessionBusyError,
  SessionRegistry,
  type ServerEvent,
} from "./session-registry.ts";

const PORT = Number(process.env.CARBON_SERVER_PORT ?? 4600);
const HOST = process.env.CARBON_SERVER_HOST ?? "127.0.0.1";
const TOKEN = process.env.CARBON_SERVER_TOKEN;

const registry = new SessionRegistry();
const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorized(req: Request): boolean {
  if (!TOKEN) return true; // no token configured → open (localhost only by default)
  return req.headers.get("authorization") === `Bearer ${TOKEN}`;
}

/** POST /sessions/:id/messages — run one turn, stream its events as SSE. */
function streamTurn(session: ReturnType<SessionRegistry["get"]>, text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ServerEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      session!
        .runTurn(text, emit)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: "error", message });
        })
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["sessions", ":id", "messages"]

    if (!authorized(req)) return json({ error: "unauthorized" }, 401);

    // GET /sessions
    if (req.method === "GET" && parts.length === 1 && parts[0] === "sessions") {
      return json({ sessions: registry.list() });
    }

    // POST /sessions
    if (req.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      const body = (await req.json().catch(() => ({}))) as {
        cwd?: string;
        model?: string;
        permissionMode?: "prompt" | "auto";
      };
      const session = registry.create({
        cwd: body.cwd ?? process.cwd(),
        model: body.model,
        permissionMode: body.permissionMode ?? "prompt",
      });
      return json({ id: session.id });
    }

    // /sessions/:id/...
    if (parts[0] === "sessions" && parts.length >= 2) {
      const session = registry.get(parts[1]!);
      if (!session) return json({ error: "no such session" }, 404);
      const sub = parts[2];

      // POST /sessions/:id/messages
      if (req.method === "POST" && sub === "messages") {
        const body = (await req.json().catch(() => ({}))) as { text?: string };
        if (!body.text) return json({ error: "text required" }, 400);
        if (session.running) return json({ error: "session busy" }, 409);
        try {
          return streamTurn(session, body.text);
        } catch (error) {
          if (error instanceof SessionBusyError) return json({ error: "session busy" }, 409);
          throw error;
        }
      }

      // POST /sessions/:id/permissions/:reqId
      if (req.method === "POST" && sub === "permissions" && parts[3]) {
        const body = (await req.json().catch(() => ({}))) as {
          allow?: boolean;
          message?: string;
        };
        const decision: PermissionDecision = body.allow
          ? { behavior: "allow" }
          : { behavior: "deny", message: body.message };
        const ok = session.decide(parts[3], decision);
        return ok ? json({ ok: true }) : json({ error: "no such pending permission" }, 404);
      }

      // POST /sessions/:id/interrupt
      if (req.method === "POST" && sub === "interrupt") {
        return json({ interrupted: session.interrupt() });
      }
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`carbon-server on http://${server.hostname}:${server.port}`);
if (!TOKEN) {
  console.log("(no CARBON_SERVER_TOKEN set — bound to localhost, auth disabled)");
}
