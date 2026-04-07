import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { spawn, type IPty } from "node-pty";
import { buildPtyEnv, ensureNodePtySpawnHelperExecutable, resolveBinaryPath } from "./pty";

interface K9sConfig {
  kubeconfig: string;
  namespace?: string;
  cols: number;
  rows: number;
}

interface K9sSession {
  proc: IPty;
  tmpDir: string;
  webContents: WeakRef<WebContents>;
}

const sessions = new Map<string, K9sSession>();

export async function checkK9sInstalled(): Promise<boolean> {
  try {
    ensureNodePtySpawnHelperExecutable();
    resolveBinaryPath("k9s");
    return true;
  } catch {
    return false;
  }
}

export async function spawnK9s(
  webContents: WebContents,
  config: K9sConfig,
): Promise<string> {
  const id = randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iw-k9s-"));
  const kubeconfigPath = path.join(tmpDir, "kubeconfig.yaml");
  fs.writeFileSync(kubeconfigPath, config.kubeconfig, { mode: 0o600 });

  const args = ["--kubeconfig", kubeconfigPath];
  if (config.namespace) args.push("-n", config.namespace);

  let proc: IPty;
  try {
    ensureNodePtySpawnHelperExecutable();
    proc = spawn(resolveBinaryPath("k9s"), args, {
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
    throw new Error(`Failed to launch k9s: ${error instanceof Error ? error.message : String(error)}`);
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
    send(`k9s_data_${id}`, Buffer.from(data, "utf8"));
  });
  proc.onExit(() => {
    send(`k9s_exit_${id}`);
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

export function writeK9s(id: string, data: string) {
  sessions.get(id)?.proc.write(data);
}

export function resizeK9s(id: string, cols: number, rows: number) {
  sessions.get(id)?.proc.resize(cols, rows);
}

export function killK9s(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.proc.kill();
  cleanup(id);
}

export function killAllK9sSessions() {
  for (const id of [...sessions.keys()]) killK9s(id);
}
