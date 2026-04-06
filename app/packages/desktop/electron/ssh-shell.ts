import * as crypto from "node:crypto";
import { Client as SshClient } from "ssh2";
import type { WebContents } from "electron";

export interface SshShellConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  cols: number;
  rows: number;
}

interface ShellRecord {
  // ssh2 ClientChannel — typed loosely to avoid pulling in full ssh2 types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: any;
  client: SshClient;
  webContents: WeakRef<WebContents>;
}

const shells = new Map<string, ShellRecord>();

export function spawnSshShell(
  webContents: WebContents,
  config: SshShellConfig,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();

    client.once("ready", () => {
      client.shell(
        { term: "xterm-256color", cols: config.cols, rows: config.rows },
        (err, stream) => {
          if (err) { client.end(); reject(err); return; }

          const shellId = crypto.randomUUID();
          shells.set(shellId, { stream, client, webContents: new WeakRef(webContents) });

          const send = (data: Buffer | string) => {
            const wc = shells.get(shellId)?.webContents.deref();
            if (wc && !wc.isDestroyed()) {
              wc.send(`ssh_shell_data_${shellId}`, typeof data === "string" ? data : data.toString("binary"));
            }
          };

          stream.on("data", send);
          stream.stderr?.on("data", send);

          stream.once("close", () => {
            const wc = shells.get(shellId)?.webContents.deref();
            if (wc && !wc.isDestroyed()) {
              wc.send(`ssh_shell_exit_${shellId}`);
            }
            shells.delete(shellId);
            client.end();
          });

          resolve(shellId);
        },
      );
    });

    client.once("error", (err) => reject(new Error(`SSH error: ${err.message}`)));

    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      // Disable strict host key checking for now
      hostVerifier: () => true,
    });
  });
}

export function writeSshShell(shellId: string, data: string): void {
  shells.get(shellId)?.stream?.write(data);
}

export function resizeSshShell(shellId: string, cols: number, rows: number): void {
  shells.get(shellId)?.stream?.setWindow?.(rows, cols, 0, 0);
}

export function killSshShell(shellId: string): void {
  const s = shells.get(shellId);
  if (!s) return;
  try { s.stream?.end?.(); } catch { /* ignore */ }
  try { s.client.end(); } catch { /* ignore */ }
  shells.delete(shellId);
}

export function killAllSshShells(): void {
  for (const id of [...shells.keys()]) killSshShell(id);
}
