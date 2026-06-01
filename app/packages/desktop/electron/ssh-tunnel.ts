/**
 * Desktop adapter over @infrawrench/ssh-tunnel-core. Adds external-agent
 * support (Pageant on Windows, 1Password on any platform) via sentinel
 * private-key strings, plus an sshExecCommand helper that reuses the same
 * connect logic for one-off commands.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Client as SshClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import {
  openTunnel as coreOpenTunnel,
  closeTunnel as coreCloseTunnel,
  closeAllTunnels as coreCloseAllTunnels,
  getTunnelEntries,
} from "@infrawrench/ssh-tunnel-core";
import type { SshTunnelConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { ONEPASSWORD_SENTINEL, PAGEANT_SENTINEL } from "./ssh-agent";
import { get1PasswordAgentPath } from "./onepassword-agent";
import {
  ensureHostKeyCacheLoaded,
  verifyOrPinHostKeyInteractive,
  HostKeyMismatchError,
} from "./ssh-host-keys";

function withAgentOverride(opts: ConnectConfig): ConnectConfig {
  if (opts.privateKey === PAGEANT_SENTINEL) {
    const { privateKey: _ignored, ...rest } = opts;
    return { ...rest, agent: "pageant" };
  }
  if (opts.privateKey === ONEPASSWORD_SENTINEL) {
    const sock = get1PasswordAgentPath();
    if (!sock) {
      throw new Error(
        "1Password SSH agent was selected but the agent socket could not be found. Enable the SSH agent in 1Password's Developer settings.",
      );
    }
    const { privateKey: _ignored, ...rest } = opts;
    return { ...rest, agent: sock };
  }
  return opts;
}

/**
 * Wrap a ConnectConfig so its host-key verifier consults the desktop TOFU
 * store. Captures any mismatch error on `hostKeyErrorRef.value` so the
 * outer Promise reject can surface a meaningful error instead of the
 * generic ssh2 "All configured authentication methods failed".
 */
function withHostKeyVerifier(
  opts: ConnectConfig,
  hostKeyErrorRef: { value: HostKeyMismatchError | null },
): ConnectConfig {
  const host = String(opts.host);
  const port = Number(opts.port);
  return {
    ...opts,
    hostVerifier: (hostKey: Buffer, verify: (matches: boolean) => void) => {
      verifyOrPinHostKeyInteractive(host, port, hostKey).then(
        (result) => {
          if (!result.ok) {
            console.error(
              `[ssh-tunnel] host key rejected for ${result.error.host}:${result.error.port} ` +
                `(stored=${result.error.storedFingerprint}, presented=${result.error.presentedFingerprint})`,
            );
            hostKeyErrorRef.value = result.error;
            verify(false);
            return;
          }
          verify(true);
        },
        (err) => {
          console.error("[ssh-tunnel] host-key verification error:", err);
          verify(false);
        },
      );
    },
  };
}

export async function openTunnel(
  config: SshTunnelConfig,
): Promise<{ tunnelId: string; localPort: number }> {
  await ensureHostKeyCacheLoaded();
  // The ssh-tunnel-core surface doesn't expose the host-key error path
  // separately, so any mismatch will manifest as a connection failure with a
  // message we log above. That's acceptable for tunnels because the IPC
  // caller only sees pass/fail; the console log identifies the cause.
  const hostKeyErrorRef = { value: null as HostKeyMismatchError | null };
  return coreOpenTunnel<undefined>(config, undefined, {
    configureConnect: (opts) => withHostKeyVerifier(withAgentOverride(opts), hostKeyErrorRef),
  });
}

export function closeTunnel(tunnelId: string): void {
  coreCloseTunnel(tunnelId);
}

export function closeAllTunnels(): void {
  coreCloseAllTunnels();
}

export function getActiveTunnels(): Record<
  string,
  { localPort: number; sshHost: string; remotePort: number }
> {
  const result: Record<string, { localPort: number; sshHost: string; remotePort: number }> = {};
  for (const r of getTunnelEntries()) {
    result[r.tunnelId] = {
      localPort: r.localPort,
      sshHost: r.sshHost,
      remotePort: r.remotePort,
    };
  }
  return result;
}

/**
 * Execute a command over SSH and return stdout/stderr.
 * Useful for one-off commands like checking if Docker is installed.
 */
