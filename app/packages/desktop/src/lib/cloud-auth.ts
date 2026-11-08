import type { OrgEntry } from "@infrawrench/ui";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/**
 * A cloud-managed organization visible to the desktop user.
 * Structurally identical to {@link OrgEntry} from the shared UI package:
 * re-exported here so callers can import from `./cloud-api` if they prefer.
 */
export type CloudOrg = OrgEntry;

export async function getCloudAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
}> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudAuthStatus()));
}

export async function startCloudAuth(): Promise<void> {
  await runRpc(DesktopRpcClient.use((rpc) => rpc.CloudAuthStart()));
}

export async function getCloudOrgs(): Promise<CloudOrg[]> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudAuthOrgs()));
}

/**
 * A short-lived single-use token for `?token=` on a cloud WebSocket upgrade,
 * minted by the main process with its session. Null when signed out.
 */
export function getCloudWsToken(orgId: string): Promise<string | null> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudWsToken({ orgId })));
}
