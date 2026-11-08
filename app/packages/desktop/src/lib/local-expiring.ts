/**
 * Local-mode expiry feed. Mirrors the server's `/expiring` endpoint against
 * the desktop SQLite: the main process runs client-core's `computeExpiryFeed`
 * over this workspace's stored accounts and resources plus the `expiryFields`
 * declarations of the loaded plugins (electron/local-expiring.ts, the same
 * code `infrawrench expiring --local` runs). Credential-free: classification
 * is a property of stored state, so it works with the network off.
 */
import type { ExpiryListResponse } from "@infrawrench/ui";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export function loadLocalExpiring(): Promise<ExpiryListResponse> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalExpiringList()));
}
