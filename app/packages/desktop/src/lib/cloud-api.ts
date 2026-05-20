import type { OrgEntry, ResourcePickerOption } from "@infrawrench/ui";
import type { AssociationSource, ProbeStatus } from "@infrawrench/plugin-base";
import { invoke } from "./invoke";

/**
 * A cloud-managed organization visible to the desktop user.
 * Structurally identical to {@link OrgEntry} from the shared UI package —
 * re-exported here so callers can import from `./cloud-api` if they prefer.
 */
export type CloudOrg = OrgEntry;

export async function getCloudAuthStatus(): Promise<{
  authenticated: boolean;
  email?: string;
}> {
  return invoke("cloud_auth_status");
}

export async function startCloudAuth(): Promise<void> {
  await invoke("cloud_auth_start");
}

export async function getCloudOrgs(): Promise<CloudOrg[]> {
  return invoke("cloud_auth_orgs");
}

interface CloudAccount {
  id: string;
  pluginId: string;
  displayName: string;
  createdAt: string;
}

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

interface CloudDashboard {
  id: string;
  name: string;
  isDefault: boolean;
}

interface CloudDashboardPin {
  pinId: string;
  resourceId: string;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

interface CloudDashboardFull {
  dashboard: CloudDashboard & { organizationId: string; createdAt?: string };
  pins: CloudDashboardPin[];
}

export interface CloudProbeItem {
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
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

export async function listCloudAccounts(orgId: string): Promise<CloudAccount[]> {
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

export async function listCloudDashboards(orgId: string): Promise<CloudDashboard[]> {
  return invoke("cloud_list_dashboards", { orgId });
}

export async function getCloudDashboard(
  orgId: string,
  dashboardId: string,
): Promise<CloudDashboardFull> {
  return invoke("cloud_get_dashboard", { orgId, dashboardId });
}

export async function createCloudDashboard(
  orgId: string,
  name: string,
): Promise<CloudDashboard | null> {
  return invoke("cloud_create_dashboard", { orgId, name });
}

export async function deleteCloudDashboard(orgId: string, id: string): Promise<void> {
  await invoke("cloud_delete_dashboard", { orgId, id });
}

export async function renameCloudDashboard(orgId: string, id: string, name: string): Promise<void> {
  await invoke("cloud_rename_dashboard", { orgId, id, name });
}

export async function pinCloudResource(
  orgId: string,
  dashboardId: string,
  resourceId: string,
): Promise<void> {
  await invoke("cloud_pin_resource", { orgId, dashboardId, resourceId });
}

export async function unpinCloudResource(
  orgId: string,
  dashboardId: string,
  resourceId: string,
): Promise<void> {
  await invoke("cloud_unpin_resource", { orgId, dashboardId, resourceId });
}

export async function reorderCloudPins(
  orgId: string,
  dashboardId: string,
  resourceIds: string[],
): Promise<void> {
  await invoke("cloud_reorder_pins", { orgId, dashboardId, resourceIds });
}

export async function probeCloudPins(
  orgId: string,
  items: CloudProbeItem[],
): Promise<Record<string, ProbeStatus>> {
  return invoke("cloud_probe_pins", { orgId, items });
}

interface CloudEnrichedPin extends CloudDashboardPin {
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  fieldsJson: string;
  outputsJson: string;
  pluginLogoSvg: string;
  pluginDisplayName: string;
  status: ProbeStatus;
}

export async function getCloudEnrichedPin(orgId: string, pinId: string): Promise<CloudEnrichedPin> {
  return invoke("cloud_get_pin", { orgId, pinId });
}

export async function getCloudResourceDetail(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
  options?: { includePeerPanes?: boolean },
): Promise<unknown> {
  return invoke("cloud_get_resource_detail", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    parentResourceId,
    ...(options?.includePeerPanes !== undefined
      ? { includePeerPanes: options.includePeerPanes }
      : {}),
  });
}

export async function createCloudResource(
  orgId: string,
  body: {
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    fields: Record<string, unknown>;
    parentResourceId?: string;
  },
): Promise<{ id: string; displayName: string }> {
  return invoke("cloud_create_resource", { orgId, body });
}

export async function getCloudCreateConfig(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  pluginId?: string,
  parentResourceId?: string,
): Promise<unknown> {
  return invoke("cloud_get_create_config", {
    orgId,
    accountId,
    resourceTypeId,
    pluginId,
    parentResourceId,
  });
}

export async function getCloudCreatePricing(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  request: {
    regionId?: string;
    sizes: Array<{ id: string; vcpus: number; memoryMb: number }>;
  },
  pluginId?: string,
  parentResourceId?: string,
): Promise<Record<string, unknown>> {
  return invoke("cloud_get_create_pricing", {
    orgId,
    accountId,
    resourceTypeId,
    ...(request.regionId ? { regionId: request.regionId } : {}),
    sizes: request.sizes,
    pluginId,
    parentResourceId,
  });
}

export async function getCloudCreateCostEstimate(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  fields: Record<string, string>,
  pluginId?: string,
  parentResourceId?: string,
): Promise<{ estimate: unknown } | null> {
  return invoke("cloud_get_create_cost_estimate", {
    orgId,
    accountId,
    resourceTypeId,
    fields,
    pluginId,
    parentResourceId,
  });
}

export async function deleteCloudResource(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<void> {
  await invoke("cloud_delete_resource", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    parentResourceId,
  });
}

export async function exportCloudCredential(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  formatId: string,
  parentResourceId?: string,
): Promise<unknown> {
  return invoke("cloud_export_credential", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    formatId,
    parentResourceId,
  });
}

export async function getCloudManifest(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ manifest: string }> {
  return invoke("cloud_get_manifest", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    parentResourceId,
  });
}

