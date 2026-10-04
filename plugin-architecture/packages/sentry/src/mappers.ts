/**
 * Raw Sentry API shapes (only the fields the plugin reads) and their mapping
 * to `ResourceInstance`s. Field names follow the public API reference
 * (https://docs.sentry.io/api/, 2026-10).
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { SentryInstance } from "./regions.js";

export const PLUGIN_ID = "sentry";

export interface SentryOrganization {
  id?: string;
  slug: string;
  name?: string;
  dateCreated?: string;
  status?: { id?: string; name?: string };
  links?: { organizationUrl?: string; regionUrl?: string };
}

export interface SentryTeamRef {
  id?: string;
  slug?: string;
  name?: string;
}

export interface SentryProject {
  id: string;
  slug: string;
  name?: string;
  platform?: string | null;
  status?: string;
  dateCreated?: string;
  firstEvent?: string | null;
  teams?: SentryTeamRef[];
  team?: SentryTeamRef | null;
  isMember?: boolean;
  hasAccess?: boolean;
}

export interface SentryTeam {
  id: string;
  slug: string;
  name?: string;
  dateCreated?: string;
  memberCount?: number;
  projects?: Array<{ slug?: string; name?: string }>;
}

export interface SentryRelease {
  version: string;
  shortVersion?: string;
  ref?: string | null;
  url?: string | null;
  dateCreated?: string;
  dateReleased?: string | null;
  newGroups?: number;
  commitCount?: number;
  deployCount?: number;
  lastDeploy?: { environment?: string; dateFinished?: string } | null;
  projects?: Array<{ slug?: string; name?: string }>;
}

export interface SentryIssue {
  id: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  substatus?: string | null;
  priority?: string | null;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
  issueType?: string;
  issueCategory?: string;
  assignedTo?: { name?: string; email?: string; type?: string } | null;
  project?: { id?: string; slug?: string; name?: string };
}

export interface SentryClientKey {
  id: string;
  name?: string;
  label?: string;
  public?: string;
  isActive?: boolean;
  dateCreated?: string;
  projectId?: number | string;
  dsn?: { public?: string };
  rateLimit?: { count?: number; window?: number } | null;
}

export interface SentryCondition {
  id?: string;
  type?: string;
  comparison?: unknown;
  conditionResult?: unknown;
}

export interface SentryAction {
  id?: string;
  type?: string;
  config?: { targetType?: string; targetDisplay?: string | null; targetIdentifier?: string | null };
}

export interface SentryWorkflow {
  id: string;
  name?: string;
  enabled?: boolean;
  environment?: string | null;
  config?: { frequency?: number };
  triggers?: { logicType?: string; conditions?: SentryCondition[] } | null;
  actionFilters?: Array<{
    logicType?: string;
    conditions?: SentryCondition[];
    actions?: SentryAction[];
  }>;
  detectorIds?: string[];
  lastTriggered?: string | null;
  owner?: string | null;
  dateCreated?: string;
}

export interface SentryDetector {
  id: string;
  projectId?: string;
  name?: string;
  description?: string | null;
  type?: string;
  enabled?: boolean;
  workflowIds?: string[];
  owner?: { type?: string; name?: string; email?: string } | null;
  dateCreated?: string;
  config?: Record<string, unknown> | null;
  dataSources?: Array<{
    type?: string;
    queryObj?: {
      snubaQuery?: {
        dataset?: string;
        query?: string;
        aggregate?: string;
        timeWindow?: number;
        environment?: string | null;
      };
    };
  }> | null;
  conditionGroup?: { logicType?: string; conditions?: SentryCondition[] } | null;
  latestGroup?: { id?: string; shortId?: string; title?: string } | null;
}

export interface SentryCronMonitor {
  id: string;
  slug: string;
  name?: string;
  status?: string;
  isMuted?: boolean;
  config?: {
    schedule_type?: string;
    schedule?: string | [number, string];
    checkin_margin?: number | null;
    max_runtime?: number | null;
    timezone?: string | null;
  };
  environments?: Array<{
    name?: string;
    status?: string;
    isMuted?: boolean;
    lastCheckIn?: string | null;
    nextCheckIn?: string | null;
  }>;
  project?: { id?: string; slug?: string };
  dateCreated?: string;
}

export interface SentryUptimeMonitor {
  id: string;
  name?: string;
  url?: string;
  method?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  status?: string;
  uptimeStatus?: number | string;
  environment?: string | null;
  projectSlug?: string;
  owner?: { name?: string; type?: string } | null;
}

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parentExternalId?: string,
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
    ...(parentExternalId ? { parentResourceId: `${accountId}:project:${parentExternalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Deep links into the web UI. sentry.io serves each organization on its own
 * subdomain (`https://<org>.sentry.io/...`); a self-hosted install uses
 * `/organizations/<org>/...` paths under its base URL.
 */
