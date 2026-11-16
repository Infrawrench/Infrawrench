/**
 * Local-port SSH tunnels: a listener on 127.0.0.1 whose connections are
 * forwarded through one SSH connection to `remoteHost:remotePort`.
 *
 * A tunnel is registered only while its SSH connection is alive. When the
 * connection ends after it opened (the bastion restarts, the network drops,
 * sshd is killed, keepalives go unanswered, or forwarding fails several times
 * in a row), the tunnel is dropped: its record is removed, its listener
 * closed and every connection still using it reset, so a lookup misses and
 * the caller opens a fresh one rather than handing out a dead port (#1276).
 *
 * {@link ensureTunnel} is that "find or open" for callers that keep one tunnel
 * per key (an account): one open at a time per key, and a growing wait after
 * failures, so a bastion that is down is not redialled on every request.
 */
import * as net from "node:net";
import * as crypto from "node:crypto";
import ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";
import type { SshTunnelConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};

const { Client: SshClient } = ssh2;
// Re-establish the class's dual value/type nature lost by destructuring.
type SshClient = InstanceType<typeof SshClient>;

export interface TunnelRecord<E = undefined> {
  tunnelId: string;
  localPort: number;
  server: net.Server;
  client: SshClient;
  sshHost: string;
  remotePort: number;
  extras: E;
  /** The key {@link ensureTunnel} opened it under; none for {@link openTunnel}. */
  key?: string;
}

/**
 * Standard `extras` payload used by both the web service and server-core for
 * cross-tenant tunnel scoping. Adapters that need additional context can
 * still extend this (or use a different `E` type entirely).
 */
export interface TunnelExtras {
  organizationId: string;
  accountId: string;
}

export interface OpenTunnelOptions {
  /**
   * Hook called just before the SSH client connects. Receives the default
   * ConnectConfig assembled from the SshTunnelConfig and may return a modified
   * config (e.g. swap privateKey for `agent: "pageant"`).
   *
   * The default ConnectConfig fails closed (its `hostVerifier` rejects every
   * key with a clear error) so callers MUST provide a verifier here. The
   * web service supplies one backed by an in-memory pin map; the desktop
   * supplies one backed by the local sql.js `ssh_host_keys` table.
   */
  configureConnect?: (opts: ConnectConfig) => ConnectConfig;
  /**
   * Read when the connection fails before it is ready: a more specific error
   * than ssh2's, such as the host key the caller's verifier refused. The
   * open rejects with it instead when it returns one.
   */
  connectError?: () => Error | null | undefined;
}

/**
 * Keepalives on every tunnel's SSH connection: a connection that stops
 * answering is dropped after about `interval * (countMax + 1)` (40 s), rather
 * than holding its local port open on a peer that is gone.
 */
export const TUNNEL_KEEPALIVE_INTERVAL_MS = 10_000;
export const TUNNEL_KEEPALIVE_COUNT_MAX = 3;
/** Forwarded connections that fail in a row before the SSH connection counts as broken. */
export const TUNNEL_FORWARD_FAILURES_TO_DROP = 3;
/** The wait after a key's first failure, doubled for each one after it. */
export const TUNNEL_RETRY_BASE_MS = 1_000;
export const TUNNEL_RETRY_MAX_MS = 30_000;
/** A tunnel that drops younger than this counts as a failure of its key. */
export const TUNNEL_STABLE_MS = 30_000;

interface LiveTunnel {
  record: TunnelRecord<unknown>;
  /** Local connections accepted and not yet closed, piped or still waiting for a channel. */
  sockets: Set<net.Socket>;
  openedAt: number;
  forwardFailures: number;
  closed: boolean;
}

const activeTunnels = new Map<string, LiveTunnel>();

/** Why a key's last attempt failed, and when the next one may start. */
interface RetryState {
  failures: number;
  retryAt: number;
  reason: string;
}

const retryStates = new Map<string, RetryState>();
const opening = new Map<string, Promise<{ tunnelId: string; localPort: number }>>();