export async function applyCloudManifest(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    manifest: string;
    parentResourceId?: string;
  },
): Promise<void> {
  await invoke("cloud_apply_manifest", { orgId, pluginId, resourceTypeId, body });
}

export async function invokeCloudAction(
  orgId: string,
  body: {
    pluginId: string;
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    actionId: string;
    parentResourceId?: string;
  },
): Promise<void> {
  await invoke("cloud_invoke_action", { orgId, body });
}

export async function runCloudNoSqlCommand(
  orgId: string,
  body: {
    pluginId: string;
    accountId: string;
    resourceTypeId: string;
    resourceId: string;
    command: string;
    args: (string | number)[];
    parentResourceId?: string;
  },
): Promise<unknown> {
  const res = (await invoke("cloud_nosql_command", { orgId, body })) as { result?: unknown };
  return res.result;
}

export async function listCloudSecretVersions(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ versions: import("@infrawrench/plugin-base").SecretVersion[] }> {
  return invoke("cloud_list_secret_versions", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    parentResourceId,
  });
}

export async function accessCloudSecretVersion(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    versionId: string;
    parentResourceId?: string;
  },
): Promise<{ value: string }> {
  return invoke("cloud_access_secret_version", { orgId, pluginId, resourceTypeId, body });
}

export async function addCloudSecretVersion(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    value: string;
    parentResourceId?: string;
  },
): Promise<{ version: import("@infrawrench/plugin-base").SecretVersion }> {
  return invoke("cloud_add_secret_version", { orgId, pluginId, resourceTypeId, body });
}

export async function modifyCloudSecretVersion(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    versionId: string;
    action: "enable" | "disable" | "destroy";
    parentResourceId?: string;
  },
): Promise<{ version: import("@infrawrench/plugin-base").SecretVersion }> {
  return invoke("cloud_modify_secret_version", { orgId, pluginId, resourceTypeId, body });
}

export async function importCloudYaml(
  orgId: string,
  pluginId: string,
  body: { accountId: string; yaml: string; parentResourceId?: string },
): Promise<{ applied: number }> {
  return invoke("cloud_import_yaml", { orgId, pluginId, body });
}

export async function getCloudDescribe(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ text: string }> {
  return invoke("cloud_describe_resource", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    parentResourceId,
  });
}

