import type { AssociationSource, CostEstimate } from "@infrawrench/plugin-base";
import type {
  ComplianceControlSetting,
  ComplianceControlSettingInput,
  ComplianceFrameworkSummary,
  CompliancePackSchedule,
  CompliancePackScheduleInput,
  CompliancePeriod,
  ComplianceStatusResponse,
  ReportDeliveryTargets,
  ReportNotificationSendResult,
  ResourceCarbonEstimate,
} from "@infrawrench/client-core";
// From client-core, where it is defined, rather than through the `@infrawrench/ui`
// barrel that re-exports it: this is the only *value* the cloud API modules take
// from `ui`, and importing it from there pulls the whole component library into
// every module graph that touches `cloud-api`, including a node-environment
// test that renders nothing.
import { CALENDAR_EVENT_KINDS } from "@infrawrench/client-core";
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
  DrillCoverage,
  RestoreDrillInput,
  DnsInventoryResponse,
  EnvironmentDiffResponse,
  ExpiryListResponse,
  PostureListResponse,
  LeakedCredentialsClient,
  VulnerabilityListResponse,
  VulnerabilitySettings,
  VulnerabilitySettingsPatch,
  Runbook,
  RunbookInput,
  RunbookRun,
  RunbookStepInput,
  RunbookStepStatus,
  QueryMonitor,
  QueryMonitorInput,
  QueryMonitorTargetAccount,
  QueryMonitorTestResult,
  ResourcePickerOption,
  WallboardResponse,
} from "@infrawrench/ui";
import type {
  AccessReviewRuleId,
  LeakedSecret,
  LeakedSecretListResponse,
} from "@infrawrench/client-core";
import { Effect, Predicate } from "effect";
import { cloudClient } from "./cloud-client";
import { definedFields } from "./cloud-payload";
import { runRpc } from "./rpc/client";

/** The contract's `resources` group: detail, create/update/delete, manifests, logs, pickers. */
const resources = () => cloudClient("resources").resources;

/**
 * The org dependency graph. Pass `resourceId` to get only that resource's
 * direct neighbourhood: the Dependencies tab wants nothing else, and the
 * whole-org answer is expensive to build and to ship.
 */
export async function fetchCloudDependencyGraph(
  orgId: string,
  resourceId?: string,
): Promise<DependencyGraphData> {
  return runRpc(
    cloudClient("dependencyGraph").dependencyGraph.get({
      params: { orgId },
      query: resourceId ? { resourceId } : {},
    }),
  );
}

/**
 * One resource's impact report: what breaks if it is deleted.
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
  return runRpc(
    cloudClient("blastRadius").blastRadius.get({ params: { orgId }, query: { resourceId } }),
  );
}

/**
 * The org expiry feed, computed server-side over synced rows. The local-mode
 * counterpart is `loadLocalExpiring` in lib/local-expiring.ts.
 */
export async function fetchCloudExpiring(orgId: string): Promise<ExpiryListResponse> {
  return runRpc(cloudClient("expiring").expiring.list({ params: { orgId } }));
}

/**
 * The org posture findings, computed server-side over synced rows. The
 * local-mode counterpart is `loadLocalPosture` in lib/local-posture.ts.
 */
export async function fetchCloudPosture(orgId: string): Promise<PostureListResponse> {
  return runRpc(cloudClient("posture").posture.list({ params: { orgId } }));
}

/**
 * Accept a posture finding for the org. Recorded server-side: a dismissal is
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
  await runRpc(
    cloudClient("posture").posture.dismiss({
      params: { orgId },
      payload: { resourceId, ruleId, reason },
    }),
  );
}

/**
 * The leaked-credentials client for the Posture tab and the account banner.
 * Cloud only: scanning runs in the cloud poller. Without `canWrite` it gets
 * only the list, which renders the section read-only (the server enforces
 * `secrets:write` either way).
 */
