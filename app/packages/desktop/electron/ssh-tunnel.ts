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
  closeAllTunnels as coreCloseAllTunnels,
  closeTunnel as coreCloseTunnel,
  getTunnelEntries,
} from "@infrawrench/ssh-tunnel-core";
import type { SshTunnelConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import { Context, Effect, Layer } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import { SshError, type SshShellConfig } from "../shared/rpc/groups/ssh-common";
import { acquireSshChain } from "./ssh-shell";
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

/** Connect config for the workflow SSH helpers below. */
export type WorkflowSshConfig = {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
};

function connectWorkflowSsh(
  config: WorkflowSshConfig,
  onReady: (client: SshClient) => void,
  onError: (err: Error) => void,
  skipHostKeyCheck = false,
): SshClient {
  const client = new SshClient();
  const hostKeyErrorRef = { value: null as HostKeyMismatchError | null };
  client.once("ready", () => onReady(client));
  client.once("error", (err) => {
    onError(hostKeyErrorRef.value ?? new Error(`SSH connection failed: ${err.message}`));
  });
  const baseOpts: ConnectConfig = withAgentOverride({
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUser,
    privateKey: config.privateKey,
  });
  // skipHostKeyCheck → accept any key without the interactive pin prompt.
  client.connect(
    skipHostKeyCheck
      ? { ...baseOpts, hostVerifier: (_key: Buffer, verify: (ok: boolean) => void) => verify(true) }
      : withHostKeyVerifier(baseOpts, hostKeyErrorRef),
  );
  return client;
}

/** Run a command and resolve its full output as base64 (binary-safe). */
export async function workflowSshExec(
  config: WorkflowSshConfig,
  command: string,
  skipHostKeyCheck = false,
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
      skipHostKeyCheck,
    );
  });
}

/**
 * Run a script fed on stdin (`sh -s`) and resolve its stdout; rejects on a
 * non-zero exit. For scripts carrying short-lived secrets (enrollment keys),
 * which must never appear in the remote process list the way an exec
 * argument would.
 */
export async function workflowSshExecScript(
  config: WorkflowSshConfig,
  script: string,
  skipHostKeyCheck = false,
): Promise<string> {
  await ensureHostKeyCacheLoaded();
  const { execSshScript } = await import("@infrawrench/ssh-tunnel-core");
  return new Promise((resolve, reject) => {
    connectWorkflowSsh(
      config,
      (client) => {
        execSshScript(client, script)
          .then(resolve, reject)
          .finally(() => client.end());
      },
      reject,
      skipHostKeyCheck,
    );
  });
}

type WorkflowStreamChunk = {
  stdoutBase64?: string;
  stderrBase64?: string;
  done: boolean;
  code?: number;
};

interface WorkflowStreamState {
  stdout: Buffer[];
  stderr: Buffer[];
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
  skipHostKeyCheck = false,
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
            stdout: [],
            stderr: [],
            done: false,
            code: null,
            error: null,
            waiter: null,
            client,
          };
          workflowStreams.set(streamId, state);
          channel.on("data", (d: Buffer) => {
            state.stdout.push(d);
            wakeStream(state);
          });
          channel.stderr.on("data", (d: Buffer) => {
            state.stderr.push(d);
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
      skipHostKeyCheck,
    );
  });
  return { streamId };
}

/** Read the next stdout/stderr chunks of a streaming command (resolves when ready or done). */
export function workflowSshStreamRead(streamId: string): Promise<WorkflowStreamChunk> {
  const state = workflowStreams.get(streamId);
  if (!state) return Promise.resolve({ done: true });
  const take = (): WorkflowStreamChunk | null => {
    if (state.error) {
      workflowStreams.delete(streamId);
      throw state.error;
    }
    if (state.stdout.length > 0 || state.stderr.length > 0) {
      const out: WorkflowStreamChunk = { done: false };
      if (state.stdout.length > 0)
        out.stdoutBase64 = Buffer.concat(state.stdout.splice(0)).toString("base64");
      if (state.stderr.length > 0)
        out.stderrBase64 = Buffer.concat(state.stderr.splice(0)).toString("base64");
      return out;
    }
    if (state.done) {
      workflowStreams.delete(streamId);
      return { done: true, code: state.code ?? 0 };
    }
    return null;
  };
  let ready: WorkflowStreamChunk | null;
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

const toSshError = (cause: unknown) => new SshError({ message: errorMessage(cause) });

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toSshError });