export async function getCloudLogs(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  params: { tailLines?: number; container?: string; previous?: boolean; parentResourceId?: string },
): Promise<{ text: string; containers: string[]; activeContainer: string }> {
  return invoke("cloud_get_logs", {
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    accountId,
    ...params,
  });
}

export async function fetchCloudMetrics(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: {
    accountId: string;
    resourceId: string;
    startMs?: number;
    endMs?: number;
    parentResourceId?: string;
  },
): Promise<unknown> {
  return invoke("cloud_fetch_metrics", { orgId, pluginId, resourceTypeId, body });
}

export async function fetchCloudPeerPanes(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: { accountId: string; resourceId: string; parentResourceId?: string },
): Promise<unknown> {
  return invoke("cloud_fetch_peer_panes", { orgId, pluginId, resourceTypeId, body });
}

export async function cloudSqlQuery(
  orgId: string,
  body: { accountId: string; resourceId?: string; resourceTypeId?: string; sql: string },
): Promise<unknown> {
  return invoke("cloud_sql_query", { orgId, body });
}

export async function cloudListArtifacts(
  orgId: string,
  body: {
    accountId: string;
    resourceId: string;
    resourceTypeId: string;
    pageToken?: string;
    prefix?: string;
  },
): Promise<unknown> {
  return invoke("cloud_list_artifacts", { orgId, body });
}

export async function cloudSqlExecute(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    resourceTypeId?: string;
    sql: string;
    params?: unknown[];
  },
): Promise<unknown> {
  return invoke("cloud_sql_execute", { orgId, body });
}

export async function cloudSqlEstimate(
  orgId: string,
  body: { accountId: string; resourceId: string; sql: string },
): Promise<unknown> {
  return invoke("cloud_sql_estimate", { orgId, body });
}

export async function cloudKvCommand(
  orgId: string,
  body: {
    accountId: string;
    command: string;
    args: (string | number)[];
    pluginId?: string;
    parentResourceId?: string;
  },
): Promise<unknown> {
  return invoke("cloud_kv_command", { orgId, body });
}

export async function cloudSftpList(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    path: string;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  },
): Promise<unknown> {
  return invoke("cloud_sftp_list", { orgId, body });
}

export async function cloudSftpMkdir(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    path: string;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  },
): Promise<void> {
  await invoke("cloud_sftp_mkdir", { orgId, body });
}

export async function cloudSftpDelete(
  orgId: string,
  body: {
    accountId: string;
    resourceId?: string;
    path: string;
    isDir?: boolean;
    sshKeyId?: string;
    sshHost?: string;
    sshUsername?: string;
  },
): Promise<void> {
  await invoke("cloud_sftp_delete", { orgId, body });
}

export async function cloudSftpUpload(params: {
  orgId: string;
  accountId: string;
  remotePath: string;
  data: Uint8Array;
  filename?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}): Promise<void> {
  await invoke("cloud_sftp_upload", params);
}

export async function cloudSftpDownload(params: {
  orgId: string;
  accountId: string;
  remotePath: string;
  localPath: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}): Promise<void> {
  await invoke("cloud_sftp_download", params);
}

export async function cloudSshTunnelExec(
  orgId: string,
  body: {
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    command: string;
  },
): Promise<{ stdout: string; stderr?: string; code: number }> {
  return invoke("cloud_ssh_tunnel_exec", { orgId, body });
}

export async function cloudSshTunnelCreateAccount(
  orgId: string,
  body: {
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyId: string;
    remoteHost: string;
    remotePort: number;
    pluginId: string;
    displayName: string;
    credentials: Record<string, string>;
  },
): Promise<{ accountId: string }> {
  return invoke("cloud_ssh_tunnel_create_account", { orgId, body });
}

export async function loadCloudPickerResources(
  orgId: string,
  sources: AssociationSource[],
  accountId: string,
): Promise<ResourcePickerOption[]> {
  return invoke("cloud_load_picker_resources", { orgId, sources, accountId });
}
