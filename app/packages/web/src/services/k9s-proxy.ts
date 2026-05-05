/**
 * Server-side k9s proxy.
 * Spawns `k9s` via node-pty (for full PTY semantics) and streams I/O over
 * WebSocket. Kubeconfig is written to a temp file and never sent to the
 * browser. If the k9s binary is missing on PATH we emit a `k9s:error` frame
 * with the string "k9s:unavailable" so the desktop can surface a clear UI.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { WebSocket } from "ws";

interface K9sConfig {
  kubeconfig: string;
  namespace?: string;
  cols: number;
  rows: number;
}

interface K9sSession {
  proc: import("node-pty").IPty;
  tmpDir: string;
}

const activeSessions = new Map<string, K9sSession>();

export async function handleK9sSession(ws: WebSocket, config: K9sConfig): Promise<void> {
  const sessionId = crypto.randomUUID();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-k9s-"));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, config.kubeconfig, { mode: 0o600 });

  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (err) {
    cleanup(tmpDir);
    ws.send(
      JSON.stringify({
        type: "k9s:error",
        error: `node-pty not available: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return;
  }

  const args = ["--kubeconfig", kubeconfigPath];
  if (config.namespace) args.push("--namespace", config.namespace);

  let proc: import("node-pty").IPty;
  try {
    proc = pty.spawn("k9s", args, {
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
    const isMissing = /ENOENT|not found|spawn k9s/i.test(msg);
    ws.send(
      JSON.stringify({
        type: "k9s:error",
        error: isMissing ? "k9s:unavailable" : `Failed to launch k9s: ${msg}`,
      }),
    );
    return;
  }

  activeSessions.set(sessionId, { proc, tmpDir });
  ws.send(JSON.stringify({ type: "k9s:connected", sessionId }));

  proc.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({ type: "k9s:data", data: Buffer.from(data, "utf8").toString("base64") }),
      );
    }
  });

  proc.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "k9s:closed", code: exitCode }));
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
      if (msg.type === "k9s:data" && msg.data) {
        proc.write(Buffer.from(msg.data, "base64").toString("utf8"));
      } else if (msg.type === "k9s:resize" && msg.cols && msg.rows) {
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
