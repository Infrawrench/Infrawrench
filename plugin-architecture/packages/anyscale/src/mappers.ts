import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ANYSCALE_HOST } from "./api.js";
import type {
  AsBudget,
  AsCloud,
  AsCluster,
  AsComputeConfig,
  AsJob,
  AsNodeType,
  AsOrganization,
  AsProject,
  AsService,
  AsUserInfo,
  AsWorkspace,
  MiniUser,
} from "./types.js";

export const PLUGIN_ID = "anyscale";

/** Console deep links, as the CLI prints them. */
export const consoleUrl = {
  clouds: () => `${ANYSCALE_HOST}/clouds`,
  project: (id: string) => `${ANYSCALE_HOST}/projects/${encodeURIComponent(id)}`,
  workspace: (id: string) => `${ANYSCALE_HOST}/workspaces/${encodeURIComponent(id)}`,
  job: (id: string) => `${ANYSCALE_HOST}/jobs/${encodeURIComponent(id)}`,
  service: (id: string) => `${ANYSCALE_HOST}/services/${encodeURIComponent(id)}`,
  computeConfig: (id: string) =>
    `${ANYSCALE_HOST}/configurations/cluster-computes/${encodeURIComponent(id)}`,
  /** Usage and billing live under Organization settings, which has no stable deep link. */
  home: () => ANYSCALE_HOST,
};

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

const who = (u: MiniUser | null | undefined): string | undefined =>
  u ? (u.email ?? u.name ?? u.username) : undefined;

export function mapOrganization(
  accountId: string,
  info: AsUserInfo,
  org: AsOrganization,
  extra: { monthToDate?: number; creditBalance?: number } = {},
): ResourceInstance {
  const id = org.id ?? "current";
  return instance(
    accountId,
    "organization",
    id,
    org.name ?? "Anyscale organization",
    {
      name: org.name,
      organizationId: org.id,
      permissionLevel: info.organization_permission_level,
      defaultCloudId: org.default_cloud_id,
      ssoMode: org.sso_mode,
      monthToDate: extra.monthToDate,
      creditBalance: extra.creditBalance,
    },
    { organizationId: org.id },
  );
}

export function hostingLabel(c: { is_aioa?: boolean }): string {
  return c.is_aioa ? "Anyscale-hosted" : "Customer cloud";
}

export function mapCloud(
  accountId: string,
  c: AsCloud,
  runningClusters?: number,
): ResourceInstance {
  const id = c.id ?? "";
  return instance(
    accountId,
    "cloud",
    id,
    c.name ?? id,
    {
      name: c.name,
      cloudId: id,
      hosting: hostingLabel(c),
      provider: c.provider,
      computeStack: c.compute_stack ?? (c.is_k8s ? "K8S" : undefined),
      region: c.region,
      state: c.state,
      isDefault: c.is_default ?? false,
      runningClusters,
      creator: who(c.creator),
      createdAt: c.created_at,
    },
    { cloudId: id, url: consoleUrl.clouds() },
  );
}

export function mapProject(
  accountId: string,
  p: AsProject,
  cloudNames: Map<string, string>,
): ResourceInstance {
  const id = p.id ?? "";
  const cloudId = p.parent_cloud_id ?? p.cloud_id ?? undefined;
  return instance(
    accountId,
    "project",
    id,
    p.name ?? id,
    {
      name: p.name,
      description: p.description,
      cloudId,
      cloudName: cloudId ? cloudNames.get(cloudId) : undefined,
      isDefault: p.is_default ?? false,
      owners: (p.owners ?? [])
        .map(who)
        .filter((x): x is string => !!x)
        .join(", "),
      projectId: id,
      createdAt: p.created_at,
    },
    { projectId: id, url: consoleUrl.project(id) },
  );
}

const RUNNING_WORKSPACE = new Set(["Running", "Updating"]);

