import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "buildkite";

// ---------------------------------------------------------------------------
// API shapes (only the fields this plugin reads; see the REST reference)
// ---------------------------------------------------------------------------

export interface BkUser {
  id?: string;
  name?: string;
  email?: string;
}

export interface BkOrganization {
  id: string;
  graphql_id?: string;
  name: string;
  slug: string;
  web_url?: string;
  created_at?: string;
}

export interface BkPipeline {
  id: string;
  graphql_id?: string;
  web_url?: string;
  name: string;
  description?: string | null;
  slug: string;
  repository?: string;
  cluster_id?: string | null;
  branch_configuration?: string | null;
  default_branch?: string | null;
  skip_queued_branch_builds?: boolean;
  skip_queued_branch_builds_filter?: string | null;
  cancel_running_branch_builds?: boolean;
  cancel_running_branch_builds_filter?: string | null;
  allow_rebuilds?: boolean;
  provider?: { id?: string; webhook_url?: string; settings?: Record<string, unknown> };
  badge_url?: string;
  created_at?: string;
  archived_at?: string | null;
  scheduled_builds_count?: number;
  running_builds_count?: number;
  scheduled_jobs_count?: number;
  running_jobs_count?: number;
  waiting_jobs_count?: number;
  visibility?: string;
  configuration?: string | null;
  steps?: unknown[];
  tags?: string[] | null;
  emoji?: string | null;
  color?: string | null;
  default_command_step_timeout?: number | null;
  maximum_command_step_timeout?: number | null;
  pipeline_template_uuid?: string | null;
}

export interface BkJob {
  id: string;
  graphql_id?: string;
  type: string;
  name?: string | null;
  label?: string | null;
  step_key?: string | null;
  state?: string;
  web_url?: string | null;
  command?: string | null;
  soft_failed?: boolean;
  exit_status?: number | null;
  agent?: { id?: string; name?: string; hostname?: string } | null;
  agent_query_rules?: string[];
  created_at?: string | null;
  scheduled_at?: string | null;
  runnable_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  retried?: boolean;
  retries_count?: number | null;
  unblockable?: boolean;
  priority?: { number?: number } | null;
  cluster_queue_id?: string | null;
  triggered_build?: { number?: number; web_url?: string } | null;
}

export interface BkBuild {
  id: string;
  graphql_id?: string;
  web_url?: string;
  number: number;
  state: string;
  blocked?: boolean;
  cancel_reason?: string | null;
  message?: string | null;
  commit?: string;
  branch?: string;
  source?: string;
  creator?: BkUser | null;
  jobs?: BkJob[];
  created_at?: string | null;
  scheduled_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  pull_request?: { id?: string; base?: string; repository?: string } | null;
  rebuilt_from?: { number?: number } | null;
  pipeline?: { slug?: string; name?: string; id?: string };
}

export interface BkAgent {
  id: string;
  graphql_id?: string;
  web_url?: string;
  name: string;
  connection_state?: string;
  hostname?: string;
  ip_address?: string;
  user_agent?: string;
  version?: string;
  os_id?: string;
  arch?: string;
  queue?: string;
  created_at?: string;
  connected_at?: string | null;
  job?: { id?: string; web_url?: string; name?: string } | null;
  last_job_finished_at?: string | null;
  priority?: number | null;
  meta_data?: string[];
}

export interface BkCluster {
  id: string;
  graphql_id?: string;
  default_queue_id?: string | null;
  name: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
  web_url?: string;
  created_at?: string;
  hosted_git_mirror_enabled?: boolean;
  hosted_container_cache_enabled?: boolean;
}

export interface BkQueue {
  id: string;
  graphql_id?: string;
  key: string;
  description?: string | null;
  web_url?: string;
  dispatch_paused?: boolean;
  dispatch_paused_at?: string | null;
  dispatch_paused_note?: string | null;
  dispatch_paused_by?: BkUser | null;
  retry_agent_affinity?: string | null;
  hosted?: boolean;
  hosted_agents?: {
    instance_shape?: {
      name?: string;
      machine_type?: string;
      architecture?: string;
      cpu?: number;
      memory?: number;
    };
  } | null;
  created_at?: string;
}

