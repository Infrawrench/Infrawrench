/**
 * Desktop adapter over @infrawrench/ssh-tunnel-core. Adds Pageant-agent
 * support on Windows (privateKey === PAGEANT_SENTINEL) and an sshExecCommand
 * helper that reuses the same connect logic for one-off commands.
 */
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
import { PAGEANT_SENTINEL } from "./ssh-agent";

function withAgentOverride(opts: ConnectConfig): ConnectConfig {
  if (opts.privateKey === PAGEANT_SENTINEL) {
    const { privateKey: _ignored, ...rest } = opts;
    return { ...rest, agent: "pageant" };
  }
  return opts;
}

export function openTunnel(
  config: SshTunnelConfig,
): Promise<{ tunnelId: string; localPort: number }> {
  return coreOpenTunnel<undefined>(config, undefined, { configureConnect: withAgentOverride });
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
    const baseOpts: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      privateKey: config.privateKey,
    };
    client.connect(withAgentOverride(baseOpts));
  });
}
