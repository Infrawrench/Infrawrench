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
import net from "node:net";
import type { SshTunnelConfig } from "@infrawrench/plugin-base";
import { HostKeyTrustRequiredError, makeHostKeyConfigureConnect } from "./ssh-host-keys";
import { resolveSafeHost } from "./host-validation";

/**
 * Open a TCP connection to `address` (an already-vetted IP literal) and
 * resolve once it's established.
 */
function connectPinned(address: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

export async function openTunnel(
  config: SshTunnelConfig,
  organizationId: string,
  accountId: string,
): Promise<{ tunnelId: string; localPort: number }> {
  const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };

  // SSRF: resolve once, check every answer, then dial the address we cleared.
  // Handing the hostname to ssh2 instead would re-resolve it, leaving a window
  // for a short-TTL record to swap in an internal address after the check.
  const address = await resolveSafeHost(config.sshHost);
  const sock = await connectPinned(address, config.sshPort);

  const withHostKey = makeHostKeyConfigureConnect(organizationId, hostKeyErrorRef, "ssh-tunnel");
  try {
    return await coreOpenTunnel<TunnelExtras>(
      config,
      { organizationId, accountId },
      {
        // `host` stays the hostname so host-key trust records remain keyed to
        // the name the user configured; ssh2 uses `sock` for transport and
        // ignores host/port when one is supplied.
        configureConnect: (opts) => ({ ...withHostKey(opts), sock }),
      },
    );
  } catch (e) {
    sock.destroy();
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
