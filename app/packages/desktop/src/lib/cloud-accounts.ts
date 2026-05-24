import type { Account } from "@infrawrench/ui";
import { invoke } from "./invoke";

interface CloudResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: string;
  outputsJson: string;
  parentResourceId: string | null;
}

interface CloudResourceTypeSummary {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId?: string | null;
  supportsCreate: boolean;
}

interface CloudAccountDetail {
  account: { id: string; pluginId: string; displayName: string };
  resourceTypes: CloudResourceTypeSummary[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
}

interface CloudResourceSyncItem {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  parentResourceId: string | null;
}

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
): Promise<CloudResource[]> {
  return invoke("cloud_list_account_resources", { orgId, accountId });
}

export async function getCloudAccountDetail(
  orgId: string,
  accountId: string,
): Promise<CloudAccountDetail | null> {
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
