/**
 * The realtime relay's Worker side: two Durable Object classes and the router
 * in front of them. The design, and what Node does with it, is in
 * `server-core/realtime/protocol.ts`.
 *
 * Both objects use the hibernation API: a socket that is idle (a bastion
 * agent between cloud calls, the host link of a console nobody has shared)
 * costs nothing while the object sleeps, and each socket's identity lives in
 * its attachment so it survives a wake. In-flight state (stream routes, calls
 * waiting for an answer) is in memory; it only exists while traffic keeps the
 * object awake, and a frame for a stream the object no longer knows closes
 * that stream rather than vanishing.
 *
 * Nothing here imports the server: the agent's token is checked by the router
 * (which loads it the way every API request does) before the object sees the
 * socket, and the objects themselves never touch Postgres.
 */
import type {
  DurableObjectNamespace,
  DurableObjectState,
  ExecutionContext,
  WebSocket as WorkerWebSocket,
} from "@cloudflare/workers-types/index";
import { BastionMux, type MuxOutput } from "@infrawrench/server-core/realtime/bastion-mux";
import type { BastionMessage } from "@infrawrench/server-core/bastion/protocol";
import {
  BASTION_AGENT_PATH,
  CONSOLE_RPC_TIMEOUT_MS,
  REALTIME_PREFIX,
  REALTIME_SECRET_HEADER,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_UNAVAILABLE,
  type ConsoleHostToRelay,
  type ConsoleRelayToHost,
  type ConsoleRpcMethod,
} from "@infrawrench/server-core/realtime/protocol";

/** The bastion agent's protocol version and heartbeat, as the Node endpoint sent them. */
const BASTION_PROTOCOL_VERSION = 1;
const BASTION_HEARTBEAT_MS = 25_000;
/** How often the bastion object checks its agent is still alive. */
const AGENT_CHECK_MS = 60_000;

const ROLE_HEADER = "x-iw-relay-role";
const ALLOWLIST_HEADER = "x-iw-bastion-allowlist";

export interface RealtimeEnv {
  BASTION_RELAY: DurableObjectNamespace;
  CONSOLE_RELAY: DurableObjectNamespace;
  INTERNAL_RELAY_SECRET?: string;
}

/** The pair a WebSocket upgrade response hands back. */
declare const WebSocketPair: { new (): { 0: WorkerWebSocket; 1: WorkerWebSocket } };
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