/** {@link ensureTunnel} refused to dial: the key's last attempt failed too recently. */
export class SshTunnelUnavailableError extends Error {
  readonly retryInMs: number;
  constructor(reason: string, retryInMs: number) {
    super(
      `The SSH tunnel is unavailable (${reason}); trying again in ${Math.ceil(retryInMs / 1000)}s.`,
    );
    this.name = "SshTunnelUnavailableError";
    this.retryInMs = retryInMs;
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Removes a tunnel and frees everything it holds. `failure` is set when the
 * connection broke rather than being closed on purpose, which a keyed
 * tunnel's retry state counts.
 */
function release(live: LiveTunnel, failure?: string): void {
  if (live.closed) return;
  live.closed = true;
  const { record } = live;
  activeTunnels.delete(record.tunnelId);
  record.server.close();
  // Whoever is still using the tunnel gets a closed connection now, not a
  // stream that never answers again.
  for (const socket of live.sockets) socket.destroy();
  live.sockets.clear();
  record.client.end();
  if (failure !== undefined && record.key !== undefined) {
    if (Date.now() - live.openedAt < TUNNEL_STABLE_MS) noteFailure(record.key, failure);
    else retryStates.delete(record.key);
  }
}

function noteFailure(key: string, reason: string): void {
  const failures = (retryStates.get(key)?.failures ?? 0) + 1;
  const wait = Math.min(TUNNEL_RETRY_BASE_MS * 2 ** (failures - 1), TUNNEL_RETRY_MAX_MS);
  retryStates.set(key, { failures, retryAt: Date.now() + wait, reason });
}

function openKeyedTunnel<E>(
  config: SshTunnelConfig,
  extras: E,
  options: OpenTunnelOptions | undefined,
  key: string | undefined,
): Promise<{ tunnelId: string; localPort: number }> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();
    const sockets = new Set<net.Socket>();
    let live: LiveTunnel | null = null;
    let settled = false;

    const forwardFailed = (err: Error) => {
      if (!live || live.closed) return;
      live.forwardFailures += 1;
      if (live.forwardFailures >= TUNNEL_FORWARD_FAILURES_TO_DROP) {
        release(
          live,
          `forwarding to ${config.remoteHost}:${config.remotePort} failed ${live.forwardFailures} times in a row: ${err.message}`,
        );
      }
    };

    const server = net.createServer((socket) => {
      sockets.add(socket);
      // A local client resetting its own connection is not the tunnel's
      // concern, and an unhandled socket error would take the process down.
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      try {
        sshClient.forwardOut(
          "127.0.0.1",
          0,
          config.remoteHost,
          config.remotePort,
          (err, channel) => {
            if (err) {
              socket.destroy();
              forwardFailed(err);
              return;
            }
            if (live) live.forwardFailures = 0;
            if (socket.destroyed) {
              channel.close();
              return;
            }
            channel.on("error", () => socket.destroy());
            socket.pipe(channel);
            channel.pipe(socket);
            socket.on("close", () => channel.end());
            channel.on("close", () => socket.destroy());
          },
        );
      } catch (err) {
        // ssh2 throws rather than calling back when the connection is no
        // longer up; that is a failed forward like any other.
        socket.destroy();
        forwardFailed(err instanceof Error ? err : new Error(String(err)));
      }
    });

    let connectOpts: ConnectConfig | undefined;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      server.close();
      for (const socket of sockets) socket.destroy();
      sshClient.end();
      // A socket the caller dialled itself (`configureConnect`'s `sock`) is
      // closed here too, so a failed open holds no connection to the bastion.
      connectOpts?.sock?.destroy();
      reject(options?.connectError?.() ?? new Error(`SSH connection failed: ${err.message}`));
    };

    server.on("error", (err) => {
      if (live) release(live, `local listener failed: ${err.message}`);
      else fail(err);
    });

    sshClient.on("error", (err) => {
      if (live) release(live, `SSH connection lost: ${err.message}`);
      else fail(err);
    });
    sshClient.on("close", () => {
      if (live) release(live, "SSH connection closed");
      else fail(new Error("the connection closed before it was ready"));
    });