export function orgUrl(inst: SentryInstance, org: string, path = ""): string {
  const suffix = path.replace(/^\/+/, "");
  if (inst.selfHosted) return `${inst.appUrl}/organizations/${org}/${suffix}`;
  return `https://${org}.sentry.io/${suffix}`;
}

/** Child resources are addressed `<projectSlug>/<id>` so a single read needs no lookup. */
export function scopedId(projectSlug: string, id: string): string {
  return `${projectSlug}/${id}`;
}

export function parseScopedId(externalId: string): { projectSlug: string; id: string } {
  const at = externalId.indexOf("/");
  if (at <= 0 || at === externalId.length - 1) {
    throw new Error(`Sentry plugin: malformed id "${externalId}"`);
  }
  return { projectSlug: externalId.slice(0, at), id: externalId.slice(at + 1) };
}

const names = (items: Array<{ slug?: string; name?: string }> | undefined): string =>
  (items ?? [])
    .map((t) => t.slug ?? t.name ?? "")
    .filter(Boolean)
    .join(", ");

export function mapOrganization(
  accountId: string,
  inst: SentryInstance,
  org: SentryOrganization,
  monthToDate?: number,
): ResourceInstance {
  return instance(
    accountId,
    "organization",
    org.slug,
    org.name ?? org.slug,
    {
      name: org.name ?? org.slug,
      slug: org.slug,
      region: inst.label,
      status: org.status?.name ?? org.status?.id,
      dateCreated: org.dateCreated,
      monthToDate,
    },
    { slug: org.slug, url: orgUrl(inst, org.slug) },
  );
}

export interface ProjectStats {
  accepted24h?: number;
  dropped24h?: number;
  unresolved?: number;
}

export function mapProject(
  accountId: string,
  inst: SentryInstance,
  org: string,
  p: SentryProject,
  stats: ProjectStats = {},
): ResourceInstance {
  const teams = p.teams?.length ? p.teams : p.team ? [p.team] : [];
  return instance(
    accountId,
    "project",
    p.slug,
    p.name ?? p.slug,
    {
      name: p.name ?? p.slug,
      platform: p.platform ?? undefined,
      slug: p.slug,
      teams: names(teams),
      status: p.status,
      events24h: stats.accepted24h,
      dropped24h: stats.dropped24h,
      unresolvedIssues: stats.unresolved,
      firstEvent: p.firstEvent ?? undefined,
      dateCreated: p.dateCreated,
      projectId: p.id,
      organization: org,
    },
    {
      slug: p.slug,
      projectId: p.id,
      url: orgUrl(inst, org, `projects/${p.slug}/`),
    },
  );
}

export function mapTeam(accountId: string, org: string, t: SentryTeam): ResourceInstance {
  return instance(
    accountId,
    "team",
    t.slug,
    t.name ?? t.slug,
    {
      name: t.name ?? t.slug,
      slug: t.slug,
      memberCount: t.memberCount,
      projects: names(t.projects),
      dateCreated: t.dateCreated,
      teamId: t.id,
      organization: org,
    },
    { slug: t.slug },
  );
}

export function mapRelease(accountId: string, r: SentryRelease): ResourceInstance {
  return instance(
    accountId,
    "release",
    r.version,
    r.shortVersion || r.version,
    {
      version: r.version,
      shortVersion: r.shortVersion,
      projects: names(r.projects),
      dateCreated: r.dateCreated,
      dateReleased: r.dateReleased ?? undefined,
      newGroups: r.newGroups,
      commitCount: r.commitCount,
      deployCount: r.deployCount,
      lastDeployEnvironment: r.lastDeploy?.environment,
      lastDeployAt: r.lastDeploy?.dateFinished,
      ref: r.ref ?? undefined,
      url: r.url ?? undefined,
    },
    { version: r.version },
  );
}

