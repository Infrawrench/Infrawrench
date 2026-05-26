/**
 * WebSocket endpoint that bastion-agent containers connect to. Authenticates
 * with the enrollment token presented in `Authorization: Bearer <token>`,
 * registers the connection with the in-process registry, ships the destination
 * allowlist, and forwards multiplex messages to/from the dispatcher.
 *
 * Wire protocol lives in `@infrawrench/server-core/bastion/protocol`; the
 * dispatcher and stream-multiplex live in `@infrawrench/server-core/bastion/dispatcher`.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { bastionVms } from "@infrawrench/server-core/db/schema";
import { keyedHash } from "@infrawrench/server-core/encryption";
import {
  BastionAgentConnection,
  registerAgentConnection,
  unregisterAgentConnection,
  findBastionByHashedToken,
} from "@infrawrench/server-core/bastion/registry";
import {
  BASTION_PROTOCOL_VERSION,
  type BastionMessage,
} from "@infrawrench/server-core/bastion/protocol";

const BASTION_TOKEN_HASH_DOMAIN = "bastion-agent";

/** Per-connection heartbeat in ms. Anything past 2× this without traffic kills the connection. */
const HEARTBEAT_MS = 25_000;

const wss = new WebSocketServer({ noServer: true });

/**
 * Authenticate an incoming WS upgrade by Bearer token. Returns the bastion row
 * if the token is valid, else `null`. Used by `server.ts` before promoting
 * the socket to a WebSocket.
 */
export async function authenticateBastionAgent(
  req: IncomingMessage,
): Promise<{ bastionId: string; organizationId: string } | null> {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return null;
  const hashedToken = await keyedHash(token, BASTION_TOKEN_HASH_DOMAIN);
  const row = await findBastionByHashedToken(hashedToken);
  if (!row) return null;
  return { bastionId: row.id, organizationId: row.organizationId };
}

/** Promote the upgraded socket to a managed bastion-agent WebSocket. */
export function handleBastionAgentUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  bastion: { bastionId: string; organizationId: string },
): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    setupBastionAgentSocket(ws, bastion);
  });
}

function setupBastionAgentSocket(
  ws: WebSocket,
  bastion: { bastionId: string; organizationId: string },
): void {
  const conn = new BastionAgentConnection(bastion.bastionId, ws);
  let registered = false;

  // Mark the bastion active on first connect; we mark it again on every
  // message to keep `lastSeenAt` fresh (cheap because it's a single UPDATE).
  void markActive(bastion.bastionId).catch((err: unknown) => {
    console.error(`[bastion] markActive failed for ${bastion.bastionId}:`, err);
  });

  // Heartbeat — kill the connection if we don't hear a pong in time.
  let lastSeenMs = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Date.now() - lastSeenMs;
    if (elapsed > HEARTBEAT_MS * 2) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      return;
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ op: "ping" }));
    }
  }, HEARTBEAT_MS);

  ws.on("message", (data) => {
    lastSeenMs = Date.now();
    let msg: BastionMessage;
    try {
      msg = JSON.parse(data.toString()) as BastionMessage;
    } catch {
      return;
    }
    if (msg.op === "ping") {
      ws.send(JSON.stringify({ op: "pong" }));
      return;
    }
    if (msg.op === "pong") return;
    if (msg.op === "agent-info") {
      void db
        .update(bastionVms)
        .set({ agentVersion: msg.agentVersion, lastSeenAt: new Date() })
        .where(eq(bastionVms.id, bastion.bastionId))
        .catch((err: unknown) => {
          console.error(`[bastion] agent-info update failed for ${bastion.bastionId}:`, err);
        });
      return;
    }
    // Everything else (opened/data/closed/open-failed) is for the dispatcher.
    conn.handleMessage(msg);
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (registered) {
      void unregisterAgentConnection(bastion.bastionId);
    }
  });

  ws.on("error", () => {
    /* close handler will fire next */
  });

  // Register + send hello in one shot. registerAgentConnection populates the
  // allowlist by querying which accounts reference this bastion.
  void registerAgentConnection(conn)
    .then(() => {
      registered = true;
      ws.send(
        JSON.stringify({
          op: "hello",
          protocolVersion: BASTION_PROTOCOL_VERSION,
          allowlist: conn.currentAllowlist(),
          heartbeatMs: HEARTBEAT_MS,
        }),
      );
    })
    .catch((err) => {
      console.error(
        `[bastion] registration failed for ${bastion.bastionId}:`,
        err instanceof Error ? err.message : err,
      );
      ws.close(1011, "registration failed");
    });
}

async function markActive(bastionId: string): Promise<void> {
  await db
    .update(bastionVms)
    .set({ status: "active", lastSeenAt: new Date() })
    .where(eq(bastionVms.id, bastionId));
}
