/**
 * Local-mode DNS inventory. Mirrors the server's `/dns` endpoint against the
 * desktop SQLite: the main process runs client-core's `computeDnsInventory`
 * over this workspace's stored accounts and resources plus the `dnsRole` and
 * `dnsServiceHosts` declarations of the loaded plugins (electron/local-dns.ts,
 * the same code `infrawrench dns --local` runs). Credential-free: the
 * classification is a property of stored state, so it works with the network
 * off, and no DNS is resolved either way.
 */
import type { DnsInventoryResponse } from "@infrawrench/ui";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export function loadLocalDns(): Promise<DnsInventoryResponse> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalDnsInventory()));
}