export function cloudLeakedCredentialsClient(
  orgId: string,
  canWrite: boolean,
): LeakedCredentialsClient {
  const leaks = () => cloudClient("leakedSecrets").leakedSecrets;
  const leakOf = async (call: Promise<{ leak: LeakedSecret }>): Promise<LeakedSecret> =>
    (await call).leak;
  return {
    list: (): Promise<LeakedSecretListResponse> =>
      runRpc(leaks().list({ params: { orgId }, query: {} })),
    ...(canWrite
      ? {
          rotate: (id, input) =>
            leakOf(runRpc(leaks().rotate({ params: { orgId, id }, payload: input }))),
          markRotated: (id, input) =>
            leakOf(runRpc(leaks().markRotated({ params: { orgId, id }, payload: input }))),
          dismiss: (id, input) =>
            leakOf(runRpc(leaks().dismiss({ params: { orgId, id }, payload: input }))),
          reopen: (id) => leakOf(runRpc(leaks().reopen({ params: { orgId, id } }))),
          scan: () => runRpc(leaks().scan({ params: { orgId } })),
        }
      : {}),
  };
}

/** Open leaks for one account, for the account page banner. */
export async function fetchCloudAccountLeaks(
  orgId: string,
  accountId: string,
): Promise<LeakedSecretListResponse> {
  return runRpc(
    cloudClient("leakedSecrets").leakedSecrets.list({
      params: { orgId },
      query: { status: "open", accountId },
    }),
  );
}

/** Undo a dismissal, putting the finding back on the list and in the alerts. */
export async function restoreCloudPostureFinding(
  orgId: string,
  resourceId: string,
  ruleId: string,
): Promise<void> {
  await runRpc(
    cloudClient("posture").posture.restore({ params: { orgId }, query: { resourceId, ruleId } }),
  );
}

/**
 * The org's vulnerability feed: scanner findings joined server-side to the
 * resources running them. Cloud only; collection needs the poller.
 */
export async function fetchCloudVulnerabilities(orgId: string): Promise<VulnerabilityListResponse> {
  return runRpc(
    cloudClient("vulnerabilities").vulnerabilities.list({ params: { orgId }, query: {} }),
  );
}

/** Accept an advisory for one artifact (`artifactKey`) or everywhere (`"*"`). */
export async function dismissCloudVulnerability(
  orgId: string,
  advisoryId: string,
  artifactKey: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.trim();
  await runRpc(
    cloudClient("vulnerabilities").vulnerabilities.dismiss({
      params: { orgId },
      payload: { advisoryId, artifactKey, ...(trimmed ? { reason: trimmed } : {}) },
    }),
  );
}

/** Undo a vulnerability dismissal. */
export async function restoreCloudVulnerability(
  orgId: string,
  advisoryId: string,
  artifactKey: string,
): Promise<void> {
  // The key travels in the query: artifact keys carry slashes.
  await runRpc(
    cloudClient("vulnerabilities").vulnerabilities.restore({
      params: { orgId },
      query: { advisoryId, artifactKey },
    }),
  );
}

/** The org's vulnerability alert settings (server requires `org:settings:write`). */
export async function fetchCloudVulnerabilitySettings(
  orgId: string,
): Promise<VulnerabilitySettings> {
  return runRpc(cloudClient("vulnerabilities").vulnerabilities.getSettings({ params: { orgId } }));
}

export async function updateCloudVulnerabilitySettings(
  orgId: string,
  patch: VulnerabilitySettingsPatch,
): Promise<VulnerabilitySettings> {
  return runRpc(
    cloudClient("vulnerabilities").vulnerabilities.updateSettings({
      params: { orgId },
      payload: patch,
    }),
  );
}

/* Compliance: cloud only, like Vulnerabilities. Reads are `audit:read`;
 * control decisions and pack schedules `org:settings:write` server-side. */

const compliance = () => cloudClient("compliance").compliance;

