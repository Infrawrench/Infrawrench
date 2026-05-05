/**
 * Server-side Kubernetes port-forward proxy.
 * Spawns `kubectl port-forward` on the server, opens a single TCP client
 * connection to kubectl's random local port, and relays bytes over the
 * WebSocket as base64-encoded frames.
 *
 * Design tradeoff: one TCP connection per WS. The desktop side opens a
 * fresh WS for each inbound client connection hitting its local listener.
 * This keeps both ends of the relay simple at the cost of a WS per client
 * connection. Fine for the typical psql/mysql/redis-cli use case; a future
 * optimization can multiplex many streams over one WS via stream ids.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";

interface K8sPfConfig {
  kubeconfig: string;
  namespace: string;
  resourceType: string;
  resourceName: string;
  remotePort: number;
}

interface K8sPfSession {
  proc: ChildProcess;
  socket: net.Socket | null;
  tmpDir: string;
}

const activeSessions = new Map<string, K8sPfSession>();

export function handleK8sPfSession(ws: WebSocket, config: K8sPfConfig): void {
  const sessionId = crypto.randomUUID();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-k8s-pf-"));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, config.kubeconfig, { mode: 0o600 });

  const args = [
    "port-forward",
    `${config.resourceType}/${config.resourceName}`,
    `0:${config.remotePort}`,
    "-n",
    config.namespace,
    "--kubeconfig",
    kubeconfigPath,
  ];

  let proc: ChildProcess;
  try {
    proc = spawn("kubectl", args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    cleanup(tmpDir);
    ws.send(
      JSON.stringify({
        type: "k8s:pf:error",
        error: `Failed to launch kubectl: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return;
  }

  activeSessions.set(sessionId, { proc, socket: null, tmpDir });

  let assignedPort: number | null = null;
  let socket: net.Socket | null = null;

  function teardown() {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    cleanupSession(sessionId);
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (assignedPort !== null) return;
    const match = text.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
    if (!match?.[1]) return;
    assignedPort = Number(match[1]);

    socket = net.createConnection({ host: "127.0.0.1", port: assignedPort }, () => {
      const session = activeSessions.get(sessionId);
      if (session) session.socket = socket;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "k8s:pf:ready" }));
      }
    });

    socket.on("data", (data: Buffer) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "k8s:pf:data", data: data.toString("base64") }));
      }
    });

    socket.on("close", () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "k8s:pf:close" }));
      }
      teardown();
    });

    socket.on("error", (err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "k8s:pf:error", error: err.message }));
      }
      teardown();
    });
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    if (assignedPort === null && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "k8s:pf:error", error: chunk.toString("utf8") }));
    }
  });

  proc.on("close", () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "k8s:pf:close" }));
    }
    cleanupSession(sessionId);
  });

  proc.on("error", (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "k8s:pf:error", error: err.message }));
    }
    cleanupSession(sessionId);
  });

  const messageHandler = (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
      if (msg.type === "k8s:pf:data" && msg.data && socket) {
        socket.write(Buffer.from(msg.data, "base64"));
      } else if (msg.type === "k8s:pf:close") {
        teardown();
      }
    } catch {
      /* ignore malformed messages */
    }
  };

  ws.on("message", messageHandler);
  ws.on("close", teardown);
}

function cleanup(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function cleanupSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  cleanup(session.tmpDir);
  activeSessions.delete(sessionId);
}