export function mapIssue(accountId: string, i: SentryIssue): ResourceInstance {
  const projectSlug = i.project?.slug ?? "";
  const count = typeof i.count === "string" ? Number(i.count) : i.count;
  return instance(
    accountId,
    "issue",
    i.id,
    i.title ?? i.shortId ?? i.id,
    {
      title: i.title,
      shortId: i.shortId,
      culprit: i.culprit,
      level: i.level,
      status: i.status,
      substatus: i.substatus ?? undefined,
      priority: i.priority ?? undefined,
      count: Number.isFinite(count) ? count : undefined,
      userCount: i.userCount,
      firstSeen: i.firstSeen,
      lastSeen: i.lastSeen,
      assignedTo: i.assignedTo?.name ?? i.assignedTo?.email,
      issueType: i.issueCategory ?? i.issueType,
      projectSlug,
      projectId: i.project?.id,
    },
    { shortId: i.shortId, url: i.permalink },
    projectSlug || undefined,
  );
}

export function mapClientKey(
  accountId: string,
  org: string,
  projectSlug: string,
  k: SentryClientKey,
): ResourceInstance {
  const name = k.label || k.name || k.id;
  return instance(
    accountId,
    "client-key",
    scopedId(projectSlug, k.id),
    name,
    {
      name,
      rateLimitCount: k.rateLimit?.count,
      rateLimitWindow: k.rateLimit?.window,
      isActive: k.isActive,
      dsn: k.dsn?.public,
      publicKey: k.public,
      dateCreated: k.dateCreated,
      keyId: k.id,
      organization: org,
      projectSlug,
      projectId: k.projectId !== undefined ? String(k.projectId) : undefined,
    },
    { dsn: k.dsn?.public, publicKey: k.public },
    projectSlug,
  );
}

const humanType = (t: string | undefined): string => (t ?? "").replace(/_/g, " ");

function conditionText(c: SentryCondition): string {
  const type = humanType(c.type);
  const cmp = c.comparison;
  if (cmp === undefined || cmp === null || cmp === true) return type;
  if (typeof cmp === "object") {
    const o = cmp as { value?: unknown; interval?: unknown };
    if (o.value !== undefined) {
      return `${type} ${String(o.value)}${o.interval ? ` in ${String(o.interval)}` : ""}`;
    }
    return type;
  }
  return `${type} ${String(cmp)}`;
}

function actionText(a: SentryAction): string {
  const target = a.config?.targetDisplay || a.config?.targetType || "";
  return [humanType(a.type), humanType(target)].filter(Boolean).join(" to ");
}

export function mapWorkflow(accountId: string, w: SentryWorkflow): ResourceInstance {
  const filters = (w.actionFilters ?? []).flatMap((f) => f.conditions ?? []);
  const actions = (w.actionFilters ?? []).flatMap((f) => f.actions ?? []);
  return instance(
    accountId,
    "alert",
    w.id,
    w.name ?? w.id,
    {
      name: w.name,
      frequency: w.config?.frequency,
      enabled: w.enabled,
      environment: w.environment ?? undefined,
      triggers: (w.triggers?.conditions ?? []).map(conditionText).filter(Boolean).join("; "),
      filters: filters.map(conditionText).filter(Boolean).join("; "),
      actions: actions.map(actionText).filter(Boolean).join("; "),
      monitorCount: w.detectorIds?.length ?? 0,
      lastTriggered: w.lastTriggered ?? undefined,
      owner: w.owner ?? undefined,
      dateCreated: w.dateCreated,
      alertId: w.id,
    },
    { alertId: w.id },
  );
}

/** Detector types listed as their own resource types, not as generic monitors. */
export const DEDICATED_DETECTOR_TYPES = new Set([
  "uptime_domain_failure",
  "monitor_check_in_failure",
]);

const DETECTOR_TYPE_LABELS: Record<string, string> = {
  error: "Error",
  metric_issue: "Metric",
  issue_stream: "Issue stream",
  uptime_domain_failure: "Uptime",
  monitor_check_in_failure: "Cron",
};

