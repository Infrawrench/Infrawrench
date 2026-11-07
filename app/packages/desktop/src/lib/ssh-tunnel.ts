import { invoke } from "./invoke";
import { getDb } from "../db/client";
import type { KeySource } from "./ssh-key-source";

interface SshOpenTunnelPayload {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
  remoteHost: string;
  remotePort: number;
}

interface ActiveTunnelInfo {
  localPort: number;
  sshHost: string;
  remotePort: number;
}

export function sshOpenTunnel(
  payload: SshOpenTunnelPayload,
): Promise<{ tunnelId: string; localPort: number }> {
  return invoke<{ tunnelId: string; localPort: number }>("ssh_open_tunnel", { ...payload });
}

/** Why a plain tunnel cannot open with these inputs, or null when it can. */
export function plainTunnelProblem(
  remotePort: number,
  keyType: KeySource["type"] | undefined,
): "port" | "cloud-key" | null {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return "port";
  // The tunnel's local end is this computer, and a cloud key's private half never is.
  return keyType === "cloud" ? "cloud-key" : null;
}

/**
 * A tunnel to a port on the host's loopback with no account behind it, for a local
 * tool. There is nothing to reconnect it from, so the caller owns closing it.
 */
export function openPlainTunnel(
  config: Omit<SshOpenTunnelPayload, "remoteHost">,
): Promise<{ tunnelId: string; localPort: number }> {
  return sshOpenTunnel({ ...config, remoteHost: "127.0.0.1" });
}

export function sshCloseTunnel(tunnelId: string): Promise<void> {
  return invoke<void>("ssh_close_tunnel", { tunnelId });
}

function sshGetActiveTunnels(): Promise<Record<string, ActiveTunnelInfo>> {
  return invoke<Record<string, ActiveTunnelInfo>>("ssh_get_active_tunnels");
}

export function sshExecCommand(
  config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string },
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return invoke<{ stdout: string; stderr: string; code: number }>("ssh_exec_command", {
    config: { ...config },
    command,
  });
}

/**
 * If the account has an ssh_tunnel_configs row, ensures the SSH tunnel is open
 * and returns `tcp://127.0.0.1:{localPort}`. Otherwise returns `rawHost` unchanged.
 */
export async function resolveTunneledHost(accountId: string, rawHost: string): Promise<string> {
  const db = await getDb();
  const rows = await db.select<
    {
      id: string;
      ssh_host: string;
      ssh_port: number;
      ssh_user: string;
      remote_host: string;
      remote_port: number;
      encrypted_private_key: string;
      private_key_iv: string;
    }[]
  >("SELECT * FROM ssh_tunnel_configs WHERE account_id = $1 LIMIT 1", [accountId]);
  if (!rows[0]) return rawHost;

  const cfg = rows[0];
  const active = await sshGetActiveTunnels();
  const existing = Object.values(active).find(
    (t) => t.sshHost === cfg.ssh_host && t.remotePort === cfg.remote_port,
  );
  if (existing) return `tcp://127.0.0.1:${existing.localPort}`;

  const privateKey = await invoke<string>("ssh_tunnel_config_get_private_key", {
    tunnelConfigId: cfg.id,
    ciphertext: cfg.encrypted_private_key,
    iv: cfg.private_key_iv,
  });
  const { localPort } = await sshOpenTunnel({
    sshHost: cfg.ssh_host,
    sshPort: cfg.ssh_port,
    sshUser: cfg.ssh_user,
    privateKey,
    remoteHost: cfg.remote_host,
    remotePort: cfg.remote_port,
  });
  return `tcp://127.0.0.1:${localPort}`;
}