/** The bodies the endpoints take: optional keys the editors leave `undefined` are dropped. */
function complianceControlPayload(input: ComplianceControlSettingInput) {
  return {
    applicable: input.applicable,
    ...(input.justification !== undefined ? { justification: input.justification } : {}),
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.ownerLabel !== undefined ? { ownerLabel: input.ownerLabel } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
}

function compliancePackSchedulePayload(input: CompliancePackScheduleInput) {
  return {
    frameworkId: input.frameworkId,
    cadence: input.cadence,
    ...(input.sendDayOfMonth !== undefined ? { sendDayOfMonth: input.sendDayOfMonth } : {}),
    hour: input.hour,
    timezone: input.timezone,
    emailRecipients: input.emailRecipients,
    ...(input.slackChannelIds !== undefined ? { slackChannelIds: input.slackChannelIds } : {}),
    ...(input.teamsWebhookIds !== undefined ? { teamsWebhookIds: input.teamsWebhookIds } : {}),
    enabled: input.enabled,
  };
}

export async function fetchCloudComplianceFrameworks(
  orgId: string,
): Promise<ComplianceFrameworkSummary[]> {
  const res = await runRpc(compliance().frameworks({ params: { orgId } }));
  return res.frameworks;
}

export async function fetchCloudComplianceStatus(
  orgId: string,
  framework: string,
  period: CompliancePeriod,
): Promise<ComplianceStatusResponse> {
  return runRpc(
    compliance().status({
      params: { orgId },
      query: {
        framework,
        ...(period.from ? { from: period.from } : {}),
        ...(period.to ? { to: period.to } : {}),
      },
    }),
  );
}

/** The evidence pack ZIP as bytes; the caller saves it. */
export function loadCloudCompliancePack(
  orgId: string,
  framework: string,
  period: CompliancePeriod,
): Promise<Uint8Array> {
  return runRpc(
    compliance().pack({
      params: { orgId },
      query: {
        framework,
        ...(period.from ? { from: period.from } : {}),
        ...(period.to ? { to: period.to } : {}),
      },
    }),
  );
}

export async function putCloudComplianceControl(
  orgId: string,
  frameworkId: string,
  controlId: string,
  input: ComplianceControlSettingInput,
): Promise<ComplianceControlSetting> {
  return runRpc(
    compliance().putControl({
      params: { orgId, frameworkId, controlId },
      payload: complianceControlPayload(input),
    }),
  );
}

export async function deleteCloudComplianceControl(
  orgId: string,
  frameworkId: string,
  controlId: string,
): Promise<void> {
  await runRpc(compliance().deleteControl({ params: { orgId, frameworkId, controlId } }));
}

export async function listCloudCompliancePackSchedules(
  orgId: string,
  framework: string,
): Promise<CompliancePackSchedule[]> {
  return runRpc(
    compliance().listSchedules({ params: { orgId }, query: framework ? { framework } : {} }),
  );
}

export async function fetchCloudCompliancePackTargets(
  orgId: string,
): Promise<ReportDeliveryTargets> {
  return runRpc(compliance().scheduleTargets({ params: { orgId } }));
}

export async function createCloudCompliancePackSchedule(
  orgId: string,
  input: CompliancePackScheduleInput,
): Promise<CompliancePackSchedule> {
  return runRpc(
    compliance().createSchedule({
      params: { orgId },
      payload: compliancePackSchedulePayload(input),
    }),
  );
}

export async function updateCloudCompliancePackSchedule(
  orgId: string,
  scheduleId: string,
  input: CompliancePackScheduleInput,
): Promise<CompliancePackSchedule> {
  return runRpc(
    compliance().updateSchedule({
      params: { orgId, id: scheduleId },
      payload: compliancePackSchedulePayload(input),
    }),
  );
}

export async function deleteCloudCompliancePackSchedule(
  orgId: string,
  scheduleId: string,
): Promise<void> {
  await runRpc(compliance().deleteSchedule({ params: { orgId, id: scheduleId } }));
}

export async function sendCloudCompliancePackScheduleNow(
  orgId: string,
  scheduleId: string,
): Promise<ReportNotificationSendResult> {
  return runRpc(compliance().sendSchedule({ params: { orgId, id: scheduleId } }));
}

/**
 * The org's access review: every principal inside the customer's connected
 * clouds, computed server-side over synced rows. Cloud-only: two of its five
 * rules need the ownership records and the dismissal store, which local mode
 * has neither of.
 */
export async function fetchCloudAccessReview(
  orgId: string,
  staleDays: number,
): Promise<AccessReviewResponse> {
  return runRpc(
    cloudClient("accessReview").accessReview.review({
      params: { orgId },
      query: { staleDays: String(staleDays) },
    }),
  );
}

/** Accept an access-review finding for the org. Recorded server-side. */
export async function dismissCloudAccessFinding(
  orgId: string,
  resourceId: string,
  ruleId: AccessReviewRuleId,
  reason: string,
): Promise<void> {
  await runRpc(
    cloudClient("accessReview").accessReview.dismiss({
      params: { orgId },
      payload: { resourceId, ruleId, reason },
    }),
  );
}

/** Undo a dismissal, putting the finding back on the list and in the alerts. */
export async function restoreCloudAccessFinding(
  orgId: string,
  resourceId: string,
  ruleId: string,
): Promise<void> {
  await runRpc(
    cloudClient("accessReview").accessReview.restore({
      params: { orgId },
      query: { resourceId, ruleId },
    }),
  );
}

/**
 * The review as a CSV or JSON evidence document, returned as the text the
 * server wrote, to save byte for byte.
 */
export function exportCloudAccessReview(
  orgId: string,
  format: "csv" | "json",
  staleDays: number,
): Promise<string> {
  return runRpc(
    cloudClient("accessReview")
      .accessReview.export({
        params: { orgId },
        query: { format, staleDays: String(staleDays) },
      })
      // A text endpoint answers the body as sent, its JSON form included; the
      // object branch is the type's, never taken.
      .pipe(
        Effect.map((body) => (Predicate.isString(body) ? body : JSON.stringify(body, null, 2))),
      ),
  );
}

/**
 * The org's backup coverage, computed server-side over synced rows. There is
 * no local-mode counterpart: the recovery objectives it is judged against are
 * org state, and a local workspace has nowhere to store them.
 */
export async function fetchCloudBackups(orgId: string): Promise<BackupCoverageResponse> {
  return runRpc(cloudClient("backups").backups.coverage({ params: { orgId } }));
}

export async function fetchCloudBackupPolicies(orgId: string): Promise<BackupPolicy[]> {
  const res = await runRpc(cloudClient("backups").backups.listPolicies({ params: { orgId } }));
  return res.policies ?? [];
}

export async function createCloudBackupPolicy(
  orgId: string,
  input: BackupPolicyInput,
): Promise<void> {
  await runRpc(cloudClient("backups").backups.createPolicy({ params: { orgId }, payload: input }));
}

export async function updateCloudBackupPolicy(
  orgId: string,
  policyId: string,
  patch: Partial<BackupPolicyInput>,
): Promise<void> {
  await runRpc(
    cloudClient("backups").backups.updatePolicy({ params: { orgId, policyId }, payload: patch }),
  );
}

export async function deleteCloudBackupPolicy(orgId: string, policyId: string): Promise<void> {
  await runRpc(cloudClient("backups").backups.deletePolicy({ params: { orgId, policyId } }));
}

/**
 * The wallboard. Cloud only: three of its four sources (declared incidents,
 * query monitors, sync paging) are org state.
 */
export async function fetchCloudWallboard(orgId: string): Promise<WallboardResponse> {
  return runRpc(cloudClient("wallboard").wallboard.get({ params: { orgId } }));
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
  return runRpc(
    cloudClient("calendar").calendar.list({
      params: { orgId },
      query: {
        from: range.from,
        to: range.to,
        // Omitted rather than sent empty: empty means "every kind" server-side,
        // and enumerating them here would break the day one is added.
        ...(range.kinds.length > 0 && range.kinds.length < CALENDAR_EVENT_KINDS.length
          ? { kinds: range.kinds.join(",") }
          : {}),
      },
    }),
  );
}

export async function fetchCloudCalendarSubscriptions(
  orgId: string,
): Promise<CalendarSubscription[]> {
  const res = await runRpc(
    cloudClient("calendar").calendar.listSubscriptions({ params: { orgId } }),
  );
  return res.subscriptions;
}

/** Returns the one-time subscription URL; there is no second chance to read it. */
export async function createCloudCalendarSubscription(
  orgId: string,
  input: { name: string; kinds: CalendarEventKind[] },
): Promise<string> {
  const created: CalendarSubscription = await runRpc(
    cloudClient("calendar").calendar.createSubscription({ params: { orgId }, payload: input }),
  );
  if (!created.url) throw new Error("The server did not return a subscription URL");
  return created.url;
}

export async function revokeCloudCalendarSubscription(
  orgId: string,
  subscriptionId: string,
): Promise<void> {
  await runRpc(
    cloudClient("calendar").calendar.revokeSubscription({ params: { orgId, subscriptionId } }),
  );
}

/**
 * Runbooks and the runs performed against them. Cloud only: both are org state
 * a single-machine workspace has nowhere to keep.
 */
export async function fetchCloudRunbooks(orgId: string): Promise<Runbook[]> {
  const res = await runRpc(cloudClient("runbooks").runbooks.list({ params: { orgId } }));
  return res.runbooks ?? [];
}

export async function fetchCloudRunbookRuns(orgId: string): Promise<RunbookRun[]> {
  const res = await runRpc(
    cloudClient("runbooks").runbooks.listRuns({ params: { orgId }, query: { limit: 50 } }),
  );
  return res.runs ?? [];
}

/**
 * A step as the endpoint takes it: client-core lets a form leave an optional
 * field explicitly `undefined`, which the endpoint's schema refuses, so only
 * the fields that are set are sent (what `JSON.stringify` sent before).
 */
function runbookStepPayload(step: RunbookStepInput) {
  return {
    kind: step.kind,
    title: step.title,
    ...(step.id !== undefined ? { id: step.id } : {}),
    ...(step.body !== undefined ? { body: step.body } : {}),
    ...(step.workflowId !== undefined ? { workflowId: step.workflowId } : {}),
    ...(step.url !== undefined ? { url: step.url } : {}),
  };
}

export async function createCloudRunbook(orgId: string, input: RunbookInput): Promise<void> {
  const { steps, ...rest } = input;
  const payload = { ...rest, ...(steps ? { steps: steps.map(runbookStepPayload) } : {}) };
  await runRpc(cloudClient("runbooks").runbooks.create({ params: { orgId }, payload }));
}

export async function updateCloudRunbook(
  orgId: string,
  runbookId: string,
  patch: Partial<RunbookInput>,
): Promise<void> {
  const { steps, ...rest } = patch;
  const payload = { ...rest, ...(steps ? { steps: steps.map(runbookStepPayload) } : {}) };
  await runRpc(cloudClient("runbooks").runbooks.update({ params: { orgId, runbookId }, payload }));
}

export async function deleteCloudRunbook(orgId: string, runbookId: string): Promise<void> {
  await runRpc(cloudClient("runbooks").runbooks.delete({ params: { orgId, runbookId } }));
}

export async function startCloudRunbookRun(orgId: string, runbookId: string): Promise<void> {
  await runRpc(
    cloudClient("runbooks").runbooks.startRun({ params: { orgId, runbookId }, payload: {} }),
  );
}

export async function updateCloudRunbookStep(
  orgId: string,
  runId: string,
  stepId: string,
  patch: { status: RunbookStepStatus; note?: string | null },
): Promise<void> {
  await runRpc(
    cloudClient("runbooks").runbooks.tickStep({ params: { orgId, runId, stepId }, payload: patch }),
  );
}

export async function closeCloudRunbookRun(
  orgId: string,
  runId: string,
  status: "completed" | "abandoned",
  summary: string | null,
): Promise<void> {
  await runRpc(
    cloudClient("runbooks").runbooks.closeRun({
      params: { orgId, runId },
      payload: { status, summary },
    }),
  );
}

/**
 * Restore-drill standings: the Backups screen's fourth tab. A third read
 * rather than part of the coverage payload: the standings are computed *over*
 * the coverage, and folding them in would make the coverage endpoint pay for
 * them on every surface that only wants gaps.
 */
export async function fetchCloudRestoreDrills(orgId: string): Promise<DrillCoverage> {
  return runRpc(cloudClient("backups").backups.drillCoverage({ params: { orgId }, query: {} }));
}

export async function recordCloudRestoreDrill(
  orgId: string,
  input: RestoreDrillInput,
): Promise<void> {
  await runRpc(cloudClient("backups").backups.recordDrill({ params: { orgId }, payload: input }));
}

/**
 * Query monitors. Cloud only: the schedule is run by the cloud poller, so a
 * monitor stored locally would only run while the app was open.
 */
export async function fetchCloudQueryMonitors(orgId: string): Promise<QueryMonitor[]> {
  const res = await runRpc(cloudClient("queryMonitors").queryMonitors.list({ params: { orgId } }));
  return res.monitors ?? [];
}

export async function fetchCloudQueryMonitorTargets(
  orgId: string,
): Promise<QueryMonitorTargetAccount[]> {
  const res = await runRpc(
    cloudClient("queryMonitors").queryMonitors.targets({ params: { orgId } }),
  );
  return res.accounts ?? [];
}

export async function createCloudQueryMonitor(
  orgId: string,
  input: QueryMonitorInput,
): Promise<void> {
  await runRpc(
    cloudClient("queryMonitors").queryMonitors.create({ params: { orgId }, payload: input }),
  );
}

export async function updateCloudQueryMonitor(
  orgId: string,
  monitorId: string,
  patch: Partial<QueryMonitorInput>,
): Promise<void> {
  await runRpc(
    cloudClient("queryMonitors").queryMonitors.update({
      params: { orgId, monitorId },
      payload: patch,
    }),
  );
}

export async function deleteCloudQueryMonitor(orgId: string, monitorId: string): Promise<void> {
  await runRpc(cloudClient("queryMonitors").queryMonitors.delete({ params: { orgId, monitorId } }));
}

export async function testCloudQueryMonitor(
  orgId: string,
  input: Partial<QueryMonitorInput>,
): Promise<QueryMonitorTestResult> {
  return runRpc(
    cloudClient("queryMonitors").queryMonitors.test({ params: { orgId }, payload: input }),
  );
}

export async function fetchCloudDns(orgId: string): Promise<DnsInventoryResponse> {
  return runRpc(cloudClient("dns").dns.list({ params: { orgId } }));
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
  const diff = await runRpc(
    cloudClient("environmentDiff").environmentDiff.get({
      params: { orgId },
      query: {
        a: query.a,
        b: query.b,
        ...(query.includeIdentityFields === true ? { includeIdentityFields: "true" } : {}),
      },
    }),
  );
  // A side whose key is absent arrives without `a`/`b` (JSON drops an
  // undefined value); client-core's change names both sides.
  return {
    ...diff,
    entries: diff.entries.map((entry) => ({
      ...entry,
      changes: entry.changes.map((change) => ({ field: change.field, a: change.a, b: change.b })),
    })),
  };
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
  return runRpc(
    resources().detail({
      params: { orgId, pluginId, typeId: resourceTypeId },
      query: {
        resourceId,
        accountId,
        ...(parentResourceId ? { parentResourceId } : {}),
        // Only `false` is sent: the server's default is true.
        ...(options?.includePeerPanes === false ? { includePeerPanes: "false" } : {}),
      },
    }),
  );
}

export async function createCloudResource(
  orgId: string,
  body: {
    accountId: string;
    pluginId: string;
    resourceTypeId: string;
    /** Create-form values: the endpoint takes strings only, as the form produces. */
    fields: Record<string, string>;
    parentResourceId?: string;
  },
): Promise<{ id: string; displayName: string }> {
  return runRpc(resources().create({ params: { orgId }, payload: definedFields(body) }));
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
  return runRpc(resources().update({ params: { orgId }, payload: definedFields(body) }));
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
  return runRpc(resources().tunnelSshAttach({ params: { orgId }, payload: body }));
}

export async function cloudListSshKeys(
  orgId: string,
): Promise<Array<{ id: string; name: string; ownerName: string }>> {
  return runRpc(cloudClient("sshKeys").sshKeys.list({ params: { orgId } }));
}

export async function getCloudCreateConfig(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  pluginId?: string,
  parentResourceId?: string,
): Promise<unknown> {
  return runRpc(
    resources().createConfig({
      params: { orgId },
      payload: {
        accountId,
        resourceTypeId,
        ...(pluginId ? { pluginId } : {}),
        ...(parentResourceId ? { parentResourceId } : {}),
      },
    }),
  );
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
  return runRpc(
    resources().createPricing({
      params: { orgId },
      payload: {
        accountId,
        resourceTypeId,
        ...(request.regionId ? { regionId: request.regionId } : {}),
        sizes: request.sizes,
        ...(pluginId ? { pluginId } : {}),
        ...(parentResourceId ? { parentResourceId } : {}),
      },
    }),
  );
}

/**
 * Monthly cost estimate for a configuration. Pass `fields` to price a
 * proposed create, `resourceId` to price an existing resource, or both to
 * price a proposed edit: the server merges `fields` over the resource's
 * stored fields, so only the changed keys have to be sent.
 */
type CostEstimateResponse = {
  estimate: CostEstimate | null;
  carbon?: ResourceCarbonEstimate | null;
};

type CostEstimateOptions = {
  fields?: Record<string, string>;
  resourceId?: string;
  pluginId?: string;
  parentResourceId?: string;
};

/**
 * One `cost-estimate` round trip shared by the price and carbon readers: a
 * detail page and an edit modal ask for both halves of the same response at
 * the same moment, and that should be one request, not two.
 */
const inflightEstimates = new Map<string, Promise<CostEstimateResponse>>();
function costEstimateResponse(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  options: CostEstimateOptions,
): Promise<CostEstimateResponse> {
  const { fields, resourceId, pluginId, parentResourceId } = options;
  const payload = {
    accountId,
    resourceTypeId,
    ...(fields ? { fields } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(pluginId ? { pluginId } : {}),
    ...(parentResourceId ? { parentResourceId } : {}),
  };
  const key = JSON.stringify({ orgId, ...payload });
  let p = inflightEstimates.get(key);
  if (!p) {
    p = runRpc(resources().costEstimate({ params: { orgId }, payload }));
    inflightEstimates.set(key, p);
    void p.finally(() => setTimeout(() => inflightEstimates.delete(key), 1000)).catch(() => {});
  }
  return p;
}

/** The `carbon` half of the same `cost-estimate` response. */
export async function getCloudCarbonEstimate(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  options: CostEstimateOptions = {},
): Promise<ResourceCarbonEstimate | null> {
  const res = await costEstimateResponse(orgId, accountId, resourceTypeId, options);
  return res?.carbon ?? null;
}

export async function getCloudCostEstimate(
  orgId: string,
  accountId: string,
  resourceTypeId: string,
  options: CostEstimateOptions = {},
): Promise<CostEstimate | null> {
  const res = await costEstimateResponse(orgId, accountId, resourceTypeId, options);
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
  await runRpc(
    resources().delete({
      params: { orgId, pluginId, typeId: resourceTypeId },
      query: { resourceId, accountId, ...(parentResourceId ? { parentResourceId } : {}) },
    }),
  );
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
  return runRpc(
    resources().exportCredential({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: {
        resourceId,
        accountId,
        formatId,
        ...(parentResourceId ? { parentResourceId } : {}),
      },
    }),
  );
}

export async function getCloudManifest(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ manifest: string }> {
  return runRpc(
    resources().getManifest({
      params: { orgId, pluginId, typeId: resourceTypeId },
      query: { resourceId, accountId, ...(parentResourceId ? { parentResourceId } : {}) },
    }),
  );
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
  await runRpc(
    resources().applyManifest({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: definedFields(body),
    }),
  );
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
  await runRpc(resources().invokeAction({ params: { orgId }, payload: definedFields(body) }));
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
  const res = await runRpc(
    resources().nosqlCommand({ params: { orgId }, payload: definedFields(body) }),
  );
  return res.result;
}

export async function importCloudYaml(
  orgId: string,
  pluginId: string,
  body: { accountId: string; yaml: string; parentResourceId?: string },
): Promise<{ applied: number }> {
  return runRpc(
    resources().importYaml({ params: { orgId, pluginId }, payload: definedFields(body) }),
  );
}

export async function getCloudDescribe(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  parentResourceId?: string,
): Promise<{ text: string }> {
  return runRpc(
    resources().describe({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: { accountId, resourceId, ...(parentResourceId ? { parentResourceId } : {}) },
    }),
  );
}

export async function getCloudLogs(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  params: { tailLines?: number; container?: string; previous?: boolean; parentResourceId?: string },
): Promise<{ text: string; containers: string[]; activeContainer: string }> {
  const { tailLines, container, previous, parentResourceId } = params;
  return runRpc(
    resources().logs({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: {
        accountId,
        resourceId,
        ...(parentResourceId ? { parentResourceId } : {}),
        ...(tailLines !== undefined ? { tailLines } : {}),
        ...(container !== undefined ? { container } : {}),
        ...(previous !== undefined ? { previous } : {}),
      },
    }),
  );
}

/**
 * `POST /resources/:pluginId/:typeId/metrics`. The route answers with a
 * `{ series }` envelope, not a bare array: callers validate the payload, so
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
  return runRpc(
    cloudClient("resources").resources.metrics({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: body,
    }),
  );
}

export async function fetchCloudPeerPanes(
  orgId: string,
  pluginId: string,
  resourceTypeId: string,
  body: { accountId: string; resourceId: string; parentResourceId?: string },
): Promise<unknown> {
  return runRpc(
    cloudClient("resources").resources.peerPanes({
      params: { orgId, pluginId, typeId: resourceTypeId },
      payload: body,
    }),
  );
}

export async function loadCloudPickerResources(
  orgId: string,
  sources: AssociationSource[],
  accountId: string,
  opts?: { regionHint?: string; crossAccount?: boolean },
): Promise<ResourcePickerOption[]> {
  return runRpc(
    resources().pickerResources({
      params: { orgId },
      payload: {
        sources: sources.map(({ pluginId, resourceTypeId, outputKey }) => ({
          pluginId,
          resourceTypeId,
          outputKey,
        })),
        accountId,
        ...(opts?.regionHint ? { regionHint: opts.regionHint } : {}),
        ...(opts?.crossAccount ? { crossAccount: true } : {}),
      },
    }),
  );
}