/** Human description of `idle_termination_status`. */
export function activityLabel(status: string | null | undefined): string | undefined {
  switch (status) {
    case "ACTIVE_RAY":
      return "Active (Ray workload)";
    case "ACTIVE_COMMAND":
      return "Active (command running)";
    case "ACTIVE_WORKSPACE":
      return "Active (editor in use)";
    case "IDLE":
      return "Idle";
    case "DISABLED":
      return "Auto-termination disabled";
    case "ERROR":
      return "Unknown (activity check failed)";
    default:
      return undefined;
  }
}

export function mapWorkspace(
  accountId: string,
  w: AsWorkspace,
  cluster: AsCluster | undefined,
  projectNames: Map<string, string>,
): ResourceInstance {
  const id = w.id ?? "";
  const state = w.state ?? cluster?.state ?? "";
  const running = RUNNING_WORKSPACE.has(state);
  const idle = running && cluster?.idle_termination_status === "IDLE";
  return instance(
    accountId,
    "workspace",
    id,
    w.name ?? id,
    {
      name: w.name,
      state,
      projectId: w.project_id,
      projectName: w.project_id ? projectNames.get(w.project_id) : undefined,
      cloudId: w.cloud_id,
      computeConfigId: w.compute_config_id ?? cluster?.compute_template?.id,
      activity: running ? activityLabel(cluster?.idle_termination_status) : undefined,
      idle: running ? (idle ? "yes" : "no") : undefined,
      idleTerminationMinutes:
        typeof cluster?.idle_timeout === "number" && cluster.idle_timeout > 0
          ? cluster.idle_timeout
          : undefined,
      idleSince: idle ? (cluster?.idle_timeout_last_activity_at ?? undefined) : undefined,
      rayVersion: cluster?.ray_version,
      creator: w.creator_email ?? who(cluster?.creator),
      lastStartedAt: w.latest_started_at ?? cluster?.latest_started_at,
      createdAt: w.created_at,
      workspaceId: id,
      clusterId: w.cluster_id,
    },
    { workspaceId: id, url: consoleUrl.workspace(id) },
  );
}

export function mapJob(accountId: string, j: AsJob): ResourceInstance {
  const id = j.id ?? "";
  return instance(
    accountId,
    "job",
    id,
    j.name ?? id,
    {
      name: j.name,
      state: j.state?.current_state,
      goalState: j.state?.goal_state,
      lastRunStatus: j.last_job_run?.status,
      projectId: j.project_id ?? j.project?.id,
      projectName: j.project?.name,
      cloudId: j.cloud_id,
      computeConfigId: j.config?.compute_config_id,
      entrypoint: j.config?.entrypoint,
      image: j.config?.image_uri,
      maxRetries: typeof j.config?.max_retries === "number" ? j.config.max_retries : undefined,
      timeoutSeconds: typeof j.config?.timeout_s === "number" ? j.config.timeout_s : undefined,
      schedule: j.schedule?.name,
      jobQueue: j.job_queue?.name,
      error: j.state?.error,
      creator: who(j.creator),
      createdAt: j.created_at,
      updatedAt: j.status_updated_at ?? j.updated_at,
      jobId: id,
    },
    { jobId: id, url: j.overview_url || consoleUrl.job(id) },
  );
}

const ROLLOUT_STATES = new Set(["ROLLING_OUT", "ROLLING_BACK"]);

/** "Rolling out v2: 25% → 100%" style summary of a service's versions. */
export function rolloutSummary(s: AsService): string {
  const canary = s.canary_version;
  const state = s.current_state ?? "";
  if (canary && ROLLOUT_STATES.has(state)) {
    const now = canary.current_weight ?? canary.weight;
    const target = canary.target_weight ?? 100;
    const verb = state === "ROLLING_BACK" ? "Rolling back" : "Rolling out";
    return `${verb} ${canary.version ?? "canary"}: ${now ?? 0}% of traffic, target ${target}%`;
  }
  if (state === "TERMINATED") return "Terminated";
  return s.primary_version?.version ? `Serving ${s.primary_version.version}` : "";
}

