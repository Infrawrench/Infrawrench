import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { WebContents } from "electron";
import { resolveBinaryPath } from "./pty";

interface K8sPortForwardConfig {
  kubeconfig: string;
  namespace: string;
  resourceType: "svc" | "pod" | "deploy";
  resourceName: string;
  /** Remote port to forward */
  remotePort: number;
  /** Local port (0 = pick a random available port) */
  localPort?: number;
}

interface K8sPortForwardSession {
  proc: ChildProcess;
  tmpDir: string;
  webContents: WeakRef<WebContents>;
  localPort: number;
  remotePort: number;
  resourceName: string;
  namespace: string;
  resourceType: string;
}

const sessions = new Map<string, K8sPortForwardSession>();

export async function startPortForward(
  webContents: WebContents,
  config: K8sPortForwardConfig,
): Promise<{ sessionId: string; localPort: number }> {
  const id = randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-k8s-pf-"));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, config.kubeconfig, { mode: 0o600 });

  // Use 0 to let kubectl pick a free port, otherwise use the specified port
  const localPort = config.localPort ?? 0;

  const args = [
    "port-forward",
    `${config.resourceType}/${config.resourceName}`,
    `${localPort}:${config.remotePort}`,
    "-n",
    config.namespace,
    "--kubeconfig",
    kubeconfigPath,
  ];

  let proc: ChildProcess;
  try {
    proc = spawn(resolveBinaryPath("kubectl"), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
    throw new Error(
      `Failed to launch kubectl port-forward: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Parse the actual local port from kubectl's stdout output:
  // "Forwarding from 127.0.0.1:12345 -> 80"
  const resolvedPort = await new Promise<number>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for kubectl port-forward to start"));
      proc.kill();
      cleanup(id);
    }, 15_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const match = stdoutBuf.match(/Forwarding from (?:127\.0\.0\.1|\[::1]):(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `kubectl port-forward exited with code ${code}: ${stderrBuf.trim() || "(no output)"}`,
          ),
        );
      }
    });
  });

  sessions.set(id, {
    proc,
    tmpDir,
    webContents: new WeakRef(webContents),
    localPort: resolvedPort,
    remotePort: config.remotePort,
    resourceName: config.resourceName,
    namespace: config.namespace,
    resourceType: config.resourceType,
  });

  const send = (channel: string) => {
    const wc = sessions.get(id)?.webContents.deref();
    if (wc && !wc.isDestroyed()) wc.send(channel);
  };

  proc.on("exit", () => {
    send(`k8s_pf_exit_${id}`);
    cleanup(id);
  });

  return { sessionId: id, localPort: resolvedPort };
}

function cleanup(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  try {
    fs.rmSync(session.tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore temp cleanup failures.
  }
  sessions.delete(id);
}

export function stopPortForward(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.proc.kill();
  cleanup(id);
}

export function listPortForwards(): Array<{
  sessionId: string;
  localPort: number;
  remotePort: number;
  resourceName: string;
  namespace: string;
  resourceType: string;
}> {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    sessionId: id,
    localPort: s.localPort,
    remotePort: s.remotePort,
    resourceName: s.resourceName,
    namespace: s.namespace,
    resourceType: s.resourceType,
  }));
}
