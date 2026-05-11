import * as crypto from "node:crypto";
import { Client as SshClient } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { WebContents } from "electron";
import { PAGEANT_SENTINEL } from "./ssh-agent";
import {
  ensureHostKeyCacheLoaded,
  verifyOrPinHostKeySync,
  HostKeyMismatchError,
} from "./ssh-host-keys";

export interface SshShellConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  cols: number;
  rows: number;
}

interface ShellRecord {
  stream: ClientChannel;
  client: SshClient;
  webContents: WeakRef<WebContents>;
}

const shells = new Map<string, ShellRecord>();

export async function spawnSshShell(
  webContents: WebContents,
  config: SshShellConfig,
): Promise<string> {
  await ensureHostKeyCacheLoaded();
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let hostKeyError: HostKeyMismatchError | null = null;

    client.once("ready", () => {
      client.shell(
        { term: "xterm-256color", cols: config.cols, rows: config.rows },
        (err, stream) => {
          if (err) {
            client.end();
            reject(err);
            return;
          }

          const shellId = crypto.randomUUID();
          shells.set(shellId, { stream, client, webContents: new WeakRef(webContents) });

          const send = (data: Buffer | string) => {
            const wc = shells.get(shellId)?.webContents.deref();
            if (wc && !wc.isDestroyed()) {
              wc.send(
                `ssh_shell_data_${shellId}`,
                typeof data === "string" ? Buffer.from(data, "utf8") : data,
              );
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

    client.once("error", (err) => {
      if (hostKeyError) {
        reject(hostKeyError);
        return;
      }
      reject(new Error(`SSH error: ${err.message}`));
    });

    const useAgent = config.privateKey === PAGEANT_SENTINEL;
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      ...(useAgent ? { agent: "pageant" } : { privateKey: config.privateKey }),
      hostVerifier: (hostKey: Buffer) => {
        const result = verifyOrPinHostKeySync(config.host, config.port, hostKey);
        if (!result.ok) {
          console.error(
            `[ssh-shell] host key mismatch for ${result.error.host}:${result.error.port} ` +
              `(stored=${result.error.storedFingerprint}, presented=${result.error.presentedFingerprint})`,
          );
          hostKeyError = result.error;
          return false;
        }
        return true;
      },
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
  try {
    s.stream?.end?.();
  } catch {
    /* ignore */
  }
  try {
    s.client.end();
  } catch {
    /* ignore */
  }
  shells.delete(shellId);
}

export function killAllSshShells(): void {
  for (const id of [...shells.keys()]) killSshShell(id);
}