export function mapDetector(
  accountId: string,
  d: SentryDetector,
  projectSlugById: Map<string, string>,
): ResourceInstance {
  const snuba = (d.dataSources ?? []).find((s) => s.queryObj?.snubaQuery)?.queryObj?.snubaQuery;
  const thresholds = (d.conditionGroup?.conditions ?? [])
    .filter((c) => c.conditionResult !== 0 && c.conditionResult !== false)
    .map(conditionText)
    .join("; ");
  const projectSlug = d.projectId ? projectSlugById.get(String(d.projectId)) : undefined;
  return instance(
    accountId,
    "monitor",
    d.id,
    d.name ?? d.id,
    {
      name: d.name,
      monitorType: DETECTOR_TYPE_LABELS[d.type ?? ""] ?? humanType(d.type),
      enabled: d.enabled,
      aggregate: snuba?.aggregate,
      query: snuba?.query,
      timeWindow: snuba?.timeWindow !== undefined ? Math.round(snuba.timeWindow / 60) : undefined,
      thresholds,
      environment: snuba?.environment ?? undefined,
      alertCount: d.workflowIds?.length ?? 0,
      latestIssue: d.latestGroup
        ? [d.latestGroup.shortId, d.latestGroup.title].filter(Boolean).join(" ")
        : undefined,
      owner: d.owner?.name ?? d.owner?.email,
      description: d.description ?? undefined,
      dateCreated: d.dateCreated,
      monitorId: d.id,
      projectSlug,
      projectId: d.projectId,
    },
    { monitorId: d.id },
  );
}

/** `"0 * * * *"` or `"10 minute"`, whatever the schedule type. */
export function scheduleText(config: SentryCronMonitor["config"]): string {
  const s = config?.schedule;
  if (Array.isArray(s)) return `${s[0]} ${s[1]}`;
  return s ?? "";
}

/**
 * Worst environment status wins. Environment statuses are `active` (no
 * check-in yet), `ok`, `error` and `disabled`; missed and timed-out runs are
 * check-in statuses that put the environment into `error`.
 */
export function cronHealth(m: SentryCronMonitor): string {
  const statuses = (m.environments ?? []).map((e) => e.status ?? "");
  for (const s of ["error", "ok", "active", "disabled"]) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0] || "";
}

function latest(values: Array<string | null | undefined>, pick: "max" | "min"): string | undefined {
  const ok = values.filter((v): v is string => !!v).sort();
  return pick === "max" ? ok[ok.length - 1] : ok[0];
}

export function mapCronMonitor(accountId: string, m: SentryCronMonitor): ResourceInstance {
  const envs = m.environments ?? [];
  return instance(
    accountId,
    "cron-monitor",
    m.slug,
    m.name ?? m.slug,
    {
      name: m.name ?? m.slug,
      schedule: scheduleText(m.config),
      timezone: m.config?.timezone ?? undefined,
      checkinMargin: m.config?.checkin_margin ?? undefined,
      maxRuntime: m.config?.max_runtime ?? undefined,
      status: m.status,
      health: cronHealth(m),
      isMuted: m.isMuted,
      environments: envs.map((e) => `${e.name ?? "?"}: ${e.status ?? "?"}`).join(", "),
      lastCheckIn: latest(
        envs.map((e) => e.lastCheckIn),
        "max",
      ),
      nextCheckIn: latest(
        envs.map((e) => e.nextCheckIn),
        "min",
      ),
      slug: m.slug,
      monitorId: m.id,
      projectSlug: m.project?.slug,
      projectId: m.project?.id,
    },
    { slug: m.slug },
  );
}

export function uptimeStatusText(v: number | string | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 1 || v === "1" || v === "ok") return "up";
  if (v === 2 || v === "2" || v === "failed") return "down";
  return String(v);
}

export function mapUptimeMonitor(accountId: string, m: SentryUptimeMonitor): ResourceInstance {
  const projectSlug = m.projectSlug ?? "";
  return instance(
    accountId,
    "uptime-monitor",
    projectSlug ? scopedId(projectSlug, m.id) : m.id,
    m.name ?? m.url ?? m.id,
    {
      name: m.name,
      checkUrl: m.url,
      intervalSeconds: m.intervalSeconds !== undefined ? String(m.intervalSeconds) : undefined,
      timeoutMs: m.timeoutMs,
      method: m.method,
      status: m.status,
      uptimeStatus: uptimeStatusText(m.uptimeStatus),
      environment: m.environment ?? undefined,
      owner: m.owner?.name,
      monitorId: m.id,
      projectSlug,
    },
    { checkUrl: m.url },
  );
}