export function mapService(accountId: string, s: AsService): ResourceInstance {
  const id = s.id ?? "";
  const primary = s.primary_version;
  const canary = s.canary_version;
  return instance(
    accountId,
    "service",
    id,
    s.name ?? id,
    {
      name: s.name,
      state: s.current_state,
      goalState: s.goal_state,
      rollout: rolloutSummary(s),
      primaryVersion: primary?.version,
      primaryWeight: primary ? (primary.current_weight ?? primary.weight) : undefined,
      canaryVersion: canary?.version,
      canaryWeight: canary ? (canary.current_weight ?? canary.weight) : undefined,
      autoRollout: s.auto_rollout_enabled,
      baseUrl: s.base_url,
      projectId: s.project_id,
      cloudId: s.cloud_id,
      computeConfigId: primary?.compute_config_id,
      error: s.error_message,
      creator: who(s.creator),
      createdAt: s.created_at,
      serviceId: id,
    },
    { serviceId: id, baseUrl: s.base_url, url: consoleUrl.service(id) },
  );
}

function describeNode(n: AsNodeType): string {
  const type = n.instance_type || n.name || "auto";
  const bounds =
    n.min_workers !== undefined || n.max_workers !== undefined
      ? ` ×${n.min_workers ?? 0}-${n.max_workers ?? "∞"}`
      : "";
  return `${type}${bounds}${n.use_spot ? " (spot)" : ""}`;
}

export function mapComputeConfig(accountId: string, c: AsComputeConfig): ResourceInstance {
  const id = c.id ?? "";
  const cfg = c.config ?? {};
  const workers = cfg.worker_node_types ?? [];
  const maxWorkers = workers.reduce<number | undefined>(
    (sum, w) => (typeof w.max_workers === "number" ? (sum ?? 0) + w.max_workers : sum),
    undefined,
  );
  return instance(
    accountId,
    "compute-config",
    id,
    c.name ?? id,
    {
      name: c.name,
      version: c.version,
      cloudId: cfg.cloud_id ?? cfg.cloud?.id,
      region: cfg.region,
      headNodeType: cfg.head_node_type?.instance_type || cfg.head_node_type?.name,
      workerNodeTypes: cfg.auto_select_worker_config
        ? "Selected automatically"
        : workers.map(describeNode).join(", "),
      maxWorkers,
      usesSpot: workers.some((w) => w.use_spot === true),
      idleTerminationMinutes:
        typeof cfg.idle_termination_minutes === "number" && cfg.idle_termination_minutes > 0
          ? cfg.idle_termination_minutes
          : undefined,
      maximumUptimeMinutes:
        typeof cfg.maximum_uptime_minutes === "number" && cfg.maximum_uptime_minutes > 0
          ? cfg.maximum_uptime_minutes
          : undefined,
      creator: who(c.creator),
      createdAt: c.created_at,
      computeConfigId: id,
    },
    { computeConfigId: id, url: consoleUrl.computeConfig(id) },
  );
}

export function budgetScope(b: AsBudget): string {
  const cloud = b.cloud?.name ?? b.cloud_id;
  const project = b.project?.name ?? b.project_id;
  if (cloud && project) return `Project ${project} in ${cloud}`;
  if (cloud) return `Cloud ${cloud}`;
  return "Whole organization";
}

export function mapBudget(accountId: string, b: AsBudget): ResourceInstance {
  const id = b.id ?? "";
  const amount = Number(b.budget_amount ?? 0);
  const usage = typeof b.curr_instance_usage === "number" ? b.curr_instance_usage : undefined;
  return instance(accountId, "budget", id, b.name ?? id, {
    name: b.name,
    budgetAmount: b.budget_amount,
    budgetUnit: b.budget_unit ?? "ANYSCALE_CREDITS",
    evaluationPeriod: b.evaluation_period,
    scope: budgetScope(b),
    cloudId: b.cloud_id,
    projectId: b.project_id,
    currentUsage: usage,
    percentUsed:
      usage !== undefined && amount > 0 ? Math.round((usage / amount) * 1000) / 10 : undefined,
    enabled: b.is_enabled ?? true,
    lastNotifiedAt: b.last_notified_at,
    creator: who(b.creator),
    createdAt: b.created_at,
  });
}
