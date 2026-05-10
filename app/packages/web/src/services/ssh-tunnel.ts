/**
 * Web adapter over @infrawrench/ssh-tunnel-core. Tags every tunnel with
 * organizationId + accountId so cross-tenant lookups stay scoped.
 */
import {
  openTunnel as coreOpenTunnel,
  closeTunnel as coreCloseTunnel,
  getTunnelEntries,
  type TunnelExtras,
} from "@infrawrench/ssh-tunnel-core";
import type { SshTunnelConfig } from "@infrawrench/plugin-base";

export function openTunnel(
  config: SshTunnelConfig,
  organizationId: string,
  accountId: string,
): Promise<{ tunnelId: string; localPort: number }> {
  return coreOpenTunnel<TunnelExtras>(config, { organizationId, accountId });
}

export function closeTunnel(tunnelId: string): void {
  coreCloseTunnel(tunnelId);
}

export function getActiveTunnels(): Record<
  string,
  {
    localPort: number;
    sshHost: string;
    remotePort: number;
    organizationId: string;
    accountId: string;
  }
> {
  const result: Record<
    string,
    {
      localPort: number;
      sshHost: string;
      remotePort: number;
      organizationId: string;
      accountId: string;
    }
  > = {};
  for (const r of getTunnelEntries<TunnelExtras>()) {
    result[r.tunnelId] = {
      localPort: r.localPort,
      sshHost: r.sshHost,
      remotePort: r.remotePort,
      organizationId: r.extras.organizationId,
      accountId: r.extras.accountId,
    };
  }
  return result;
}