export interface BkAgentToken {
  id: string;
  graphql_id?: string;
  description?: string | null;
  allowed_ip_addresses?: string | null;
  expires_at?: string | null;
  created_at?: string;
  created_by?: BkUser | null;
  token?: string;
}

export interface BkSecret {
  id: string;
  key: string;
  description?: string | null;
  policy?: string | null;
  created_at?: string;
  updated_at?: string | null;
  last_read_at?: string | null;
}

export interface BkSchedule {
  id: string;
  graphql_id?: string;
  label?: string | null;
  cronline: string;
  message?: string | null;
  commit?: string | null;
  branch?: string | null;
  env?: Record<string, string> | null;
  enabled?: boolean;
  next_build_at?: string | null;
  failed_message?: string | null;
  failed_at?: string | null;
  created_at?: string;
  pipeline?: { id?: string; slug?: string };
}

export interface BkTemplate {
  uuid: string;
  graphql_id?: string;
  name: string;
  description?: string | null;
  configuration?: string;
  available?: boolean;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface BkSuite {
  id: string;
  graphql_id?: string;
  slug: string;
  name: string;
  web_url?: string;
  default_branch?: string | null;
  application_name?: string | null;
  color?: string | null;
  emoji?: string | null;
  api_token?: string;
}

export interface BkTest {
  id: string;
  web_url?: string;
  scope?: string | null;
  name: string;
  location?: string | null;
  file_name?: string | null;
  state?: string;
  labels?: string[];
  reliability?: number | null;
  duration_avg?: number | null;
  duration_max?: number | null;
  executions_count?: number | null;
  executions_count_by_result?: Record<string, number>;
}

export interface BkAnnotation {
  id?: string;
  context?: string;
  style?: string | null;
  body_html?: string;
}

export interface BkArtifact {
  id: string;
  job_id?: string;
  path: string;
  filename?: string;
  file_size?: number;
  state?: string;
  mime_type?: string;
}

export interface BkTeam {
  id: string;
  graphql_id?: string;
  name: string;
  slug?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Fields = Record<string, string | number | boolean>;

/** Drop null/undefined so `fields` stays a clean string/number/boolean map. */
export function clean(input: Record<string, unknown>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, unknown>,
  outputs: Record<string, string | undefined | null> = {},
  parent?: { typeId: string; externalId: string },
  createdAt?: string | null,
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
    createdAt: createdAt ? toIso(createdAt) : now,
    updatedAt: now,
  };
}

/** Buildkite mixes ISO and `2013-09-03 13:24:38 UTC`; normalise to ISO. */
export function toIso(value: string | null | undefined): string {
  if (!value) return "";
  const t = Date.parse(value.replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isFinite(t)) return new Date(t).toISOString();
  const t2 = Date.parse(value);
  return Number.isFinite(t2) ? new Date(t2).toISOString() : value;
}

/** Seconds between two timestamps, or undefined when either is missing. */
export function secondsBetween(a?: string | null, b?: string | null): number | undefined {
  if (!a || !b) return undefined;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return Math.max(0, Math.round((y - x) / 1000));
}

/** `KEY=value` lines from an env object, for display and editing. */
export function envToLines(env: Record<string, string> | null | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Parse `KEY=value` lines (or comma-separated pairs) into an env object. */
export function linesToEnv(raw: string | undefined, label = "Environment"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw ?? "").split(/\n|,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Buildkite plugin: "${label}" lines must look like KEY=value, got "${t}"`);
    }
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

export function jobLabel(j: BkJob): string {
  return (j.name || j.label || j.step_key || j.type || j.id).trim();
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export interface OrgStats {
  activeUsers?: number | undefined;
  pipelineCount?: number | undefined;
  agentCount?: number | undefined;
  busyAgents?: number | undefined;
  clusterCount?: number | undefined;
  runningBuilds?: number | undefined;
  scheduledBuilds?: number | undefined;
  waitingJobs?: number | undefined;
  rateLimit?: number | undefined;
  rateLimitUsed?: number | undefined;
}

export function mapOrganization(
  accountId: string,
  org: BkOrganization,
  stats: OrgStats = {},
): ResourceInstance {
  const url = org.web_url ?? `https://buildkite.com/${org.slug}`;
  return instance(
    accountId,
    "organization",
    org.slug,
    org.name,
    {
      name: org.name,
      slug: org.slug,
      activeUsers: stats.activeUsers,
      pipelineCount: stats.pipelineCount,
      agentCount: stats.agentCount,
      busyAgents: stats.busyAgents,
      clusterCount: stats.clusterCount,
      runningBuilds: stats.runningBuilds,
      scheduledBuilds: stats.scheduledBuilds,
      waitingJobs: stats.waitingJobs,
      rateLimit: stats.rateLimit,
      rateLimitUsed: stats.rateLimitUsed,
      organizationId: org.id,
      graphqlId: org.graphql_id,
      createdAt: toIso(org.created_at),
    },
    { slug: org.slug, url, organizationId: org.id, graphqlId: org.graphql_id },
    undefined,
    org.created_at,
  );
}

export function mapPipeline(
  accountId: string,
  p: BkPipeline,
  clusterName?: string,
  clusterGraphqlId?: string,
): ResourceInstance {
  return instance(
    accountId,
    "pipeline",
    p.slug,
    p.name,
    {
      name: p.name,
      slug: p.slug,
      description: p.description ?? "",
      repository: p.repository ?? "",
      defaultBranch: p.default_branch ?? "",
      branchConfiguration: p.branch_configuration ?? "",
      skipQueuedBranchBuilds: p.skip_queued_branch_builds ?? false,
      skipQueuedBranchBuildsFilter: p.skip_queued_branch_builds_filter ?? "",
      cancelRunningBranchBuilds: p.cancel_running_branch_builds ?? false,
      cancelRunningBranchBuildsFilter: p.cancel_running_branch_builds_filter ?? "",
      allowRebuilds: p.allow_rebuilds ?? true,
      visibility: p.visibility ?? "private",
      defaultTimeoutMinutes: p.default_command_step_timeout ?? undefined,
      maximumTimeoutMinutes: p.maximum_command_step_timeout ?? undefined,
      tags: (p.tags ?? []).join(", "),
      emoji: p.emoji ?? undefined,
      color: p.color ?? undefined,
      clusterId: p.cluster_id ?? "",
      clusterName: clusterName ?? "",
      clusterGraphqlId: clusterGraphqlId ?? "",
      pipelineTemplateUuid: p.pipeline_template_uuid ?? "",
      provider: p.provider?.id ?? "",
      archived: Boolean(p.archived_at),
      runningBuilds: p.running_builds_count,
      scheduledBuilds: p.scheduled_builds_count,
      runningJobs: p.running_jobs_count,
      scheduledJobs: p.scheduled_jobs_count,
      waitingJobs: p.waiting_jobs_count,
      yamlSteps: typeof p.configuration === "string",
      configuration: p.configuration ?? undefined,
      pipelineId: p.id,
      graphqlId: p.graphql_id,
      createdAt: toIso(p.created_at),
    },
    {
      slug: p.slug,
      url: p.web_url,
      badgeUrl: p.badge_url,
      webhookUrl: p.provider?.webhook_url || undefined,
      pipelineId: p.id,
      graphqlId: p.graphql_id,
    },
    undefined,
    p.created_at,
  );
}

export function buildDisplayName(pipelineSlug: string, b: BkBuild): string {
  const msg = (b.message ?? "").split("\n")[0]?.trim() ?? "";
  const short = msg.length > 60 ? `${msg.slice(0, 57)}...` : msg;
  return `${b.pipeline?.name ?? pipelineSlug} #${b.number}${short ? ` ${short}` : ""}`;
}

export function mapBuild(accountId: string, pipelineSlug: string, b: BkBuild): ResourceInstance {
  const jobs = (b.jobs ?? []).filter((j) => j.type === "script");
  const finishedJobs = jobs.filter((j) => j.started_at && j.runnable_at);
  const waits = finishedJobs
    .map((j) => secondsBetween(j.runnable_at, j.started_at))
    .filter((x): x is number => x !== undefined);
  return instance(
    accountId,
    "build",
    `${pipelineSlug}/${b.number}`,
    buildDisplayName(pipelineSlug, b),
    {
      number: b.number,
      pipelineSlug,
      pipelineName: b.pipeline?.name ?? pipelineSlug,
      state: b.state,
      branch: b.branch ?? "",
      commit: b.commit ?? "",
      message: (b.message ?? "").split("\n")[0] ?? "",
      source: b.source ?? "",
      creator: b.creator?.name ?? b.creator?.email ?? "",
      blocked: b.blocked ?? false,
      cancelReason: b.cancel_reason ?? undefined,
      pullRequest: b.pull_request?.id ?? undefined,
      rebuiltFrom: b.rebuilt_from?.number ?? undefined,
      jobCount: b.jobs ? b.jobs.length : undefined,
      failedJobs: b.jobs
        ? b.jobs.filter((j) => ["failed", "timed_out", "broken"].includes(j.state ?? "")).length
        : undefined,
      durationSecs: secondsBetween(b.started_at, b.finished_at),
      waitSecs: waits.length > 0 ? Math.max(...waits) : undefined,
      createdAt: toIso(b.created_at),
      startedAt: toIso(b.started_at),
      finishedAt: toIso(b.finished_at),
      buildId: b.id,
    },
    { url: b.web_url, buildId: b.id, number: String(b.number) },
    { typeId: "pipeline", externalId: pipelineSlug },
    b.created_at,
  );
}

export function mapJob(
  accountId: string,
  pipelineSlug: string,
  buildNumber: number,
  j: BkJob,
): ResourceInstance {
  return instance(
    accountId,
    "job",
    `${pipelineSlug}/${buildNumber}/${j.id}`,
    `${jobLabel(j)} (#${buildNumber})`,
    {
      name: jobLabel(j),
      type: j.type,
      state: j.state ?? "",
      pipelineSlug,
      buildNumber,
      stepKey: j.step_key ?? undefined,
      command: j.command ?? undefined,
      exitStatus: j.exit_status ?? undefined,
      softFailed: j.soft_failed ?? false,
      agentName: j.agent?.name ?? undefined,
      agentId: j.agent?.id ?? undefined,
      agentQueryRules: (j.agent_query_rules ?? []).join(", "),
      queueId: j.cluster_queue_id ?? undefined,
      retried: j.retried ?? false,
      retriesCount: j.retries_count ?? undefined,
      unblockable: j.unblockable ?? undefined,
      priority: j.priority?.number ?? undefined,
      waitSecs: secondsBetween(j.runnable_at, j.started_at),
      durationSecs: secondsBetween(j.started_at, j.finished_at),
      startedAt: toIso(j.started_at),
      finishedAt: toIso(j.finished_at),
      jobId: j.id,
    },
    { url: j.web_url ?? undefined, jobId: j.id },
    { typeId: "build", externalId: `${pipelineSlug}/${buildNumber}` },
    j.created_at,
  );
}

/** Cluster and queue ids out of an agent's web URL (`.../clusters/<id>/queues/<id>/agents/<id>`). */
export function agentPlacement(a: BkAgent): {
  clusterId?: string | undefined;
  queueId?: string | undefined;
} {
  const m = /\/clusters\/([^/]+)\/queues\/([^/]+)\//.exec(a.web_url ?? "");
  return m ? { clusterId: m[1], queueId: m[2] } : {};
}

export function mapAgent(accountId: string, a: BkAgent): ResourceInstance {
  const place = agentPlacement(a);
  return instance(
    accountId,
    "agent",
    a.id,
    a.name,
    {
      name: a.name,
      connectionState: a.connection_state ?? "",
      busy: Boolean(a.job),
      currentJob: a.job?.name ?? a.job?.id ?? undefined,
      hostname: a.hostname ?? "",
      ipAddress: a.ip_address ?? "",
      version: a.version ?? "",
      os: a.os_id ?? "",
      arch: a.arch ?? "",
      queue: a.queue ?? "",
      clusterId: place.clusterId,
      queueRef:
        place.clusterId && place.queueId ? `${place.clusterId}/${place.queueId}` : undefined,
      priority: a.priority ?? undefined,
      tags: (a.meta_data ?? []).join(", "),
      connectedAt: toIso(a.connected_at),
      lastJobFinishedAt: toIso(a.last_job_finished_at),
      agentId: a.id,
    },
    { url: a.web_url, hostname: a.hostname, ipAddress: a.ip_address },
    undefined,
    a.created_at,
  );
}

export function mapCluster(
  accountId: string,
  c: BkCluster,
  extra: { queueCount?: number; agentCount?: number; defaultQueueKey?: string } = {},
): ResourceInstance {
  return instance(
    accountId,
    "cluster",
    c.id,
    c.name,
    {
      name: c.name,
      description: c.description ?? "",
      emoji: c.emoji ?? "",
      color: c.color ?? "",
      defaultQueueId: c.default_queue_id ?? "",
      defaultQueue: extra.defaultQueueKey,
      queueCount: extra.queueCount,
      agentCount: extra.agentCount,
      hostedGitMirror: c.hosted_git_mirror_enabled,
      hostedContainerCache: c.hosted_container_cache_enabled,
      clusterId: c.id,
      graphqlId: c.graphql_id,
      createdAt: toIso(c.created_at),
    },
    { clusterId: c.id, url: c.web_url, graphqlId: c.graphql_id },
    undefined,
    c.created_at,
  );
}

export function mapQueue(
  accountId: string,
  clusterId: string,
  q: BkQueue,
  extra: { agentCount?: number; clusterName?: string; clusterGraphqlId?: string } = {},
): ResourceInstance {
  const shape = q.hosted_agents?.instance_shape;
  return instance(
    accountId,
    "queue",
    `${clusterId}/${q.id}`,
    extra.clusterName ? `${q.key} (${extra.clusterName})` : q.key,
    {
      key: q.key,
      description: q.description ?? "",
      hosted: Boolean(q.hosted ?? shape),
      instanceShape: shape?.name ?? "",
      vcpus: shape?.cpu,
      memoryGb: shape?.memory,
      dispatchPaused: q.dispatch_paused ?? false,
      pausedNote: q.dispatch_paused_note ?? undefined,
      pausedAt: toIso(q.dispatch_paused_at),
      retryAgentAffinity: q.retry_agent_affinity ?? "prefer-warmest",
      agentCount: extra.agentCount,
      clusterId,
      clusterName: extra.clusterName,
      clusterGraphqlId: extra.clusterGraphqlId,
      queueId: q.id,
      graphqlId: q.graphql_id,
    },
    { key: q.key, queueId: q.id, url: q.web_url },
    { typeId: "cluster", externalId: clusterId },
    q.created_at,
  );
}

export function mapAgentToken(
  accountId: string,
  clusterId: string,
  t: BkAgentToken,
  clusterName?: string,
): ResourceInstance {
  return instance(
    accountId,
    "agent-token",
    `${clusterId}/${t.id}`,
    t.description || t.id,
    {
      description: t.description ?? "",
      allowedIpAddresses: t.allowed_ip_addresses ?? "",
      expiresAt: toIso(t.expires_at),
      createdBy: t.created_by?.name ?? t.created_by?.email ?? "",
      createdAt: toIso(t.created_at),
      clusterId,
      clusterName,
      tokenId: t.id,
    },
    { tokenId: t.id },
    { typeId: "cluster", externalId: clusterId },
    t.created_at,
  );
}

export function mapSecret(
  accountId: string,
  clusterId: string,
  s: BkSecret,
  clusterName?: string,
): ResourceInstance {
  return instance(
    accountId,
    "cluster-secret",
    `${clusterId}/${s.id}`,
    s.key,
    {
      key: s.key,
      description: s.description ?? "",
      policy: s.policy ?? "",
      lastReadAt: toIso(s.last_read_at),
      updatedAt: toIso(s.updated_at),
      createdAt: toIso(s.created_at),
      clusterId,
      clusterName,
      secretId: s.id,
    },
    { key: s.key },
    { typeId: "cluster", externalId: clusterId },
    s.created_at,
  );
}

export function mapSchedule(
  accountId: string,
  pipelineSlug: string,
  s: BkSchedule,
  pipelineGraphqlId?: string,
): ResourceInstance {
  return instance(
    accountId,
    "schedule",
    `${pipelineSlug}/${s.id}`,
    s.label || s.cronline,
    {
      label: s.label ?? "",
      cronline: s.cronline,
      branch: s.branch ?? "",
      commit: s.commit ?? "HEAD",
      message: s.message ?? "",
      env: envToLines(s.env),
      enabled: s.enabled ?? true,
      nextBuildAt: toIso(s.next_build_at),
      failedMessage: s.failed_message ?? undefined,
      failedAt: toIso(s.failed_at),
      pipelineSlug,
      pipelineGraphqlId,
      scheduleId: s.id,
      graphqlId: s.graphql_id,
    },
    { scheduleId: s.id },
    { typeId: "pipeline", externalId: pipelineSlug },
    s.created_at,
  );
}

export function mapTemplate(accountId: string, t: BkTemplate): ResourceInstance {
  return instance(
    accountId,
    "pipeline-template",
    t.uuid,
    t.name,
    {
      name: t.name,
      description: t.description ?? "",
      available: t.available ?? false,
      stepCount: countSteps(t.configuration),
      configuration: t.configuration ?? undefined,
      updatedAt: toIso(t.updated_at),
      templateUuid: t.uuid,
      graphqlId: t.graphql_id,
    },
    { templateUuid: t.uuid, url: t.web_url, graphqlId: t.graphql_id },
    undefined,
    t.created_at,
  );
}

/** Rough count of top-level steps in a YAML step list, for display only. */
export function countSteps(yaml: string | undefined | null): number | undefined {
  if (!yaml) return undefined;
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^steps:\s*$/.test(l));
  if (start < 0) return undefined;
  let indent: number | undefined;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^(\s*)-\s/.exec(line);
    if (!m) continue;
    const width = m[1]!.length;
    indent ??= width;
    if (width === indent) count++;
  }
  return count;
}