/**
 * Tunnels (`@infrawrench/ssh-tunnel-core`, with the desktop's agents and
 * host-key pins) and one-off commands, as the RPC handlers call them.
 */
export class SshTunnels extends Context.Service<
  SshTunnels,
  {
    readonly open: (
      config: SshTunnelConfig,
    ) => Effect.Effect<{ tunnelId: string; localPort: number }, SshError>;
    readonly close: (tunnelId: string) => Effect.Effect<void>;
    readonly active: Effect.Effect<ReturnType<typeof getActiveTunnels>>;
    readonly exec: (
      config: WorkflowSshConfig,
      command: string,
    ) => Effect.Effect<{ stdout: string; stderr: string; code: number }, SshError>;
    /** Feed `script` on stdin through the full chain (jump hops, agents, cloud keys). */
    readonly execScript: (
      config: SshShellConfig,
      script: string,
    ) => Effect.Effect<string, SshError>;
  }
>()("infrawrench/desktop/SshTunnels") {
  static readonly layer = Layer.succeed(SshTunnels)(
    SshTunnels.of({
      open: (config) => attempt(() => openTunnel(config)),
      close: (tunnelId) => Effect.sync(() => closeTunnel(tunnelId)),
      active: Effect.sync(getActiveTunnels),
      exec: (config, command) => attempt(() => sshExecCommand(config, command)),
      execScript: (config, script) =>
        Effect.gen(function* () {
          const { execSshScript } = yield* attempt(() => import("@infrawrench/ssh-tunnel-core"));
          const { client } = yield* acquireSshChain(config);
          return yield* attempt(() => execSshScript(client, script));
        }).pipe(Effect.scoped),
    }),
  );
}

type WorkflowStreamRead = Awaited<ReturnType<typeof workflowSshStreamRead>>;

/** The workflow sandbox's SSH capabilities, as the RPC handlers call them. */
export class WorkflowSsh extends Context.Service<
  WorkflowSsh,
  {
    readonly exec: (
      config: WorkflowSshConfig,
      command: string,
      skipHostKeyCheck: boolean,
    ) => Effect.Effect<{ stdoutBase64: string; stderrBase64: string; code: number }, SshError>;
    readonly execScript: (
      config: WorkflowSshConfig,
      script: string,
      skipHostKeyCheck: boolean,
    ) => Effect.Effect<string, SshError>;
    readonly streamStart: (
      config: WorkflowSshConfig,
      command: string,
      skipHostKeyCheck: boolean,
    ) => Effect.Effect<{ streamId: string }, SshError>;
    readonly streamRead: (streamId: string) => Effect.Effect<WorkflowStreamRead, SshError>;
    readonly streamClose: (streamId: string) => Effect.Effect<void>;
    readonly probe: (host: string, port: number, timeoutMs: number) => Effect.Effect<boolean>;
  }
>()("infrawrench/desktop/WorkflowSsh") {
  static readonly layer = Layer.succeed(WorkflowSsh)(
    WorkflowSsh.of({
      exec: (config, command, skip) => attempt(() => workflowSshExec(config, command, skip)),
      execScript: (config, script, skip) =>
        attempt(() => workflowSshExecScript(config, script, skip)),
      streamStart: (config, command, skip) =>
        attempt(() => workflowSshStreamStart(config, command, skip)),
      streamRead: (streamId) => attempt(() => workflowSshStreamRead(streamId)),
      streamClose: (streamId) => Effect.sync(() => workflowSshStreamClose(streamId)),
      probe: (host, port, timeoutMs) =>
        Effect.promise(() => workflowSshProbe(host, port, timeoutMs)),
    }),
  );
}
