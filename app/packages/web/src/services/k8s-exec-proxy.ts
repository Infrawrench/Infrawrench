/**
 * Server-side Kubernetes pod exec proxy.
 * Spawns `kubectl exec` via node-pty (real PTY) and streams I/O over WebSocket.
 *
 * Architecture: the kubeconfig stays server-side (never sent to the browser).
 * The browser sends a k8s:exec:open message identifying the peer integration,
 * and the server resolves the kubeconfig, spawns kubectl, and proxies I/O.
 *
 * A PTY is required because `kubectl exec -it` checks that stdin is a TTY; a
 * plain pipe yields "Unable to use a TTY - input is not a terminal" and
 * confuses the SPDY/WebSocket stream demultiplexer ("Unknown stream id 1").
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { WebSocket } from "ws";

interface K8sExecConfig {
  kubeconfig: string;
  namespace: string;
  podName: string;
  containerName?: string | undefined;
  cols: number;
  rows: number;
}

interface K8sExecSession {
  proc: import("node-pty").IPty;
  tmpDir: string;
}

const activeSessions = new Map<string, K8sExecSession>();

export async function handleK8sExecSession(ws: WebSocket, config: K8sExecConfig): Promise<void> {
  const sessionId = crypto.randomUUID();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-k8s-"));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, config.kubeconfig, { mode: 0o600 });

  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (err) {
    cleanup(tmpDir);
    ws.send(
      JSON.stringify({
        type: "k8s:exec:error",
        error: `node-pty not available: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return;
  }

  const args = [
    "exec",
    "-it",
    config.podName,
    "-n",
    config.namespace,
    "--kubeconfig",
    kubeconfigPath,
  ];
  if (config.containerName) args.push("-c", config.containerName);
  args.push("--", "/bin/sh");

  let proc: import("node-pty").IPty;
  try {
    proc = pty.spawn("kubectl", args, {
      name: "xterm-256color",
      cols: config.cols,
      rows: config.rows,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      } as { [key: string]: string },
    });
  } catch (err) {
    cleanup(tmpDir);
    const msg = err instanceof Error ? err.message : String(err);
    ws.send(
      JSON.stringify({
        type: "k8s:exec:error",
        error: `Failed to launch kubectl: ${msg}`,
      }),
    );
    return;
  }

  activeSessions.set(sessionId, { proc, tmpDir });
  ws.send(JSON.stringify({ type: "k8s:exec:connected", sessionId }));

  proc.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "k8s:exec:data",
          data: Buffer.from(data, "utf8").toString("base64"),
        }),
      );
    }
  });

  proc.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "k8s:exec:closed", code: exitCode }));
    }
    cleanupSession(sessionId);
  });

  const messageHandler = (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (msg.type === "k8s:exec:data" && msg.data) {
        proc.write(Buffer.from(msg.data, "base64").toString("utf8"));
      } else if (msg.type === "k8s:exec:resize" && msg.cols && msg.rows) {
        try {
          proc.resize(msg.cols, msg.rows);
        } catch {
          /* ignore resize failures */
        }
      }
    } catch {
      /* ignore malformed messages */
    }
  };

  ws.on("message", messageHandler);

  ws.on("close", () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    cleanupSession(sessionId);
  });
}

function cleanup(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup failures */
  }
}

function cleanupSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  cleanup(session.tmpDir);
  activeSessions.delete(sessionId);
}
