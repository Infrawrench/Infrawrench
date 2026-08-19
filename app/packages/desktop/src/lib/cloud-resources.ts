import type { AssociationSource, CostEstimate } from "@infrawrench/plugin-base";
import { CALENDAR_EVENT_KINDS } from "@infrawrench/ui";
import type {
  AccessReviewResponse,
  BlastRadiusReport,
  BackupCoverageResponse,
  BackupPolicy,
  BackupPolicyInput,
  CalendarEventKind,
  CalendarResponse,
  CalendarSubscription,
  DependencyGraphData,
  DnsInventoryResponse,
  EnvironmentDiffResponse,
  ExpiryListResponse,
  PostureListResponse,
  ScorecardResponse,
  ResourcePickerOption,
  WallboardResponse,
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
 * One resource's impact report — what breaks if it is deleted.
 *
 * Cloud-only on purpose, and there is no local-mode counterpart: the report is
 * mostly about org objects a local workspace does not have (dashboards,
 * probes, status pages, leases, schedules, owners) and about flow attribution
 * that only the cloud collects. A local half that could only ever answer the
 * dependency-graph third would be a report whose "nothing else found" was
 * structurally untrue.
 */
export async function fetchCloudBlastRadius(
  orgId: string,
  resourceId: string,
): Promise<BlastRadiusReport> {
  return invoke("cloud_blast_radius", { orgId, resourceId });
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

/**
 * Accept a posture finding for the org. Recorded server-side — a dismissal is
 * a decision about the organization's exposure, not about this machine, so
 * every surface sees the same one. Local mode's counterpart is
 * `dismissLocalPostureFinding` in lib/local-posture.ts.
 */
export async function dismissCloudPostureFinding(
  orgId: string,
  resourceId: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  await invoke("cloud_posture_dismiss", { orgId, resourceId, ruleId, reason });
}

/** Undo a dismissal, putting the finding back on the list and in the alerts. */
export async function restoreCloudPostureFinding(
  orgId: string,
  resourceId: string,
  ruleId: string,
): Promise<void> {
  await invoke("cloud_posture_restore", { orgId, resourceId, ruleId });
}

/**
 * The org's access review — every principal inside the customer's connected
 * clouds, computed server-side over synced rows. Cloud-only: two of its five
 * rules need the ownership records and the dismissal store, which local mode
 * has neither of.
 */
export async function fetchCloudAccessReview(
  orgId: string,
  staleDays: number,
): Promise<AccessReviewResponse> {
  return invoke("cloud_access_review", { orgId, staleDays });
}

/** Accept an access-review finding for the org. Recorded server-side. */
export async function dismissCloudAccessFinding(
  orgId: string,
  resourceId: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  await invoke("cloud_access_review_dismiss", { orgId, resourceId, ruleId, reason });
}

/** Undo a dismissal, putting the finding back on the list and in the alerts. */
export async function restoreCloudAccessFinding(
  orgId: string,
  resourceId: string,
  ruleId: string,
): Promise<void> {
  await invoke("cloud_access_review_restore", { orgId, resourceId, ruleId });
}

/** The review as a CSV or JSON evidence document, returned as text to save. */
export async function exportCloudAccessReview(
  orgId: string,
  format: "csv" | "json",
  staleDays: number,
): Promise<string> {
  return invoke("cloud_access_review_export", { orgId, format, staleDays });
}

/**
 * The org's backup coverage, computed server-side over synced rows. There is
 * no local-mode counterpart: the recovery objectives it is judged against are
 * org state, and a local workspace has nowhere to store them.
 */
export async function fetchCloudBackups(orgId: string): Promise<BackupCoverageResponse> {
  return invoke("cloud_backups", { orgId });
}

export async function fetchCloudBackupPolicies(orgId: string): Promise<BackupPolicy[]> {
  const res = await invoke<{ policies: BackupPolicy[] }>("cloud_backup_policies", { orgId });
  return res.policies ?? [];
}

export async function createCloudBackupPolicy(
  orgId: string,
  input: BackupPolicyInput,
): Promise<void> {
  await invoke("cloud_backup_policy_create", { orgId, input });
}

export async function updateCloudBackupPolicy(
  orgId: string,
  policyId: string,
  patch: Partial<BackupPolicyInput>,
): Promise<void> {
  await invoke("cloud_backup_policy_update", { orgId, policyId, patch });
}

export async function deleteCloudBackupPolicy(orgId: string, policyId: string): Promise<void> {
  await invoke("cloud_backup_policy_delete", { orgId, policyId });
}

/**
 * The wallboard. Cloud only: two of its three sources (declared incidents and
 * sync paging) are org state, and the third is run by the cloud poller.
 */
export async function fetchCloudWallboard(orgId: string): Promise<WallboardResponse> {
  return invoke("cloud_wallboard", { orgId });
}

/**
 * The operations calendar for one window. Cloud only for the same reason as
 * backup coverage: most of what it projects is org state a local workspace has
 * nowhere to keep.
 */
export async function fetchCloudCalendar(
  orgId: string,
  range: { from: string; to: string; kinds: CalendarEventKind[] },
): Promise<CalendarResponse> {
  return invoke("cloud_calendar", {
    orgId,
    from: range.from,
    to: range.to,
    // Omitted rather than sent empty: empty means "every kind" server-side,
    // and enumerating them here would break the day one is added.
    ...(range.kinds.length > 0 && range.kinds.length < CALENDAR_EVENT_KINDS.length
      ? { kinds: range.kinds.join(",") }
      : {}),
  });
}

export async function fetchCloudCalendarSubscriptions(
  orgId: string,
): Promise<CalendarSubscription[]> {
  const res = await invoke<{ subscriptions: CalendarSubscription[] }>(
    "cloud_calendar_subscriptions",
    { orgId },
  );
  return res.subscriptions ?? [];
}

/** Returns the one-time subscription URL; there is no second chance to read it. */
export async function createCloudCalendarSubscription(
  orgId: string,
  input: { name: string; kinds: CalendarEventKind[] },
): Promise<string> {
  const created = await invoke<CalendarSubscription>("cloud_calendar_subscription_create", {
    orgId,
    input,
  });
  if (!created.url) throw new Error("The server did not return a subscription URL");
  return created.url;
}

export async function revokeCloudCalendarSubscription(
  orgId: string,
  subscriptionId: string,
): Promise<void> {
  await invoke("cloud_calendar_subscription_revoke", { orgId, subscriptionId });
}

/**
 * The org's infrastructure scorecard. Cloud only for the same reason backup
 * coverage is: a third of the evidence is org state a local workspace cannot
 * hold, and the trend lives in a cloud table.
 */
export async function fetchCloudScorecard(orgId: string): Promise<ScorecardResponse> {
  return invoke("cloud_scorecard", { orgId });
}

export async function fetchCloudDns(orgId: string): Promise<DnsInventoryResponse> {
  return invoke("cloud_dns", { orgId });
}

/**
 * Two of the org's accounts compared, computed server-side over synced rows.
 * The local-mode counterpart is `loadLocalEnvironmentDiff` in
 * lib/local-environment-diff.ts, which lists both accounts live instead.
 */
export async function fetchCloudEnvironmentDiff(
  orgId: string,
  query: { a: string; b: string; includeIdentityFields?: boolean },
): Promise<EnvironmentDiffResponse> {
  return invoke("cloud_environment_diff", {
    orgId,
    a: query.a,
    b: query.b,
    includeIdentityFields: query.includeIdentityFields === true,
  });
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

/**
 * Monthly cost estimate for a configuration. Pass `fields` to price a
 * proposed create, `resourceId` to price an existing resource, or both to
 * price a proposed edit — the server merges `fields` over the resource's
 * stored fields, so only the changed keys have to be sent.
 */
export async function getCloudCostEstimate(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  options: {
    fields?: Record<string, string>;
    resourceId?: string;
    pluginId?: string;
    parentResourceId?: string;
  } = {},
): Promise<CostEstimate | null> {
  const res = await invoke<{ estimate: CostEstimate | null }>("cloud_get_cost_estimate", {
    orgId,
    accountId,
    resourceTypeId,
    ...options,
  });
  return res?.estimate ?? null;
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
