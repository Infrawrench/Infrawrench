import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { spawn, type IPty } from "node-pty";
import type { K8sExecConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { buildPtyEnv, ensureNodePtySpawnHelperExecutable, resolveBinaryPath } from "./pty";

interface K8sExecSession {
  proc: IPty;
  tmpDir: string;
  webContents: WeakRef<WebContents>;
}

const sessions = new Map<string, K8sExecSession>();

export async function spawnK8sExec(
  webContents: WebContents,
  config: K8sExecConfig,
): Promise<string> {
  const id = randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-k8s-"));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, config.kubeconfig, { mode: 0o600 });

  const args = [
    "exec",
    "-it",
    config.podName,
    "-n",
    config.namespace,
    "--kubeconfig",
    kubeconfigPath,
    "--",
    "/bin/sh",
  ];
  if (config.containerName) args.splice(3, 0, "-c", config.containerName);

  let proc: IPty;
  try {
    ensureNodePtySpawnHelperExecutable();
    proc = spawn(resolveBinaryPath("kubectl"), args, {
      name: "xterm-256color",
      cols: config.cols,
      rows: config.rows,
      env: buildPtyEnv(config.cols, config.rows),
    });
  } catch (error) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
    throw new Error(
      `Failed to launch kubectl exec: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  sessions.set(id, { proc, tmpDir, webContents: new WeakRef(webContents) });

  const send = (channel: string, data?: Buffer) => {
    const wc = sessions.get(id)?.webContents.deref();
    if (wc && !wc.isDestroyed()) {
      if (data) wc.send(channel, data);
      else wc.send(channel);
    }
  };

  proc.onData((data) => {
    send(`k8s_exec_data_${id}`, Buffer.from(data, "utf8"));
  });
  proc.onExit(() => {
    send(`k8s_exec_exit_${id}`);
    cleanup(id);
  });

  return id;
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

export function writeK8sExec(id: string, data: string) {
  sessions.get(id)?.proc.write(data);
}

export function resizeK8sExec(id: string, cols: number, rows: number) {
  sessions.get(id)?.proc.resize(cols, rows);
}

export function killK8sExec(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.proc.kill();
  cleanup(id);
}

export function killAllK8sExecs() {
  for (const id of [...sessions.keys()]) killK8sExec(id);
}
