/**
 * Shared "spawn a Kubernetes-related binary in a PTY and proxy I/O over
 * WebSocket" helper. Backs both `kubectl exec -it` (k8s-exec-proxy) and
 * `k9s` (k9s-proxy). The kubeconfig is checked against the server
 * kubeconfig policy, written to a temp file and never shipped to the
 * browser; the child gets a minimal environment (see `./kube-child`).
 *
 * A PTY is required because both binaries check that stdin is a TTY; a
 * plain pipe yields "Unable to use a TTY - input is not a terminal" for
 * kubectl exec and a broken UI for k9s.
 */
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { WebSocket } from "ws";
import { kubeChildEnv, writeServerKubeconfig, type KubeconfigDir } from "./kube-child";
import { makeWsBackpressure } from "./ws-backpressure";

interface KubectlPtyMessageTypes {
  /** Server → client when the PTY is ready (k8s-exec only). May be undefined. */
  connected?: string;
  /** Bidirectional data frame type. */
  data: string;
  /** Server → client on PTY exit. */
  closed: string;
  /** Server → client on launch failure. */
  error: string;
  /** Client → server resize frame type. */
  resize: string;
}

interface KubectlPtyConfig {
  kubeconfig: string;
  cols: number;
  rows: number;
}

interface KubectlPtySpawn {
  binary: string;
  /** Build argv given the kubeconfig path (so the path can be inlined as `--kubeconfig`). */
  buildArgs: (kubeconfigPath: string) => string[];
  /**
   * If launch fails and the error message looks like a missing-binary error,
   * rewrite it to this string. Use case: k9s emits `"k9s:unavailable"` so the
   * desktop can show a clear install link.
   */
  unavailableMarker?: string;
}

interface PtySession {
  proc: import("node-pty").IPty;
  tmpDir: string;
}

const activeSessions = new Map<string, PtySession>();

export async function handleKubectlPtySession(
  ws: WebSocket,
  config: KubectlPtyConfig,
  spawn: KubectlPtySpawn,
  messageTypes: KubectlPtyMessageTypes,
): Promise<void> {
  const sessionId = crypto.randomUUID();

  let kubeDir: KubeconfigDir;
  try {
    kubeDir = writeServerKubeconfig("iw-kube-", config.kubeconfig);
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: messageTypes.error,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  const { tmpDir, kubeconfigPath } = kubeDir;

  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (err) {
    cleanup(tmpDir);
    ws.send(
      JSON.stringify({
        type: messageTypes.error,
        error: `node-pty not available: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return;
  }

  let proc: import("node-pty").IPty;
  try {
    proc = pty.spawn(spawn.binary, spawn.buildArgs(kubeconfigPath), {
      name: "xterm-256color",
      cols: config.cols,
      rows: config.rows,
      env: kubeChildEnv(kubeDir),
    });
  } catch (err) {
    cleanup(tmpDir);
    const msg = err instanceof Error ? err.message : String(err);
    const isMissing = new RegExp(`ENOENT|not found|spawn ${spawn.binary}`, "i").test(msg);
    const errorText =
      isMissing && spawn.unavailableMarker
        ? spawn.unavailableMarker
        : `Failed to launch ${spawn.binary}: ${msg}`;
    ws.send(JSON.stringify({ type: messageTypes.error, error: errorText }));
    return;
  }

  activeSessions.set(sessionId, { proc, tmpDir });
  if (messageTypes.connected) {
    ws.send(JSON.stringify({ type: messageTypes.connected, sessionId }));
  }

  const backpressure = makeWsBackpressure(ws, {
    pause: () => proc.pause(),
    resume: () => proc.resume(),
  });

  proc.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: messageTypes.data,
          data: Buffer.from(data, "utf8").toString("base64"),
        }),
      );
      backpressure.check();
    }
  });

  proc.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: messageTypes.closed, code: exitCode }));
    }
    backpressure.dispose();
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
      if (msg.type === messageTypes.data && msg.data) {
        proc.write(Buffer.from(msg.data, "base64").toString("utf8"));
      } else if (msg.type === messageTypes.resize && msg.cols && msg.rows) {
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
    backpressure.dispose();
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
