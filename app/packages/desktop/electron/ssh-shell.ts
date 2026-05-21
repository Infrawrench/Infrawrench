import * as crypto from "node:crypto";
import type { Readable } from "node:stream";
import { Client as SshClient } from "ssh2";
import type { ClientChannel } from "ssh2";
import type { WebContents } from "electron";
import { forwardOutHop } from "@infrawrench/plugin-ssh";
import { ONEPASSWORD_SENTINEL, PAGEANT_SENTINEL } from "./ssh-agent";
import { get1PasswordAgentPath } from "./onepassword-agent";
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
type ForwardAgent = ReturnType<typeof buildInProcessAgent> | string | null;

function connectOneHop(opts: {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  sock?: Readable;
  agent?: ForwardAgent;
  agentForward?: boolean;
}): Promise<SshClient> {
  const client = new SshClient();
  let hostKeyError: HostKeyMismatchError | null = null;
  const useAgentForAuth =
    opts.privateKey === PAGEANT_SENTINEL || opts.privateKey === ONEPASSWORD_SENTINEL;
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

  // When the user picked an external agent (Pageant / 1Password) we route both
  // auth and (optionally) forwarding through it. For PEM-key auth, forwarding
  // happens via our in-process agent. Agent forwarding only applies to the
  // final hop — intermediate hops never see the agent.
  let connectAgent: ForwardAgent = null;
  if (config.privateKey === PAGEANT_SENTINEL) {
    connectAgent = "pageant";
  } else if (config.privateKey === ONEPASSWORD_SENTINEL) {
    const sock = get1PasswordAgentPath();
    if (!sock) {
      throw new Error(
        "1Password SSH agent was selected but the agent socket could not be found. Enable the SSH agent in 1Password's Developer settings.",
      );
    }
    connectAgent = sock;
    if (config.agentForward) console.log("[ssh-shell] agent forwarding: 1Password");
  } else if (config.agentForward) {
    connectAgent = buildInProcessAgent(config.privateKey);
    if (!connectAgent) {
      throw new Error(
        "Agent forwarding requested but the selected SSH key could not be loaded into Infrawrench's in-process agent.",
      );
    }
    const inProc = connectAgent;
    if (typeof inProc !== "string") {
      console.log(
        `[ssh-shell] agent forwarding: in-process (${inProc.keyCount} key${
          inProc.keyCount === 1 ? "" : "s"
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
      agent: connectAgent,
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
