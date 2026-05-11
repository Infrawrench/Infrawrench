/**
 * Server-side Kubernetes pod exec proxy.
 * Spawns `kubectl exec` via node-pty (real PTY) and streams I/O over WebSocket.
 *
 * Architecture: the kubeconfig stays server-side (never sent to the browser).
 * The browser sends a k8s:exec:open message identifying the peer integration,
 * and the server resolves the kubeconfig, spawns kubectl, and proxies I/O.
 *
 * Most of the plumbing (kubeconfig tempfile, PTY lifecycle, WS message loop)
 * lives in `kubectl-pty-session.ts` and is shared with the k9s proxy.
 */
import type { WebSocket } from "ws";
import { handleKubectlPtySession } from "./kubectl-pty-session";

interface K8sExecConfig {
  kubeconfig: string;
  namespace: string;
  podName: string;
  containerName?: string | undefined;
  cols: number;
  rows: number;
}

export async function handleK8sExecSession(ws: WebSocket, config: K8sExecConfig): Promise<void> {
  await handleKubectlPtySession(
    ws,
    { kubeconfig: config.kubeconfig, cols: config.cols, rows: config.rows },
    {
      binary: "kubectl",
      buildArgs: (kubeconfigPath) => {
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
        return args;
      },
    },
    {
      connected: "k8s:exec:connected",
      data: "k8s:exec:data",
      closed: "k8s:exec:closed",
      error: "k8s:exec:error",
      resize: "k8s:exec:resize",
    },
  );
}
