/**
 * Desktop adapter over @infrawrench/ssh-tunnel-core. Adds external-agent
 * support (Pageant on Windows, 1Password on any platform) via sentinel
 * private-key strings, plus an sshExecCommand helper that reuses the same
 * connect logic for one-off commands.
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
