import * as crypto from "node:crypto";
import type { Readable } from "node:stream";
import { Client as SshClient } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { WebContents } from "electron";
import { forwardOutHop } from "@infrawrench/plugin-ssh";
import { PAGEANT_SENTINEL } from "./ssh-agent";
import { buildInProcessAgent } from "./ssh-shell-agent";
import {
  ensureHostKeyCacheLoaded,
  verifyOrPinHostKeyInteractive,
  HostKeyMismatchError,
} from "./ssh-host-keys";

/** A single hop in a jumpbox chain. */
export interface SshShellJumpHop {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export interface SshShellConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  cols: number;
  rows: number;
  agentForward?: boolean;
  /**
   * Optional intermediate jump hops (outermost-first). When present, the host
   * dials each in turn — chaining `forwardOut` → `sock` — and then dials the
   * `host`/`port`/`username`/`privateKey` target through the last hop.
   * Each hop's host key is verified independently against the local TOFU cache.
   */
  jumpHops?: SshShellJumpHop[];
}

interface ShellRecord {
  stream: ClientChannel;
  client: SshClient;
  webContents: WeakRef<WebContents>;
}

const shells = new Map<string, ShellRecord>();

/**
 * Open one hop. The hop is dialled either directly (when `sock` is undefined)
 * or through an existing chain via `sock`. Returns the ready client. Each hop
 * gets its own TOFU host-key check.
 */
function connectOneHop(opts: {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  sock?: Readable;
  agent?: ReturnType<typeof buildInProcessAgent> | "pageant" | null;
  agentForward?: boolean;
}): Promise<SshClient> {
  const client = new SshClient();
  let hostKeyError: HostKeyMismatchError | null = null;
  const useAgentForAuth = opts.privateKey === PAGEANT_SENTINEL;
  return new Promise((resolve, reject) => {
    client.once("ready", () => resolve(client));
    client.once("error", (err) => {
      if (hostKeyError) reject(hostKeyError);
      else reject(new Error(`SSH error: ${err.message}`));
    });
    client.connect({
      ...(opts.sock ? { sock: opts.sock } : { host: opts.host, port: opts.port }),
      username: opts.username,
      ...(useAgentForAuth ? {} : { privateKey: opts.privateKey }),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.agentForward ? { agentForward: true } : {}),
      hostVerifier: (hostKey: Buffer, verify: (matches: boolean) => void) => {
        verifyOrPinHostKeyInteractive(opts.host, opts.port, hostKey).then(
          (result) => {
            if (!result.ok) {
              console.error(
                `[ssh-shell] host key rejected for ${result.error.host}:${result.error.port} ` +
                  `(stored=${result.error.storedFingerprint}, presented=${result.error.presentedFingerprint})`,
              );
              hostKeyError = result.error;
              verify(false);
              return;
            }
            verify(true);
          },
          (err) => {
            console.error("[ssh-shell] host-key verification error:", err);
            verify(false);
          },
        );
      },
    });
  });
}

export async function spawnSshShell(
  webContents: WebContents,
  config: SshShellConfig,
): Promise<string> {
  await ensureHostKeyCacheLoaded();

  // Agent forwarding settings apply to the final hop only — when forwarding
  // through jumpboxes we explicitly don't expose the agent on intermediates.
  const useAgentForAuth = config.privateKey === PAGEANT_SENTINEL;
  let forwardAgent: ReturnType<typeof buildInProcessAgent> | "pageant" | null = null;
  if (config.agentForward) {
    if (useAgentForAuth) {
      forwardAgent = "pageant";
    } else {
      forwardAgent = buildInProcessAgent(config.privateKey);
      if (!forwardAgent) {
        throw new Error(
          "Agent forwarding requested but the selected SSH key could not be loaded into Infrawrench's in-process agent.",
        );
      }
      console.log(
        `[ssh-shell] agent forwarding: in-process (${forwardAgent.keyCount} key${
          forwardAgent.keyCount === 1 ? "" : "s"
        })`,
      );
    }
  }

  // Dial intermediate hops first, chaining each through the previous.
  const intermediates: SshClient[] = [];
  let prev: SshClient | null = null;
  try {
    for (const hop of config.jumpHops ?? []) {
      const sock = prev ? ((await forwardOutHop(prev, hop.host, hop.port)) as Readable) : undefined;
      const c = await connectOneHop({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        privateKey: hop.privateKey,
        ...(sock ? { sock } : {}),
      });
      intermediates.push(c);
      prev = c;
    }
  } catch (err) {
    for (const c of intermediates) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  // Dial the final target.
  let client: SshClient;
  try {
    const finalSock = prev
      ? ((await forwardOutHop(prev, config.host, config.port)) as Readable)
      : undefined;
    client = await connectOneHop({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      ...(finalSock ? { sock: finalSock } : {}),
      agent: forwardAgent,
      agentForward: !!config.agentForward,
    });
  } catch (err) {
    for (const c of intermediates) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  return new Promise<string>((resolve, reject) => {
    client.shell(
      { term: "xterm-256color", cols: config.cols, rows: config.rows },
      (err, stream) => {
        if (err) {
          client.end();
          for (const c of intermediates) {
            try {
              c.end();
            } catch {
              /* ignore */
            }
          }
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
          for (const c of intermediates) {
            try {
              c.end();
            } catch {
              /* ignore */
            }
          }
        });

        resolve(shellId);
      },
    );
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
