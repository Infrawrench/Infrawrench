import type { AssociationSource } from "@infrawrench/plugin-base";
import type {
  DependencyGraphData,
  ExpiryListResponse,
  PostureListResponse,
  ResourcePickerOption,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * The org dependency graph. Pass `resourceId` to get only that resource's
 * direct neighbourhood — the Dependencies tab wants nothing else, and the
 * whole-org answer is expensive to build and to ship.
 */
export async function fetchCloudDependencyGraph(
  orgId: string,
  resourceId?: string,
): Promise<DependencyGraphData> {
  return invoke("cloud_dependency_graph", resourceId ? { orgId, resourceId } : { orgId });
}

/**
 * The org expiry feed, computed server-side over synced rows. The local-mode
 * counterpart is `loadLocalExpiring` in lib/local-expiring.ts.
 */
export async function fetchCloudExpiring(orgId: string): Promise<ExpiryListResponse> {
  return invoke("cloud_expiring", { orgId });
}

/**
 * The org posture findings, computed server-side over synced rows. The
 * local-mode counterpart is `loadLocalPosture` in lib/local-posture.ts.
 */
export async function fetchCloudPosture(orgId: string): Promise<PostureListResponse> {
  return invoke("cloud_posture", { orgId });
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

export async function updateCloudResource(
  orgId: string,
  body: {
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    resourceId: string;
    fields: Record<string, string>;
    parentResourceId?: string;
  },
): Promise<{ id: string; displayName: string; fields: Record<string, string> }> {
  return invoke("cloud_update_resource", { orgId, body });
}

export async function cloudTunnelSshAttach(
  orgId: string,
  body: {
    tunnel: { accountId: string; pluginId: string; resourceId: string };
    host: { accountId: string; pluginId: string; resourceTypeId: string; resourceId: string };
    hostname: string;
    zoneId: string;
    serviceType?: "http" | "https" | "ssh" | "tcp";
    port?: string;
    sshUsername: string;
    sshKeyId?: string;
  },
): Promise<{
  steps: Array<{ label: string; ok: boolean; detail?: string }>;
  connectCommand?: string;
}> {
  return invoke("cloud_tunnel_ssh_attach", { orgId, body });
}

export async function cloudListSshKeys(
  orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  return invoke("cloud_list_ssh_keys", { orgId });
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

/**
 * `POST /resources/:pluginId/:typeId/metrics`. The route answers with a
 * `{ series }` envelope, not a bare array — callers validate the payload, so
 * the series itself stays `unknown`.
 */
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
): Promise<{ series: unknown }> {
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

export async function loadCloudPickerResources(
  orgId: string,
  sources: AssociationSource[],
  accountId: string,
  opts?: { regionHint?: string; crossAccount?: boolean },
): Promise<ResourcePickerOption[]> {
  return invoke("cloud_load_picker_resources", {
    orgId,
    sources,
    accountId,
    ...(opts?.regionHint ? { regionHint: opts.regionHint } : {}),
    ...(opts?.crossAccount ? { crossAccount: true } : {}),
  });
}
