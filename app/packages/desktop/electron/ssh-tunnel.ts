import * as net from "node:net";
import * as crypto from "node:crypto";
import { Client as SshClient } from "ssh2";

export interface SshTunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
  remoteHost: string;
  remotePort: number;
}

interface TunnelRecord {
  tunnelId: string;
  localPort: number;
  server: net.Server;
  client: SshClient;
  sshHost: string;
  remotePort: number;
}

const activeTunnels = new Map<string, TunnelRecord>();

export function openTunnel(
  config: SshTunnelConfig,
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
        });
        resolve({ tunnelId, localPort: addr.port });
      });
    });

    sshClient.once("error", (err) => {
      server.close();
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    sshClient.connect({
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      privateKey: config.privateKey,
    });
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
  for (const tunnelId of activeTunnels.keys()) {
    closeTunnel(tunnelId);
  }
}

/**
 * Execute a command over SSH and return stdout/stderr.
 * Useful for one-off commands like checking if Docker is installed.
 */
export function sshExecCommand(
  config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string },
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
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
    client.once("error", (err) => reject(new Error(`SSH connection failed: ${err.message}`)));
    client.connect({
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      privateKey: config.privateKey,
    });
  });
}

export function getActiveTunnels(): Record<
  string,
  { localPort: number; sshHost: string; remotePort: number }
> {
  const result: Record<string, { localPort: number; sshHost: string; remotePort: number }> = {};
  for (const [id, record] of activeTunnels) {
    result[id] = {
      localPort: record.localPort,
      sshHost: record.sshHost,
      remotePort: record.remotePort,
    };
  }
  return result;
}
