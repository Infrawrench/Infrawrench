/**
 * Reaching a bastion agent that is not connected to this process, through its
 * relay object (`realtime/protocol.ts`).
 *
 * The client socket speaks the agent protocol unchanged, so the connection is
 * an ordinary {@link BastionAgentConnection} whose socket happens to end at
 * the relay: same stream table, same undici dispatcher, same allowlist check.
 * One per bastion per process, opened on first use and kept until the relay
 * closes it (the agent left) or it fails; the next request reconnects.
 */
import type { Dispatcher } from "undici";
import { BastionAgentConnection } from "./dispatcher.js";
import type { BastionMessage } from "./protocol.js";
import { realtimeEnabled, realtimeHeaders, realtimeWsUrl } from "../realtime/client.js";
import { bastionClientPath, type BastionRelayStatusMessage } from "../realtime/protocol.js";

/** How long to wait for the relay to answer a new client socket. */
const CONNECT_TIMEOUT_MS = 10_000;

const remotes = new Map<string, Promise<BastionAgentConnection | null>>();

/**
 * The dispatcher for a bastion whose agent is connected to the relay, or null
 * when it is not (offline, or the relay is off). `allowlist` is what the
 * caller already knows the agent permits; the relay enforces it again agent-side.
 */
export async function remoteDispatcherFor(
  bastionId: string,
  allowlist: () => Promise<string[]>,
): Promise<Dispatcher | null> {
  if (!realtimeEnabled()) return null;
  let pending = remotes.get(bastionId);
  if (!pending) {
    pending = connect(bastionId, allowlist).catch((err: unknown) => {
      console.error(
        `[bastion] relay connection for ${bastionId} failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    remotes.set(bastionId, pending);
    void pending.then((conn) => {
      if (!conn && remotes.get(bastionId) === pending) remotes.delete(bastionId);
    });
  }
  const conn = await pending;
  return conn?.dispatcher ?? null;
}

/** Push a new allowlist to an already open remote connection, if any. */
export async function updateRemoteAllowlist(bastionId: string, allowlist: string[]): Promise<void> {
  const conn = await remotes.get(bastionId);
  conn?.setAllowlist(allowlist);
}

async function connect(
  bastionId: string,
  allowlist: () => Promise<string[]>,
): Promise<BastionAgentConnection | null> {
  // Loaded on use: this module is bundled into the edge Worker (through the
  // registry), which never opens a relay client and must not evaluate `ws`.
  const { default: WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(realtimeWsUrl(bastionClientPath(bastionId)), {
      headers: realtimeHeaders(),
    });
    let conn: BastionAgentConnection | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error("relay did not answer"));
    }, CONNECT_TIMEOUT_MS);

    const finish = (value: BastionAgentConnection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    ws.on("message", (data) => {
      let msg: BastionMessage | BastionRelayStatusMessage;
      try {
        msg = JSON.parse(data.toString()) as BastionMessage | BastionRelayStatusMessage;
      } catch {
        return;
      }
      if (msg.op === "relay-status") {
        if (!msg.agentConnected) {
          ws.close();
          finish(null);
          return;
        }
        if (conn) return;
        const ready = new BastionAgentConnection(bastionId, ws as never);
        void allowlist()
          .then((hosts) => {
            ready.setAllowlist(hosts);
            conn = ready;
            finish(ready);
          })
          .catch((err: unknown) => {
            ws.close();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        return;
      }
      conn?.handleMessage(msg);
    });

    ws.on("close", () => {
      if (remotes.get(bastionId)) remotes.delete(bastionId);
      void conn?.destroy(new Error("Bastion relay connection closed"));
      finish(null);
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** Tests and shutdown: drop every remote connection. */
export async function destroyAllRemoteConnections(): Promise<void> {
  const all = await Promise.all([...remotes.values()]);
  remotes.clear();
  await Promise.all(all.map((conn) => conn?.destroy()));
}