function upgradeResponse(client: WorkerWebSocket): Response {
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function send(ws: WorkerWebSocket, message: unknown): void {
  try {
    ws.send(typeof message === "string" ? message : JSON.stringify(message));
  } catch {
    /* closing or closed: its close handler cleans up */
  }
}

function closeQuietly(ws: WorkerWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

function text(message: string | ArrayBuffer): string {
  return typeof message === "string" ? message : new TextDecoder().decode(message);
}

// ---------------------------------------------------------------------------
// Bastion relay
// ---------------------------------------------------------------------------

interface ClientAttachment {
  role: "client";
  id: string;
}

interface AgentAttachment {
  role: "agent";
  connectedAt: number;
}

/**
 * One per bastion (`idFromName(bastionId)`). Holds the agent's socket and the
 * Node clients' sockets, and multiplexes the clients' streams onto the agent.
 */
export class BastionRelay {
  private readonly mux = new BastionMux();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RealtimeEnv,
  ) {
    // The agent pings every heartbeat; answer without waking the object.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"op":"ping"}', '{"op":"pong"}') as never,
    );
  }

  private agent(): WorkerWebSocket | undefined {
    return this.state.getWebSockets("agent")[0];
  }

  async fetch(request: Request): Promise<Response> {
    switch (request.headers.get(ROLE_HEADER)) {
      case "agent":
        return this.acceptAgent(request);
      case "client":
        return this.acceptClient();
      case "allowlist": {
        const { allowlist } = (await request.json()) as { allowlist: string[] };
        await this.state.storage.put("allowlist", allowlist);
        const agent = this.agent();
        // The agent re-applies whatever allowlist the latest hello carries.
        if (agent) send(agent, this.hello(allowlist));
        return new Response(null, { status: 204 });
      }
      case "status": {
        const agent = this.agent();
        return json(200, {
          connected: Boolean(agent),
          agentVersion: (await this.state.storage.get<string>("agentVersion")) ?? null,
          connectedAt: agent
            ? ((agent.deserializeAttachment() as AgentAttachment).connectedAt ?? null)
            : null,
        });
      }
      default:
        return new Response("unknown role", { status: 400 });
    }
  }

  private hello(allowlist: string[]) {
    return {
      op: "hello",
      protocolVersion: BASTION_PROTOCOL_VERSION,
      allowlist,
      heartbeatMs: BASTION_HEARTBEAT_MS,
    };
  }

  private async acceptAgent(request: Request): Promise<Response> {
    const allowlist = JSON.parse(request.headers.get(ALLOWLIST_HEADER) ?? "[]") as string[];
    // A newer agent connection replaces an older one, as the Node registry did.
    for (const previous of this.state.getWebSockets("agent")) {
      closeQuietly(previous, RELAY_CLOSE_REPLACED, "Replaced by a newer agent connection");
    }
    this.dispatch(this.mux.agentGone());

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server, ["agent"]);
    server.serializeAttachment({
      role: "agent",
      connectedAt: Date.now(),
    } satisfies AgentAttachment);
    await this.state.storage.put("allowlist", allowlist);
    send(server, this.hello(allowlist));
    await this.state.storage.setAlarm(Date.now() + AGENT_CHECK_MS);
    return upgradeResponse(client);
  }

  private acceptClient(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server, ["client"]);
    server.serializeAttachment({
      role: "client",
      id: crypto.randomUUID(),
    } satisfies ClientAttachment);
    send(server, { op: "relay-status", agentConnected: Boolean(this.agent()) });
    return upgradeResponse(client);
  }

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: BastionMessage;
    try {
      parsed = JSON.parse(text(message)) as BastionMessage;
    } catch {
      return;
    }
    const attachment = ws.deserializeAttachment() as AgentAttachment | ClientAttachment | null;
    if (attachment?.role === "agent") {
      if (parsed.op === "pong" || parsed.op === "ping") {
        if (parsed.op === "ping") send(ws, { op: "pong" });
        return;
      }
      if (parsed.op === "agent-info") {
        await this.state.storage.put("agentVersion", parsed.agentVersion);
        return;
      }
      this.dispatch(this.mux.fromAgent(parsed));
      return;
    }
    if (attachment?.role === "client") {
      this.dispatch(this.mux.fromClient(attachment.id, parsed, Boolean(this.agent())));
    }
  }

  async webSocketClose(ws: WorkerWebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as AgentAttachment | ClientAttachment | null;
    if (attachment?.role === "agent") {
      // Only the current agent's departure matters; a replaced one is already gone.
      if (this.state.getWebSockets("agent").some((other) => other !== ws)) return;
      this.dispatch(this.mux.agentGone());
      // Clients drop their cached connection on close and reconnect on the
      // next request, which then fails fast with "agent disconnected".
      for (const client of this.state.getWebSockets("client")) {
        closeQuietly(client, RELAY_CLOSE_UNAVAILABLE, "Bastion agent disconnected");
      }
      return;
    }
    if (attachment?.role === "client") this.dispatch(this.mux.clientGone(attachment.id));
  }

  async webSocketError(ws: WorkerWebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Close an agent that has stopped pinging. */
  async alarm(): Promise<void> {
    const agent = this.agent();
    if (!agent) return;
    const lastPing = this.state.getWebSocketAutoResponseTimestamp(agent)?.getTime();
    const connectedAt = (agent.deserializeAttachment() as AgentAttachment).connectedAt;
    const lastSign = Math.max(lastPing ?? 0, connectedAt ?? 0);
    if (Date.now() - lastSign > BASTION_HEARTBEAT_MS * 3) {
      closeQuietly(agent, 1011, "heartbeat timeout");
      await this.webSocketClose(agent);
      return;
    }
    await this.state.storage.setAlarm(Date.now() + AGENT_CHECK_MS);
  }

  private dispatch(outputs: MuxOutput[]): void {
    if (outputs.length === 0) return;
    const agent = this.agent();
    const clients = new Map<string, WorkerWebSocket>();
    for (const ws of this.state.getWebSockets("client")) {
      clients.set((ws.deserializeAttachment() as ClientAttachment).id, ws);
    }
    for (const output of outputs) {
      const target = output.to === "agent" ? agent : clients.get(output.client);
      if (target) send(target, output.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Console relay
// ---------------------------------------------------------------------------

interface ViewerAttachment {
  role: "viewer";
  viewer: string;
  participantId: string;
}

interface PendingCall {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One per live SSH console (`idFromName(liveConsoleId)`). The owning replica's
 * host socket, bridged guests' sockets, and calls from other replicas.
 */
export class ConsoleRelay {
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RealtimeEnv,
  ) {}

  private host(): WorkerWebSocket | undefined {
    return this.state.getWebSockets("host")[0];
  }

  async fetch(request: Request): Promise<Response> {
    switch (request.headers.get(ROLE_HEADER)) {
      case "host": {
        for (const previous of this.state.getWebSockets("host")) {
          closeQuietly(previous, RELAY_CLOSE_REPLACED, "Replaced by a newer host link");
        }
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        this.state.acceptWebSocket(server, ["host"]);
        server.serializeAttachment({ role: "host" });
        return upgradeResponse(client);
      }
      case "rpc":
        return this.call(request);
      case "viewer": {
        const host = this.host();
        // No host: the console is not live anywhere. The bridging replica
        // reports `console_not_here`, as a local miss always did.
        if (!host) return new Response("no host", { status: 404 });
        const participantId = new URL(request.url).searchParams.get("participant") ?? "";
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        const viewer = crypto.randomUUID();
        this.state.acceptWebSocket(server, ["viewer"]);
        server.serializeAttachment({
          role: "viewer",
          viewer,
          participantId,
        } satisfies ViewerAttachment);
        send(host, { op: "viewer-open", viewer, participantId } satisfies ConsoleRelayToHost);
        return upgradeResponse(client);
      }
      default:
        return new Response("unknown role", { status: 400 });
    }
  }

  private async call(request: Request): Promise<Response> {
    const host = this.host();
    if (!host) return json(404, { ok: false, error: "no-host" });
    const { method, args } = (await request.json()) as {
      method: ConsoleRpcMethod;
      args: unknown[];
    };
    const id = crypto.randomUUID();
    const answered = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(json(504, { ok: false, error: "host-timeout" }));
      }, CONSOLE_RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
    });
    send(host, { op: "rpc", id, method, args } satisfies ConsoleRelayToHost);
    return answered;
  }

  private viewers(): Map<string, WorkerWebSocket> {
    const out = new Map<string, WorkerWebSocket>();
    for (const ws of this.state.getWebSockets("viewer")) {
      out.set((ws.deserializeAttachment() as ViewerAttachment).viewer, ws);
    }
    return out;
  }

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = text(message);
    const attachment = ws.deserializeAttachment() as { role: string } | null;
    if (attachment?.role === "viewer") {
      const host = this.host();
      if (host) {
        send(host, {
          op: "viewer-frame",
          viewer: (attachment as ViewerAttachment).viewer,
          data: raw,
        } satisfies ConsoleRelayToHost);
      }
      return;
    }
    if (attachment?.role !== "host") return;
    let parsed: ConsoleHostToRelay;
    try {
      parsed = JSON.parse(raw) as ConsoleHostToRelay;
    } catch {
      return;
    }
    switch (parsed.op) {
      case "rpc-result": {
        const call = this.pending.get(parsed.id);
        if (!call) return;
        this.pending.delete(parsed.id);
        clearTimeout(call.timer);
        call.resolve(json(parsed.ok ? 200 : 500, parsed));
        return;
      }
      case "to-viewer": {
        const viewer = this.viewers().get(parsed.viewer);
        if (viewer) send(viewer, parsed.data);
        return;
      }
      case "close-viewer": {
        const viewer = this.viewers().get(parsed.viewer);
        if (viewer) closeQuietly(viewer, 1000, "detached");
        return;
      }
    }
  }

  async webSocketClose(ws: WorkerWebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as { role: string } | null;
    if (attachment?.role === "viewer") {
      const host = this.host();
      if (host) {
        send(host, {
          op: "viewer-gone",
          viewer: (attachment as ViewerAttachment).viewer,
        } satisfies ConsoleRelayToHost);
      }
      return;
    }
    if (attachment?.role === "host") {
      if (this.state.getWebSockets("host").some((other) => other !== ws)) return;
      for (const viewer of this.state.getWebSockets("viewer")) {
        closeQuietly(viewer, RELAY_CLOSE_UNAVAILABLE, "The session ended.");
      }
      for (const [id, call] of this.pending) {
        clearTimeout(call.timer);
        call.resolve(json(404, { ok: false, error: "no-host" }));
        this.pending.delete(id);
      }
    }
  }

  async webSocketError(ws: WorkerWebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Constant-time comparison of the relay secret. */
function secretMatches(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function toObject(
  namespace: DurableObjectNamespace,
  name: string,
  request: Request,
  role: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(ROLE_HEADER, role);
  headers.delete(REALTIME_SECRET_HEADER);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  const stub = namespace.get(namespace.idFromName(name));
  return stub.fetch(new Request(request, { headers }) as never) as unknown as Promise<Response>;
}

/** What the router needs from the server, loaded only for agent connects. */
export interface AgentAuthenticator {
  (token: string): Promise<{ bastionId: string; allowlist: string[] } | null>;
}

/**
 * Handle the relay's paths, or return null for everything else. The agent
 * path is public (the agent authenticates with its enrollment token); every
 * `/api/realtime/*` path requires the relay secret and is otherwise a 404.
 */
export async function handleRealtime(
  request: Request,
  env: RealtimeEnv,
  _ctx: ExecutionContext,
  authenticateAgent: () => Promise<AgentAuthenticator>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";

  if (url.pathname === BASTION_AGENT_PATH) {
    if (!isUpgrade) return new Response("Expected a WebSocket upgrade", { status: 426 });
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return new Response("Unauthorized", { status: 401 });
    const agent = await (await authenticateAgent())(token);
    if (!agent) return new Response("Unauthorized", { status: 401 });
    return toObject(env.BASTION_RELAY, agent.bastionId, request, "agent", {
      [ALLOWLIST_HEADER]: JSON.stringify(agent.allowlist),
    });
  }

  if (!url.pathname.startsWith(`${REALTIME_PREFIX}/`)) return null;
  if (!secretMatches(request.headers.get(REALTIME_SECRET_HEADER), env.INTERNAL_RELAY_SECRET)) {
    return new Response("Not found", { status: 404 });
  }

  const parts = url.pathname
    .slice(REALTIME_PREFIX.length + 1)
    .split("/")
    .map(decodeURIComponent);
  const [kind, id, action] = parts;

  if (kind === "bastions" && id === "status" && request.method === "POST") {
    const { ids } = (await request.json()) as { ids: string[] };
    const statuses = await Promise.all(
      ids.map(async (bastionId) => {
        // A fresh request per object: this one's body has already been read.
        const ask = new Request(`${url.origin}${REALTIME_PREFIX}/bastions/${bastionId}`, {
          method: "GET",
        });
        const response = await toObject(env.BASTION_RELAY, bastionId, ask, "status");
        return [bastionId, await response.json()] as const;
      }),
    );
    return json(200, Object.fromEntries(statuses));
  }
  if (kind === "bastions" && id) {
    if (!action && isUpgrade) return toObject(env.BASTION_RELAY, id, request, "client");
    if (action === "allowlist" && request.method === "POST") {
      return toObject(env.BASTION_RELAY, id, request, "allowlist");
    }
  }
  if (kind === "consoles" && id) {
    if (action === "host" && isUpgrade) return toObject(env.CONSOLE_RELAY, id, request, "host");
    if (action === "viewer" && isUpgrade) return toObject(env.CONSOLE_RELAY, id, request, "viewer");
    if (action === "rpc" && request.method === "POST") {
      return toObject(env.CONSOLE_RELAY, id, request, "rpc");
    }
  }
  return new Response("Not found", { status: 404 });
}
