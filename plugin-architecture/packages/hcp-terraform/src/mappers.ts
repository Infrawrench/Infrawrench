import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { Doc } from "./api.js";
import { relId, relIds } from "./api.js";

export const PLUGIN_ID = "hcp-terraform";

type A = Record<string, unknown>;
type Fields = Record<string, string | number | boolean>;

export function clean(input: Record<string, unknown>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

export function s(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

export function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function b(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, unknown>,
  outputs: Record<string, string | undefined> = {},
  parent?: { typeId: string; externalId: string },
  createdAt?: string,
): ResourceInstance {
  const now = new Date().toISOString();
  const resolvedOutputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolvedOutputs[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean(fields),
    resolvedOutputs,
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: createdAt || now,
    updatedAt: now,
  };
}

/** `a/b` split at the first slash. */
export function splitFirst(id: string): [string, string] {
  const i = id.indexOf("/");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface OrgExtras {
  workspaceCount?: number | undefined;
  projectCount?: number | undefined;
  rumCount?: number | undefined;
  driftedWorkspaces?: number | undefined;
  checksFailing?: number | undefined;
  userCount?: number | undefined;
  userLimit?: number | undefined;
  nextInvoiceTotal?: number | undefined;
  runningRuns?: number | undefined;
}

export function mapOrganization(
  accountId: string,
  org: Doc<A>,
  url: string,
  extra: OrgExtras = {},
): ResourceInstance {
  const a = org.attributes;
  return instance(
    accountId,
    "organization",
    org.id,
    org.id,
    {
      name: org.id,
      email: s(a["email"]),
      plan: a["plan-is-enterprise"] ? "Enterprise" : a["plan-is-trial"] ? "Trial" : "",
      planExpiresAt: s(a["plan-expires-at"]),
      planExpired: b(a["plan-expired"]),
      costEstimationEnabled: b(a["cost-estimation-enabled"]),
      assessmentsEnforced: b(a["assessments-enforced"]),
      allowForceDeleteWorkspaces: b(a["allow-force-delete-workspaces"]),
      defaultExecutionMode: s(a["default-execution-mode"]),
      sessionTimeoutMinutes: n(a["session-timeout"]),
      workspaceCount: extra.workspaceCount,
      projectCount: extra.projectCount,
      rumCount: extra.rumCount,
      driftedWorkspaces: extra.driftedWorkspaces,
      checksFailing: extra.checksFailing,
      userCount: extra.userCount,
      userLimit: extra.userLimit,
      nextInvoiceTotal: extra.nextInvoiceTotal,
      runningRuns: extra.runningRuns,
      externalId: s(a["external-id"]),
      createdAt: s(a["created-at"]),
    },
    { name: org.id, url, organizationId: s(a["external-id"]) },
    undefined,
    s(a["created-at"]),
  );
}

// ---------------------------------------------------------------------------
// Projects and workspaces
// ---------------------------------------------------------------------------

export function mapProject(
  accountId: string,
  org: string,
  p: Doc<A>,
  url: string,
  workspaceCount?: number,
): ResourceInstance {
  const a = p.attributes;
  return instance(
    accountId,
    "project",
    p.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      description: s(a["description"]),
      defaultExecutionMode: s(a["default-execution-mode"]),
      autoDestroyActivityDuration: s(a["auto-destroy-activity-duration"]),
      defaultAgentPoolId: relId(p, "default-agent-pool"),
      workspaceCount,
      organization: org,
      projectId: p.id,
    },
    { projectId: p.id, url },
  );
}

/** Per-workspace health from the explorer's workspaces view. */
export interface WorkspaceHealth {
  drifted?: boolean;
  resourcesDrifted?: number;
  resourcesUndrifted?: number;
  checksFailed?: number;
  checksErrored?: number;
  checksPassed?: number;
  allChecksSucceeded?: boolean;
  rumCount?: number | null;
  providers?: string | null;
  modules?: string | null;
  stateTerraformVersion?: string;
}

export function healthFromExplorer(a: A): WorkspaceHealth {
  return {
    ...(b(a["drifted"]) !== undefined ? { drifted: b(a["drifted"])! } : {}),
    ...(n(a["resources-drifted"]) !== undefined
      ? { resourcesDrifted: n(a["resources-drifted"])! }
      : {}),
    ...(n(a["resources-undrifted"]) !== undefined
      ? { resourcesUndrifted: n(a["resources-undrifted"])! }
      : {}),
    ...(n(a["checks-failed"]) !== undefined ? { checksFailed: n(a["checks-failed"])! } : {}),
    ...(n(a["checks-errored"]) !== undefined ? { checksErrored: n(a["checks-errored"])! } : {}),
    ...(n(a["checks-passed"]) !== undefined ? { checksPassed: n(a["checks-passed"])! } : {}),
    ...(b(a["all-checks-succeeded"]) !== undefined
      ? { allChecksSucceeded: b(a["all-checks-succeeded"])! }
      : {}),
    rumCount: n(a["current-rum-count"]) ?? null,
    providers: typeof a["providers"] === "string" ? a["providers"] : null,
    modules: typeof a["modules"] === "string" ? a["modules"] : null,
    ...(typeof a["state-version-terraform-version"] === "string"
      ? { stateTerraformVersion: a["state-version-terraform-version"] }
      : {}),
  };
}

export function mapWorkspace(
  accountId: string,
  org: string,
  w: Doc<A>,
  url: string,
  extra: {
    projectName?: string | undefined;
    runStatus?: string | undefined;
    health?: WorkspaceHealth | undefined;
    tags?: string | undefined;
  } = {},
): ResourceInstance {
  const a = w.attributes;
  const vcs = (a["vcs-repo"] ?? null) as A | null;
  const projectId = relId(w, "project");
  const h = extra.health;
  return instance(
    accountId,
    "workspace",
    w.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      description: s(a["description"]),
      projectName: extra.projectName,
      projectId,
      executionMode: s(a["execution-mode"]),
      agentPoolId: relId(w, "agent-pool"),
      terraformVersion: s(a["terraform-version"]),
      workingDirectory: s(a["working-directory"]),
      autoApply: b(a["auto-apply"]),
      autoApplyRunTrigger: b(a["auto-apply-run-trigger"]),
      assessmentsEnabled: b(a["assessments-enabled"]),
      allowDestroyPlan: b(a["allow-destroy-plan"]),
      speculativeEnabled: b(a["speculative-enabled"]),
      fileTriggersEnabled: b(a["file-triggers-enabled"]),
      queueAllRuns: b(a["queue-all-runs"]),
      globalRemoteState: b(a["global-remote-state"]),
      autoDestroyAt: s(a["auto-destroy-at"]),
      autoDestroyActivityDuration: s(a["auto-destroy-activity-duration"]),
      vcsRepo: vcs ? s(vcs["display-identifier"] ?? vcs["identifier"]) : "",
      vcsBranch: vcs ? s(vcs["branch"]) : "",
      locked: b(a["locked"]),
      resourceCount: n(a["resource-count"]),
      runFailures: n(a["run-failures"]),
      applyDurationAverageMs: n(a["apply-duration-average"]),
      planDurationAverageMs: n(a["plan-duration-average"]),
      currentRunStatus: extra.runStatus,
      currentRunId: relId(w, "current-run"),
      latestChangeAt: s(a["latest-change-at"]),
      tags:
        extra.tags ??
        (Array.isArray(a["tag-names"]) ? (a["tag-names"] as string[]).join(", ") : ""),
      drifted: h?.drifted,
      resourcesDrifted: h?.resourcesDrifted,
      checksFailed: h ? (h.checksFailed ?? 0) + (h.checksErrored ?? 0) : undefined,
      checksPassed: h?.checksPassed,
      rumCount: h?.rumCount ?? undefined,
      providers: h?.providers ?? undefined,
      stateTerraformVersion: h?.stateTerraformVersion,
      organization: org,
      workspaceId: w.id,
      createdAt: s(a["created-at"]),
    },
    { workspaceId: w.id, name: s(a["name"]), url },
    projectId ? { typeId: "project", externalId: projectId } : undefined,
    s(a["created-at"]),
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const RUN_FINAL = new Set([
  "applied",
  "planned_and_finished",
  "planned_and_saved",
  "discarded",
  "errored",
  "canceled",
  "force_canceled",
  "policy_soft_failed",
]);

export function runDuration(a: A): number | undefined {
  const ts = (a["status-timestamps"] ?? {}) as Record<string, string>;
  const start = Date.parse(s(a["created-at"]));
  const times = Object.values(ts)
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  if (!Number.isFinite(start) || times.length === 0) return undefined;
  return Math.max(0, Math.round((Math.max(...times) - start) / 1000));
}

export function mapRun(
  accountId: string,
  r: Doc<A>,
  workspace: { id: string; name: string } | undefined,
  plan: Doc<A> | undefined,
  url: string,
): ResourceInstance {
  const a = r.attributes;
  const actions = (a["actions"] ?? {}) as Record<string, boolean>;
  const msg = s(a["message"]).split("\n")[0] ?? "";
  const wsId = workspace?.id ?? relId(r, "workspace");
  const p = plan?.attributes;
  return instance(
    accountId,
    "run",
    r.id,
    `${workspace?.name ?? "run"}: ${msg.length > 60 ? `${msg.slice(0, 57)}...` : msg || r.id}`,
    {
      status: s(a["status"]),
      message: s(a["message"]),
      workspaceName: workspace?.name,
      workspaceId: wsId,
      source: s(a["source"]),
      triggerReason: s(a["trigger-reason"]),
      isDestroy: b(a["is-destroy"]),
      planOnly: b(a["plan-only"]),
      refreshOnly: b(a["refresh-only"]),
      autoApply: b(a["auto-apply"]),
      hasChanges: b(a["has-changes"]),
      terraformVersion: s(a["terraform-version"]),
      targetAddrs: Array.isArray(a["target-addrs"])
        ? (a["target-addrs"] as string[]).join(", ")
        : undefined,
      resourceAdditions: p ? n(p["resource-additions"]) : undefined,
      resourceChanges: p ? n(p["resource-changes"]) : undefined,
      resourceDestructions: p ? n(p["resource-destructions"]) : undefined,
      resourceImports: p ? n(p["resource-imports"]) : undefined,
      canApply: actions["is-confirmable"] ?? false,
      canDiscard: actions["is-discardable"] ?? false,
      canCancel: actions["is-cancelable"] ?? false,
      canForceCancel: actions["is-force-cancelable"] ?? false,
      planId: relId(r, "plan"),
      applyId: relId(r, "apply"),
      durationSecs: RUN_FINAL.has(s(a["status"])) ? runDuration(a) : undefined,
      createdAt: s(a["created-at"]),
      runId: r.id,
    },
    { runId: r.id, url },
    wsId ? { typeId: "workspace", externalId: wsId } : undefined,
    s(a["created-at"]),
  );
}

// ---------------------------------------------------------------------------
// Variables, variable sets, outputs
// ---------------------------------------------------------------------------

export function mapVariable(
  accountId: string,
  workspaceId: string,
  workspaceName: string,
  v: Doc<A>,
): ResourceInstance {
  const a = v.attributes;
  const sensitive = a["sensitive"] === true;
  return instance(
    accountId,
    "variable",
    `${workspaceId}/${v.id}`,
    s(a["key"]),
    {
      key: s(a["key"]),
      value: sensitive ? undefined : s(a["value"]),
      category: s(a["category"]),
      hcl: b(a["hcl"]),
      sensitive,
      description: s(a["description"]),
      workspaceName,
      workspaceId,
      variableId: v.id,
    },
    { key: s(a["key"]), ...(sensitive ? {} : { value: s(a["value"]) }) },
    { typeId: "workspace", externalId: workspaceId },
  );
}

export function mapVarset(accountId: string, org: string, v: Doc<A>): ResourceInstance {
  const a = v.attributes;
  return instance(
    accountId,
    "variable-set",
    v.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      description: s(a["description"]),
      global: b(a["global"]),
      priority: b(a["priority"]),
      varCount: n(a["var-count"]),
      workspaceCount: n(a["workspace-count"]),
      projectCount: n(a["project-count"]),
      workspaceIds: relIds(v, "workspaces").join(", "),
      projectIds: relIds(v, "projects").join(", "),
      updatedAt: s(a["updated-at"]),
      organization: org,
      varsetId: v.id,
    },
    { varsetId: v.id },
  );
}

export function mapVarsetVariable(
  accountId: string,
  varsetId: string,
  varsetName: string,
  v: Doc<A>,
): ResourceInstance {
  const a = v.attributes;
  const sensitive = a["sensitive"] === true;
  return instance(
    accountId,
    "varset-variable",
    `${varsetId}/${v.id}`,
    s(a["key"]),
    {
      key: s(a["key"]),
      value: sensitive ? undefined : s(a["value"]),
      category: s(a["category"]),
      hcl: b(a["hcl"]),
      sensitive,
      description: s(a["description"]),
      varsetName,
      varsetId,
      variableId: v.id,
    },
    { key: s(a["key"]), ...(sensitive ? {} : { value: s(a["value"]) }) },
    { typeId: "variable-set", externalId: varsetId },
  );
}

/** Output values are any JSON; strings stay strings, the rest is JSON. */
export function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function mapOutput(
  accountId: string,
  workspaceId: string,
  workspaceName: string,
  o: Doc<A>,
): ResourceInstance {
  const a = o.attributes;
  const sensitive = a["sensitive"] === true;
  const name = s(a["name"]);
  return instance(
    accountId,
    "state-output",
    `${workspaceId}/${name}`,
    `${workspaceName}.${name}`,
    {
      name,
      type:
        typeof a["type"] === "string"
          ? a["type"]
          : JSON.stringify(a["detailed-type"] ?? a["type"] ?? ""),
      sensitive,
      preview: sensitive ? undefined : outputText(a["value"]).slice(0, 500),
      workspaceName,
      workspaceId,
      outputId: o.id,
    },
    { name, ...(sensitive ? {} : { value: outputText(a["value"]) }) },
    { typeId: "workspace", externalId: workspaceId },
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function mapAgentPool(accountId: string, org: string, p: Doc<A>): ResourceInstance {
  const a = p.attributes;
  return instance(
    accountId,
    "agent-pool",
    p.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      organizationScoped: b(a["organization-scoped"]),
      agentCount: n(a["agent-count"]),
      workspaceCount: relIds(p, "workspaces").length,
      allowedWorkspaces: relIds(p, "allowed-workspaces").length,
      allowedProjects: relIds(p, "allowed-projects").length,
      organization: org,
      agentPoolId: p.id,
      createdAt: s(a["created-at"]),
    },
    { agentPoolId: p.id },
    undefined,
    s(a["created-at"]),
  );
}

export function mapAgent(
  accountId: string,
  poolId: string,
  poolName: string,
  ag: Doc<A>,
): ResourceInstance {
  const a = ag.attributes;
  return instance(
    accountId,
    "agent",
    `${poolId}/${ag.id}`,
    s(a["name"]) || ag.id,
    {
      name: s(a["name"]),
      status: s(a["status"]),
      ipAddress: s(a["ip-address"]),
      lastPingAt: s(a["last-ping-at"]),
      poolName,
      agentPoolId: poolId,
      agentId: ag.id,
    },
    { agentId: ag.id },
    { typeId: "agent-pool", externalId: poolId },
  );
}

export function mapAgentToken(
  accountId: string,
  poolId: string,
  poolName: string,
  t: Doc<A>,
): ResourceInstance {
  const a = t.attributes;
  return instance(
    accountId,
    "agent-token",
    `${poolId}/${t.id}`,
    s(a["description"]) || t.id,
    {
      description: s(a["description"]),
      lastUsedAt: s(a["last-used-at"]),
      createdAt: s(a["created-at"]),
      poolName,
      agentPoolId: poolId,
      tokenId: t.id,
    },
    { tokenId: t.id },
    { typeId: "agent-pool", externalId: poolId },
    s(a["created-at"]),
  );
}

// ---------------------------------------------------------------------------
// Governance and access
// ---------------------------------------------------------------------------

export function mapPolicySet(accountId: string, org: string, p: Doc<A>): ResourceInstance {
  const a = p.attributes;
  const vcs = (a["vcs-repo"] ?? null) as A | null;
  return instance(
    accountId,
    "policy-set",
    p.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      description: s(a["description"]),
      kind: s(a["kind"]),
      global: b(a["global"]),
      overridable: b(a["overridable"]),
      agentEnabled: b(a["agent-enabled"]),
      policyToolVersion: s(a["policy-tool-version"]),
      policiesPath: s(a["policies-path"]),
      policyCount: n(a["policy-count"]),
      workspaceCount: n(a["workspace-count"]),
      projectCount: n(a["project-count"]),
      vcsRepo: vcs ? s(vcs["identifier"]) : "",
      versioned: b(a["versioned"]),
      updatedAt: s(a["updated-at"]),
      organization: org,
      policySetId: p.id,
    },
    { policySetId: p.id },
    undefined,
    s(a["created-at"]),
  );
}

export const TEAM_ACCESS_FLAGS = [
  "manage-workspaces",
  "manage-projects",
  "manage-policies",
  "manage-policy-overrides",
  "manage-run-tasks",
  "manage-vcs-settings",
  "manage-agent-pools",
  "manage-modules",
  "manage-providers",
  "manage-teams",
  "manage-membership",
  "manage-organization-access",
  "read-workspaces",
  "read-projects",
] as const;

export function camel(k: string): string {
  return k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function mapTeam(accountId: string, org: string, t: Doc<A>): ResourceInstance {
  const a = t.attributes;
  const access = (a["organization-access"] ?? {}) as Record<string, boolean>;
  const flags: Record<string, unknown> = {};
  for (const k of TEAM_ACCESS_FLAGS) flags[camel(k)] = access[k] ?? false;
  return instance(
    accountId,
    "team",
    t.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      visibility: s(a["visibility"]),
      usersCount: n(a["users-count"]),
      ssoTeamId: s(a["sso-team-id"]),
      allowMemberTokenManagement: b(a["allow-member-token-management"]),
      ...flags,
      organization: org,
      teamId: t.id,
    },
    { teamId: t.id, name: s(a["name"]) },
  );
}

export function mapRunTask(accountId: string, org: string, t: Doc<A>): ResourceInstance {
  const a = t.attributes;
  return instance(
    accountId,
    "run-task",
    t.id,
    s(a["name"]),
    {
      name: s(a["name"]),
      url: s(a["url"]),
      description: s(a["description"]),
      enabled: b(a["enabled"]),
      category: s(a["category"]),
      hmacKey: undefined,
      workspaceCount: relIds(t, "workspace-tasks").length || undefined,
      organization: org,
      taskId: t.id,
    },
    { taskId: t.id },
  );
}

export function mapRegistryModule(accountId: string, org: string, m: Doc<A>): ResourceInstance {
  const a = m.attributes;
  const versions = Array.isArray(a["version-statuses"]) ? (a["version-statuses"] as Array<A>) : [];
  const ok = versions.filter((v) => v["status"] === "ok").map((v) => s(v["version"]));
  const registry = s(a["registry-name"]) || "private";
  const vcs = (a["vcs-repo"] ?? null) as A | null;
  const name = s(a["name"]);
  const ns = s(a["namespace"]);
  const provider = s(a["provider"]);
  return instance(
    accountId,
    "registry-module",
    `${registry}/${ns}/${name}/${provider}`,
    `${ns}/${name}/${provider}`,
    {
      name,
      namespace: ns,
      provider,
      registryName: registry,
      status: s(a["status"]),
      latestVersion: ok[0] ?? "",
      versionCount: versions.length,
      noCode: b(a["no-code"]),
      testsEnabled: b(a["test-config"] && (a["test-config"] as A)["tests-enabled"]),
      vcsRepo: vcs ? s(vcs["display-identifier"] ?? vcs["identifier"]) : "",
      source: `${registry === "private" ? `${ns}/` : ""}${name}`,
      updatedAt: s(a["updated-at"]),
      organization: org,
      moduleId: m.id,
    },
    { moduleId: m.id },
    undefined,
    s(a["created-at"]),
  );
}

export function mapRegistryProvider(accountId: string, org: string, p: Doc<A>): ResourceInstance {
  const a = p.attributes;
  const registry = s(a["registry-name"]) || "private";
  const ns = s(a["namespace"]);
  const name = s(a["name"]);
  return instance(
    accountId,
    "registry-provider",
    `${registry}/${ns}/${name}`,
    `${ns}/${name}`,
    {
      name,
      namespace: ns,
      registryName: registry,
      updatedAt: s(a["updated-at"]),
      organization: org,
      providerId: p.id,
    },
    { providerId: p.id },
    undefined,
    s(a["created-at"]),
  );
}
