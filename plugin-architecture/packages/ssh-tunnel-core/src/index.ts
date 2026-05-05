/**
 * Shared SSH tunnel core. The web service uses it with org/account extras
 * for cross-tenant lookups; the desktop main process uses it with a Pageant
 * connect override on Windows. Adapters in each consumer add their
 * domain-specific surface (lookup helpers, exec helpers).
 */
import * as net from "node:net";
import * as crypto from "node:crypto";
import { Client as SshClient, type ConnectConfig } from "ssh2";
import type { SshTunnelConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};

export interface TunnelRecord<E = undefined> {
  tunnelId: string;
  localPort: number;
  server: net.Server;
  client: SshClient;
  sshHost: string;
  remotePort: number;
  extras: E;
}

export interface OpenTunnelOptions {
  /**
   * Hook called just before the SSH client connects. Receives the default
   * ConnectConfig assembled from the SshTunnelConfig and may return a modified
   * config (e.g. swap privateKey for `agent: "pageant"`).
   */
  configureConnect?: (opts: ConnectConfig) => ConnectConfig;
}

const activeTunnels = new Map<string, TunnelRecord<unknown>>();

export function openTunnel<E = undefined>(
  config: SshTunnelConfig,
  extras: E,
  options?: OpenTunnelOptions,
): Promise<{ tunnelId: string; localPort: number }> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();
    const server = net.createServer((socket) => {
      sshClient.forwardOut("127.0.0.1", 0, config.remoteHost, config.remotePort, (err, channel) => {
        if (err) {
          socket.destroy();
          return;
        }
        socket.pipe(channel);
        channel.pipe(socket);
        socket.on("close", () => channel.end());
        channel.on("close", () => socket.destroy());
      });
    });

    sshClient.once("ready", () => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        const tunnelId = crypto.randomUUID();
        activeTunnels.set(tunnelId, {
          tunnelId,
          localPort: addr.port,
          server,
          client: sshClient,
          sshHost: config.sshHost,
          remotePort: config.remotePort,
          extras,
        });
        resolve({ tunnelId, localPort: addr.port });
      });
    });

    sshClient.once("error", (err) => {
      server.close();
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    const baseOpts: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      privateKey: config.privateKey,
      hostVerifier: () => true,
    };
    sshClient.connect(options?.configureConnect ? options.configureConnect(baseOpts) : baseOpts);
  });
}

export function closeTunnel(tunnelId: string): void {
  const record = activeTunnels.get(tunnelId);
  if (!record) return;
  record.server.close();
  record.client.end();
  activeTunnels.delete(tunnelId);
}

export function closeAllTunnels(): void {
  for (const tunnelId of [...activeTunnels.keys()]) {
    closeTunnel(tunnelId);
  }
}

export function getTunnelEntries<E = unknown>(): TunnelRecord<E>[] {
  return [...activeTunnels.values()] as TunnelRecord<E>[];
}

export function findTunnel<E = unknown>(
  predicate: (record: TunnelRecord<E>) => boolean,
): TunnelRecord<E> | null {
  for (const record of activeTunnels.values()) {
    if (predicate(record as TunnelRecord<E>)) return record as TunnelRecord<E>;
  }
  return null;
}
