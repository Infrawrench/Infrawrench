import type { Account, AccountDetail, Resource } from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * `POST /accounts/:id/sync-type/:typeId` returns the same `Resource` shape
 * minus the `accountId` field (the caller already knows which account).
 */
type CloudResourceSyncItem = Omit<Resource, "accountId">;

export async function listCloudAccounts(orgId: string): Promise<Account[]> {
  return invoke("cloud_list_accounts", { orgId });
}

export async function createCloudAccount(
  orgId: string,
  pluginId: string,
  displayName: string,
  credentials: Record<string, string>,
): Promise<{ id: string } | null> {
  return invoke("cloud_create_account", { orgId, pluginId, displayName, credentials });
}

export async function listCloudAccountResources(
  orgId: string,
  accountId: string,
): Promise<Resource[]> {
  return invoke("cloud_list_account_resources", { orgId, accountId });
}

export async function getCloudAccountDetail(
  orgId: string,
  accountId: string,
): Promise<AccountDetail | null> {
  return invoke("cloud_get_account_detail", { orgId, accountId });
}

export async function syncCloudAccountType(
  orgId: string,
  accountId: string,
  typeId: string,
): Promise<CloudResourceSyncItem[]> {
  return invoke("cloud_sync_account_type", { orgId, accountId, typeId });
}

export async function deleteCloudAccount(orgId: string, accountId: string): Promise<void> {
  await invoke("cloud_delete_account", { orgId, accountId });
}

export async function renameCloudAccount(
  orgId: string,
  accountId: string,
  displayName: string,
): Promise<{ id: string; displayName: string }> {
  return invoke("cloud_rename_account", { orgId, accountId, displayName });
}

export async function updateCloudAccountCredentials(
  orgId: string,
  accountId: string,
  credentials: Record<string, string>,
): Promise<void> {
  await invoke("cloud_update_account_credentials", { orgId, accountId, credentials });
}
