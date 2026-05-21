/**
 * Web adapter over @infrawrench/ssh-tunnel-core. Tags every tunnel with
 * organizationId + accountId so cross-tenant lookups stay scoped, and wires
 * the SSH host-key verifier through `verifyHostKey` so any unknown / mismatch
 * surfaces as `HostKeyTrustRequiredError` instead of a silent TOFU pin.
 */
import {
  openTunnel as coreOpenTunnel,
  closeTunnel as coreCloseTunnel,
  getTunnelEntries,
  type TunnelExtras,
} from "@infrawrench/ssh-tunnel-core";
import type { SshTunnelConfig } from "@infrawrench/plugin-base";
import { HostKeyTrustRequiredError, makeHostKeyConfigureConnect } from "./ssh-host-keys";

export async function openTunnel(
  config: SshTunnelConfig,
  organizationId: string,
  accountId: string,
): Promise<{ tunnelId: string; localPort: number }> {
  const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
  try {
    return await coreOpenTunnel<TunnelExtras>(
      config,
      { organizationId, accountId },
      {
        configureConnect: makeHostKeyConfigureConnect(
          organizationId,
          hostKeyErrorRef,
          "ssh-tunnel",
        ),
      },
    );
  } catch (e) {
    if (hostKeyErrorRef.value) throw hostKeyErrorRef.value;
    throw e;
  }
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
