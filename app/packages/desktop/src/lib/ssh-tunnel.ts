import { DesktopRpcClient, runRpc } from "./rpc/client";
import type { KeySource } from "./ssh-key-source";

interface SshOpenTunnelPayload {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
  remoteHost: string;
  remotePort: number;
}

export function sshOpenTunnel(
  payload: SshOpenTunnelPayload,
): Promise<{ tunnelId: string; localPort: number }> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.SshTunnelOpen({ ...payload })));
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
  return runRpc(DesktopRpcClient.use((rpc) => rpc.SshTunnelClose({ tunnelId })));
}

export function sshExecCommand(
  config: { sshHost: string; sshPort: number; sshUser: string; privateKey: string },
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runRpc(
    DesktopRpcClient.use((rpc) => rpc.SshExecCommand({ config: { ...config }, command })),
  );
}