export async function sshExecCommand(
  config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string },
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  await ensureHostKeyCacheLoaded();
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const hostKeyErrorRef = { value: null as HostKeyMismatchError | null };
    client.once("ready", () => {
      client.exec(command, (err, channel) => {
        if (err) {
          client.end();
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        channel.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        channel.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        channel.on("close", (code: number) => {
          client.end();
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    });
    client.once("error", (err) => {
      if (hostKeyErrorRef.value) {
        reject(hostKeyErrorRef.value);
        return;
      }
      reject(new Error(`SSH connection failed: ${err.message}`));
    });
    const baseOpts: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      privateKey: config.privateKey,
    };
    client.connect(withHostKeyVerifier(withAgentOverride(baseOpts), hostKeyErrorRef));
  });
}

// --- workflow SSH (binary-safe exec + streaming + reachability probe) -------
//
// Backs `resource.ssh(...)` / `resource.waitUntilReachable()` inside desktop
// workflows. The renderer resolves the connect config (host + key) and the
// sandbox (Electron main) calls these via IPC. Output is base64 so binary
// command output survives the JSON bridge intact.

type WorkflowSshConfig = {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
};

function connectWorkflowSsh(
  config: WorkflowSshConfig,
  onReady: (client: SshClient) => void,
  onError: (err: Error) => void,
): SshClient {
  const client = new SshClient();
  const hostKeyErrorRef = { value: null as HostKeyMismatchError | null };
  client.once("ready", () => onReady(client));
  client.once("error", (err) => {
    onError(hostKeyErrorRef.value ?? new Error(`SSH connection failed: ${err.message}`));
  });
  const baseOpts: ConnectConfig = {
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUser,
    privateKey: config.privateKey,
  };
  client.connect(withHostKeyVerifier(withAgentOverride(baseOpts), hostKeyErrorRef));
  return client;
}

/** Run a command and resolve its full output as base64 (binary-safe). */
export async function workflowSshExec(
  config: WorkflowSshConfig,
  command: string,
): Promise<{ stdoutBase64: string; stderrBase64: string; code: number }> {
  await ensureHostKeyCacheLoaded();
  return new Promise((resolve, reject) => {
    connectWorkflowSsh(
      config,
      (client) => {
        client.exec(command, (err, channel) => {
          if (err) {
            client.end();
            reject(err);
            return;
          }
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          channel.on("data", (d: Buffer) => stdout.push(d));
          channel.stderr.on("data", (d: Buffer) => stderr.push(d));
          channel.on("close", (code: number) => {
            client.end();
            resolve({
              stdoutBase64: Buffer.concat(stdout).toString("base64"),
              stderrBase64: Buffer.concat(stderr).toString("base64"),
              code: code ?? 0,
            });
          });
        });
      },
      reject,
    );
  });
}

interface WorkflowStreamState {
  chunks: Buffer[];
  done: boolean;
  code: number | null;
  error: Error | null;
  waiter: (() => void) | null;
  client: SshClient;
}

const workflowStreams = new Map<string, WorkflowStreamState>();

function wakeStream(state: WorkflowStreamState): void {
  const w = state.waiter;
  if (w) {
    state.waiter = null;
    w();
  }
}

/** Begin a streaming command; returns a token for {@link workflowSshStreamRead}. */
export async function workflowSshStreamStart(
  config: WorkflowSshConfig,
  command: string,
): Promise<{ streamId: string }> {
  await ensureHostKeyCacheLoaded();
  const streamId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    connectWorkflowSsh(
      config,
      (client) => {
        client.exec(command, (err, channel) => {
          if (err) {
            client.end();
            reject(err);
            return;
          }
          const state: WorkflowStreamState = {
            chunks: [],
            done: false,
            code: null,
            error: null,
            waiter: null,
            client,
          };
          workflowStreams.set(streamId, state);
          channel.on("data", (d: Buffer) => {
            state.chunks.push(d);
            wakeStream(state);
          });
          channel.on("close", (code: number) => {
            state.done = true;
            state.code = code ?? 0;
            wakeStream(state);
            client.end();
          });
          resolve();
        });
      },
      reject,
    );
  });
  return { streamId };
}

/** Read the next stdout chunk of a streaming command (resolves when ready or done). */
export function workflowSshStreamRead(
  streamId: string,
): Promise<{ dataBase64?: string; done: boolean; code?: number }> {
  const state = workflowStreams.get(streamId);
  if (!state) return Promise.resolve({ done: true });
  const take = (): { dataBase64?: string; done: boolean; code?: number } | null => {
    if (state.error) {
      workflowStreams.delete(streamId);
      throw state.error;
    }
    if (state.chunks.length > 0) {
      const chunk = Buffer.concat(state.chunks.splice(0));
      return { dataBase64: chunk.toString("base64"), done: false };
    }
    if (state.done) {
      workflowStreams.delete(streamId);
      return { done: true, code: state.code ?? 0 };
    }
    return null;
  };
  let ready: { dataBase64?: string; done: boolean; code?: number } | null;
  try {
    ready = take();
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const onWake = () => {
      try {
        const next = take();
        if (next) resolve(next);
        else state.waiter = onWake;
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    state.waiter = onWake;
  });
}

/** Tear down a streaming command early. */
export function workflowSshStreamClose(streamId: string): void {
  const state = workflowStreams.get(streamId);
  if (state) {
    workflowStreams.delete(streamId);
    try {
      state.client.end();
    } catch {
      /* already closed */
    }
  }
}

/** Poll until `host:port` accepts a TCP connection, or time out. */
export async function workflowSshProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const interval = 4_000;
  const deadline = Date.now() + (timeoutMs || 180_000);
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(interval);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
  while (Date.now() < deadline) {
    if (await attempt()) return true;
    if (Date.now() + interval >= deadline) break;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
