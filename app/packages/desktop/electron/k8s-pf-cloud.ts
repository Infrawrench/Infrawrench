/**
 * Electron local listener that fronts the cloud `/api/ws` port-forward proxy.
 *
 * Pattern: the desktop starts a local TCP server on 127.0.0.1:<port> and
 * returns that port to the renderer. For each inbound client connection, it
 * opens a fresh WebSocket to the cloud with a `k8s:pf:open` frame, then
 * pipes bytes bidirectionally (base64 framing on the WS side). One WS per
 * TCP connection — simple, not multiplexed. Fine for the normal case of a
 * single psql/mysql/redis-cli client; if we ever need heavy fan-in we can
 * layer stream ids on top.
 */
import { ipcMain } from "electron";
import * as net from "node:net";
import * as crypto from "node:crypto";
import WebSocket from "ws";
import { CLOUD_URL } from "../env";
import { getAccessToken } from "./cloud-auth";

interface PfCloudStartArgs {
  orgId: string;
  accountId: string;
  resourceId: string;
  peerPluginId: string;
  namespace: string;
  resourceType: string;
  resourceName: string;
  remotePort: number;
  localPort?: number;
}

interface PfCloudSession {
  server: net.Server;
  sockets: Set<net.Socket>;
  webSockets: Set<WebSocket>;
  args: PfCloudStartArgs;
}

const sessions = new Map<string, PfCloudSession>();

function toWsUrl(http: string): string {
  return http.replace(/^http/, "ws");
}

ipcMain.handle(
  "k8s_pf_cloud_start",
  async (event, args: PfCloudStartArgs): Promise<{ sessionId: string; localPort: number }> => {
    const sessionId = crypto.randomUUID();
    const sockets = new Set<net.Socket>();
    const webSockets = new Set<WebSocket>();

    const server = net.createServer((client) => {
      sockets.add(client);
      handleClient(sessionId, client, args, webSockets).catch(() => {
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
      });
      client.on("close", () => {
        sockets.delete(client);
      });
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.localPort ?? 0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Failed to determine local port"));
      });
    });

    sessions.set(sessionId, { server, sockets, webSockets, args });

    server.on("close", () => {
      event.sender.send(`k8s_pf_cloud_exit_${sessionId}`);
    });

    return { sessionId, localPort };
  },
);

ipcMain.handle("k8s_pf_cloud_stop", (_event, { sessionId }: { sessionId: string }) => {
  teardownSession(sessionId);
});

async function mintWsToken(orgId: string): Promise<string | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const res = await fetch(`${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/ws-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string };
  return body.token ?? null;
}

async function handleClient(
  _sessionId: string,
  client: net.Socket,
  args: PfCloudStartArgs,
  webSockets: Set<WebSocket>,
): Promise<void> {
  const token = await mintWsToken(args.orgId);
  if (!token) {
    client.destroy();
    return;
  }

  const wsUrl = `${toWsUrl(CLOUD_URL)}/api/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  webSockets.add(ws);

  const pendingFromClient: Buffer[] = [];
  let ready = false;

  client.on("data", (chunk) => {
    if (!ready) {
      pendingFromClient.push(chunk);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "k8s:pf:data", data: chunk.toString("base64") }));
    }
  });

  client.on("close", () => {
    try {
      ws.send(JSON.stringify({ type: "k8s:pf:close" }));
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    webSockets.delete(ws);
  });

  client.on("error", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    webSockets.delete(ws);
  });

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "k8s:pf:open",
        accountId: args.accountId,
        resourceId: args.resourceId,
        peerPluginId: args.peerPluginId,
        namespace: args.namespace,
        resourceType: args.resourceType,
        resourceName: args.resourceName,
        remotePort: args.remotePort,
      }),
    );
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; data?: string; error?: string };
      if (msg.type === "k8s:pf:ready") {
        ready = true;
        for (const chunk of pendingFromClient) {
          ws.send(JSON.stringify({ type: "k8s:pf:data", data: chunk.toString("base64") }));
        }
        pendingFromClient.length = 0;
      } else if (msg.type === "k8s:pf:data" && msg.data) {
        client.write(Buffer.from(msg.data, "base64"));
      } else if (msg.type === "k8s:pf:close") {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      } else if (msg.type === "k8s:pf:error") {
        try {
          client.destroy(new Error(msg.error ?? "port-forward error"));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore malformed */
    }
  });

  ws.on("close", () => {
    try {
      client.end();
    } catch {
      /* ignore */
    }
    webSockets.delete(ws);
  });

  ws.on("error", () => {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
    webSockets.delete(ws);
  });
}

function teardownSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);

  for (const sock of session.sockets) {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  }
  for (const ws of session.webSockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  try {
    session.server.close();
  } catch {
    /* ignore */
  }
}

export function teardownAllPfCloudSessions(): void {
  for (const id of Array.from(sessions.keys())) teardownSession(id);
}
