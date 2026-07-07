import {
  Agent,
  coreTools,
  createTaskTool,
  Session,
  type AgentEvent,
  type CanUseTool,
  type PermissionDecision,
} from "@carbon/core";

/** An event pushed onto a session's SSE stream. Adds server-only event types to the core AgentEvent union. */
export type ServerEvent =
  | AgentEvent
  | { type: "permission_request"; id: string; tool: string; input: unknown }
  | { type: "error"; message: string };

type Emit = (event: ServerEvent) => void;

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  tool: string;
}

const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * A live agent plus the server-side state for driving it over HTTP: the
 * current turn's event sink, per-session serialization, the interrupt
 * controller, and outstanding permission requests. One per session id.
 */
export class ServerSession {
  readonly agent: Agent;
  running = false;

  private emit: Emit | null = null;
  private controller: AbortController | null = null;
  private pending = new Map<string, PendingPermission>();
  private reqCounter = 0;

  constructor(
    readonly id: string,
    options: { cwd: string; model?: string; permissionMode: "prompt" | "auto" },
  ) {
    const session = Session.create({ cwd: options.cwd, model: options.model ?? "default" });
    // The boundary proof: canUseTool is just an async function. The server
    // implementation emits a permission_request onto the live SSE stream and
    // awaits an out-of-band HTTP decision — no core change required.
    const canUseTool: CanUseTool =
      options.permissionMode === "auto"
        ? async () => ({ behavior: "allow" })
        : (tool) => this.requestPermission(tool.name);

    this.agent = new Agent({
      cwd: options.cwd,
      model: options.model,
      session,
      tools: [
        ...coreTools(),
        createTaskTool({ model: options.model, cwd: options.cwd, canUseTool }),
      ],
      canUseTool,
    });
  }

  /**
   * Run one turn, streaming events to `emit`. Rejects if a turn is already in
   * flight (a single Agent's run() must not be invoked concurrently — shared
   * messages[]). Resolves when the turn completes.
   */
  async runTurn(input: string, emit: Emit): Promise<void> {
    if (this.running) throw new SessionBusyError(this.id);
    this.running = true;
    this.emit = emit;
    this.controller = new AbortController();
    try {
      for await (const event of this.agent.run(input, { signal: this.controller.signal })) {
        emit(event);
      }
    } finally {
      this.running = false;
      this.emit = null;
      this.controller = null;
      // Any permission still pending when the turn ends can never be answered.
      for (const [, p] of this.pending) p.resolve({ behavior: "deny", message: "Turn ended." });
      this.pending.clear();
    }
  }

  interrupt(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  /** Resolve an outstanding permission request. Returns false if unknown/expired. */
  decide(reqId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(reqId);
    if (!pending) return false;
    this.pending.delete(reqId);
    pending.resolve(decision);
    return true;
  }

  private requestPermission(tool: string): Promise<PermissionDecision> {
    const emit = this.emit;
    if (!emit) return Promise.resolve({ behavior: "deny", message: "No active stream." });
    const id = `perm_${++this.reqCounter}`;
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ behavior: "deny", message: "Permission request timed out." });
        }
      }, PERMISSION_TIMEOUT_MS);
      this.pending.set(id, {
        tool,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
      emit({ type: "permission_request", id, tool, input: undefined });
    });
  }
}

export class SessionBusyError extends Error {
  constructor(id: string) {
    super(`Session ${id} is already running a turn.`);
    this.name = "SessionBusyError";
  }
}

/** In-memory registry of live sessions, keyed by id. */
export class SessionRegistry {
  private sessions = new Map<string, ServerSession>();
  private counter = 0;

  create(options: { cwd: string; model?: string; permissionMode: "prompt" | "auto" }): ServerSession {
    const id = `sesn_${Date.now().toString(36)}_${++this.counter}`;
    const session = new ServerSession(id, options);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): ServerSession | undefined {
    return this.sessions.get(id);
  }

  list(): { id: string; running: boolean }[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, running: s.running }));
  }
}
