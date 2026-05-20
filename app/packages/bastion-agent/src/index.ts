/**
 * Infrawrench bastion agent.
 *
 * Dials outbound over WSS to the Infrawrench backend with an enrollment
 * token, then opens TCP streams (one per cloud-API call) on demand. The
 * agent is intentionally tiny — it doesn't terminate TLS, doesn't see
 * credentials, doesn't have an inbound listener, and only opens
 * destinations the backend allowlists at hello time.
 *
 * Required env:
 *   - BASTION_TOKEN     `iwb_…` enrollment token created in the UI.
 *   - INFRAWRENCH_URL   wss://your-infrawrench.example.com/api/bastions/agent
 *
 * Optional:
 *   - HEARTBEAT_TIMEOUT_MS  Override the dead-peer timeout (default 60s).
 *   - VERBOSE               Set to `1` for per-stream open/close logging.
 */

import * as net from "node:net";
import { WebSocket } from "ws";

const AGENT_VERSION = "0.1.0";
const SUBPROTOCOL = "infrawrench-bastion-v1";
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

type ProtocolMessage =
  | { op: "hello"; protocolVersion: number; allowlist: string[]; heartbeatMs: number }
  | { op: "open"; streamId: number; host: string; port: number }
  | { op: "data"; streamId: number; data: string }
  | { op: "end"; streamId: number }
  | { op: "close"; streamId: number; reason?: string }
  | { op: "opened"; streamId: number }
  | { op: "open-failed"; streamId: number; reason: string }
  | { op: "ping" }
  | { op: "pong" }
  | { op: "agent-info"; agentVersion: string };

const token = required("BASTION_TOKEN");
const url = required("INFRAWRENCH_URL");
const heartbeatTimeoutMs = Number(
  process.env["HEARTBEAT_TIMEOUT_MS"] ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
);
const verbose = process.env["VERBOSE"] === "1";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[bastion-agent] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function log(...args: unknown[]): void {
  console.log(`[bastion-agent ${new Date().toISOString()}]`, ...args);
}

function vlog(...args: unknown[]): void {
  if (verbose) log(...args);
}

class Connection {
  private ws: WebSocket;
  private streams = new Map<number, net.Socket>();
  private allowlist: string[] = [];
  private allowlistSuffixes: string[] = [];
  private lastSeenMs = Date.now();
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  private onClose: () => void;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    log(`connecting to ${url}`);
    this.ws = new WebSocket(url, [SUBPROTOCOL], {
      headers: { authorization: `Bearer ${token}` },
    });
    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    this.ws.on("error", (err) => log("ws error:", err.message));
  }

  private handleOpen(): void {
    log("WebSocket connected; awaiting hello");
    this.lastSeenMs = Date.now();
    this.send({ op: "agent-info", agentVersion: AGENT_VERSION });
    this.heartbeat = setInterval(() => this.tickHeartbeat(), 10_000);
  }

  private tickHeartbeat(): void {
    if (this.closed) return;
    if (Date.now() - this.lastSeenMs > heartbeatTimeoutMs) {
      log("heartbeat timeout — closing");
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
      return;
    }
    this.send({ op: "ping" });
  }

  private handleMessage(raw: string): void {
    this.lastSeenMs = Date.now();
    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(raw) as ProtocolMessage;
    } catch {
      return;
    }
    switch (msg.op) {
      case "hello":
        this.allowlist = [];
        this.allowlistSuffixes = [];
        for (const h of msg.allowlist) {
          if (h.startsWith("*.")) this.allowlistSuffixes.push(h.slice(1).toLowerCase());
          else this.allowlist.push(h.toLowerCase());
        }
        log(
          `hello received (proto v${msg.protocolVersion}, ${msg.allowlist.length} allowlist entries)`,
        );
        return;
      case "open":
        this.handleOpenStream(msg.streamId, msg.host, msg.port);
        return;
      case "data":
        this.handleDataIn(msg.streamId, msg.data);
        return;
      case "end":
        this.handleEnd(msg.streamId);
        return;
      case "close":
        this.handleStreamClose(msg.streamId, msg.reason);
        return;
      case "ping":
        this.send({ op: "pong" });
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  private handleOpenStream(streamId: number, host: string, port: number): void {
    if (!this.isAllowed(host)) {
      this.send({ op: "open-failed", streamId, reason: `destination not allowlisted: ${host}` });
      return;
    }
    vlog(`open stream ${streamId} → ${host}:${port}`);
    const socket = net.connect({ host, port, allowHalfOpen: true });
    this.streams.set(streamId, socket);
    socket.on("connect", () => {
      this.send({ op: "opened", streamId });
    });
    socket.on("data", (chunk: Buffer) => {
      this.send({ op: "data", streamId, data: chunk.toString("base64") });
    });
    socket.on("end", () => {
      // Remote closed the read side. Surface as a soft close to the backend.
      this.send({ op: "close", streamId });
      this.streams.delete(streamId);
    });
    socket.on("error", (err: Error) => {
      vlog(`stream ${streamId} error: ${err.message}`);
      this.send({ op: "open-failed", streamId, reason: err.message });
      this.streams.delete(streamId);
    });
    socket.on("close", () => {
      this.streams.delete(streamId);
    });
  }

  private handleDataIn(streamId: number, b64: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    s.write(Buffer.from(b64, "base64"));
  }

  private handleEnd(streamId: number): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    s.end();
  }

  private handleStreamClose(streamId: number, reason?: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    if (reason) s.destroy(new Error(reason));
    else s.destroy();
    this.streams.delete(streamId);
  }

  private isAllowed(host: string): boolean {
    const lower = host.toLowerCase();
    if (this.allowlist.includes(lower)) return true;
    for (const suffix of this.allowlistSuffixes) {
      if (lower.endsWith(suffix)) return true;
    }
    return false;
  }

  private send(msg: ProtocolMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      log("send failed:", err instanceof Error ? err.message : err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      this.ws.close();
    } catch {
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [, s] of this.streams) {
      s.destroy();
    }
    this.streams.clear();
    log(`WebSocket closed (code=${code}${reason ? `, reason=${reason}` : ""})`);
    this.onClose();
  }
}

async function main(): Promise<void> {
  let backoffMs = RECONNECT_INITIAL_MS;
  let stopping = false;
  let conn: Connection | null = null;

  const shutdown = (signal: string) => {
    stopping = true;
    log(`received ${signal}, shutting down`);
    // Ask the active connection to close so handleClose runs (destroying
    // streams, clearing the heartbeat) before the forced exit fallback.
    conn?.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const reconnect = () => {
    if (stopping) return;
    log(`reconnecting in ${backoffMs}ms`);
    setTimeout(() => {
      conn = new Connection(() => {
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        reconnect();
      });
      // Reset backoff after a successful sustained connection.
      setTimeout(() => {
        if (!stopping) backoffMs = RECONNECT_INITIAL_MS;
      }, 30_000);
    }, backoffMs);
  };

  conn = new Connection(() => {
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    reconnect();
  });
  void conn;
}

main().catch((err) => {
  console.error("[bastion-agent] fatal:", err);
  process.exit(1);
});