    sshClient.once("ready", () => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (settled || !addr || typeof addr === "string") {
          fail(new Error("the local listener did not start"));
          return;
        }
        settled = true;
        const tunnelId = crypto.randomUUID();
        live = {
          record: {
            tunnelId,
            localPort: addr.port,
            server,
            client: sshClient,
            sshHost: config.sshHost,
            remotePort: config.remotePort,
            extras,
            ...(key === undefined ? {} : { key }),
          },
          sockets,
          openedAt: Date.now(),
          forwardFailures: 0,
          closed: false,
        };
        activeTunnels.set(tunnelId, live);
        resolve({ tunnelId, localPort: addr.port });
      });
    });

    const baseOpts: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      privateKey: config.privateKey,
      keepaliveInterval: TUNNEL_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: TUNNEL_KEEPALIVE_COUNT_MAX,
      hostVerifier: () => {
        throw new Error(
          "ssh-tunnel-core: no SSH host-key verifier configured. Pass " +
            "options.configureConnect to install one (see the web and desktop " +
            "ssh-host-keys modules for TOFU verifiers).",
        );
      },
    };
    try {
      connectOpts = options?.configureConnect ? options.configureConnect(baseOpts) : baseOpts;
      sshClient.connect(connectOpts);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Opens a tunnel and registers it until it is closed or its SSH connection
 * ends. Every call opens a new one; {@link ensureTunnel} reuses one per key.
 */
export function openTunnel<E = undefined>(
  config: SshTunnelConfig,
  extras: E,
  options?: OpenTunnelOptions,
): Promise<{ tunnelId: string; localPort: number }> {
  return openKeyedTunnel(config, extras, options, undefined);
}

/** What {@link ensureTunnel} opens with, worked out only when it has to open. */
export interface TunnelPlan<E> {
  config: SshTunnelConfig;
  extras: E;
  options?: OpenTunnelOptions;
}

/**
 * The tunnel registered under `key`, or a new one. `plan` runs only when a
 * tunnel has to be opened, so decrypting a key or resolving the bastion
 * happens once per open, not once per request. Concurrent calls for a key
 * share one open. After an open fails, or a tunnel drops within
 * {@link TUNNEL_STABLE_MS} of opening, calls for the key reject with
 * {@link SshTunnelUnavailableError} for a while (1 s, doubling to 30 s)
 * instead of dialling again; the next call after that tries for real.
 */
export function ensureTunnel<E>(
  key: string,
  plan: () => Promise<TunnelPlan<E>> | TunnelPlan<E>,
): Promise<{ tunnelId: string; localPort: number }> {
  for (const live of activeTunnels.values()) {
    if (live.record.key === key) {
      return Promise.resolve({ tunnelId: live.record.tunnelId, localPort: live.record.localPort });
    }
  }
  const inFlight = opening.get(key);
  if (inFlight) return inFlight;

  const now = Date.now();
  for (const [k, state] of retryStates) {
    // Forget failures long past, so the map holds only keys failing lately.
    if (now - state.retryAt > 10 * TUNNEL_RETRY_MAX_MS) retryStates.delete(k);
  }
  const retry = retryStates.get(key);
  if (retry && retry.retryAt > now) {
    return Promise.reject(new SshTunnelUnavailableError(retry.reason, retry.retryAt - now));
  }

  const started = (async () => {
    try {
      const { config, extras, options } = await plan();
      return await openKeyedTunnel(config, extras, options, key);
    } catch (err) {
      noteFailure(key, messageOf(err));
      throw err;
    }
  })().finally(() => opening.delete(key));
  opening.set(key, started);
  return started;
}

export function closeTunnel(tunnelId: string): void {
  const live = activeTunnels.get(tunnelId);
  if (live) release(live);
}

/** Closes every tunnel and forgets every key's failures (shutdown, tests). */
export function closeAllTunnels(): void {
  for (const live of [...activeTunnels.values()]) release(live);
  retryStates.clear();
}

/** The tunnels whose SSH connection is alive. */
export function getTunnelEntries<E = unknown>(): TunnelRecord<E>[] {
  return [...activeTunnels.values()].map((live) => live.record) as TunnelRecord<E>[];
}

export function findTunnel<E = unknown>(
  predicate: (record: TunnelRecord<E>) => boolean,
): TunnelRecord<E> | null {
  for (const { record } of activeTunnels.values()) {
    if (predicate(record as TunnelRecord<E>)) return record as TunnelRecord<E>;
  }
  return null;
}
