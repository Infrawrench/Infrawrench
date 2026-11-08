/**
 * The cloud org's SSH keys, through the main process's signed-in session
 * (`shared/rpc/groups/cloud-ssh-keys.ts`).
 */
import type { CloudSshKey, GeneratedCloudSshKey } from "../../shared/rpc/groups/cloud-ssh-keys";
import { DesktopRpcClient, runRpc } from "./rpc/client";

export type { CloudSshKey, GeneratedCloudSshKey };

export function listCloudSshKeys(orgId: string): Promise<CloudSshKey[]> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudSshKeysList({ orgId })));
}

/** A fresh Ed25519 pair; the private key is in this answer and nowhere else. */
export function createCloudSshKey(orgId: string, name: string): Promise<GeneratedCloudSshKey> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudSshKeysCreate({ orgId, name })));
}

export function deleteCloudSshKey(orgId: string, id: string): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.CloudSshKeysDelete({ orgId, id })));
}