export function mapSuite(
  accountId: string,
  s: BkSuite,
  stats: { flakyCount?: number } = {},
): ResourceInstance {
  return instance(
    accountId,
    "test-suite",
    s.slug,
    s.name,
    {
      name: s.name,
      slug: s.slug,
      defaultBranch: s.default_branch ?? "",
      applicationName: s.application_name ?? "",
      emoji: s.emoji ?? "",
      color: s.color ?? "",
      flakyTests: stats.flakyCount,
      suiteId: s.id,
      graphqlId: s.graphql_id,
    },
    { slug: s.slug, suiteId: s.id, url: s.web_url },
  );
}

export function mapTest(accountId: string, suiteSlug: string, t: BkTest): ResourceInstance {
  const byResult = t.executions_count_by_result ?? {};
  const name = [t.scope, t.name].filter(Boolean).join(" ");
  return instance(
    accountId,
    "test",
    `${suiteSlug}/${t.id}`,
    name.length > 90 ? `${name.slice(0, 87)}...` : name,
    {
      name: t.name,
      scope: t.scope ?? "",
      location: t.location ?? "",
      state: t.state ?? "enabled",
      labels: (t.labels ?? []).join(", "),
      reliability:
        typeof t.reliability === "number" ? Math.round(t.reliability * 1000) / 10 : undefined,
      executions: t.executions_count ?? undefined,
      failed: byResult["failed"],
      passed: byResult["passed"],
      durationAvgSecs: t.duration_avg ?? undefined,
      durationMaxSecs: t.duration_max ?? undefined,
      suiteSlug,
      testId: t.id,
    },
    { url: t.web_url, testId: t.id },
    { typeId: "test-suite", externalId: suiteSlug },
  );
}

/** `a/b` into its two halves; everything after the first slash is the second. */
export function splitFirst(id: string): [string, string] {
  const i = id.indexOf("/");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}
