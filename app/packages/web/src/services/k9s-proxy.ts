/**
 * Server-side k9s proxy.
 * Spawns `k9s` via node-pty (for full PTY semantics) and streams I/O over
 * WebSocket. Kubeconfig is written to a temp file and never sent to the
 * browser. If the k9s binary is missing on PATH we emit a `k9s:error` frame
 * with the string "k9s:unavailable" so the desktop can surface a clear UI.
 *
 * The shared PTY+WS plumbing lives in `kubectl-pty-session.ts`.
 */
import type { WebSocket } from "ws";
import { handleKubectlPtySession } from "./kubectl-pty-session";

interface K9sConfig {
  kubeconfig: string;
  namespace?: string;
  cols: number;
  rows: number;
}

export async function handleK9sSession(ws: WebSocket, config: K9sConfig): Promise<void> {
  await handleKubectlPtySession(
    ws,
    { kubeconfig: config.kubeconfig, cols: config.cols, rows: config.rows },
    {
      binary: "k9s",
      buildArgs: (kubeconfigPath) => {
        const args = ["--kubeconfig", kubeconfigPath];
        if (config.namespace) args.push("--namespace", config.namespace);
        return args;
      },
      unavailableMarker: "k9s:unavailable",
    },
    {
      data: "k9s:data",
      closed: "k9s:closed",
      error: "k9s:error",
      resize: "k9s:resize",
    },
  );
}
