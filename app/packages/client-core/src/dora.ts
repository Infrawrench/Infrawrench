/**
 * DORA metrics: deployment frequency, lead time for changes, change failure
 * rate and time to restore, computed from data the product already holds.
 *
 * Everything in this module is pure: the server gathers deploy events,
 * declared incidents and (optionally) resource changes, and hands them here;
 * the CLI, the web/desktop panel and the mobile screen render what comes back.
 * Keeping the arithmetic in one place is what makes the digest line, the
 * panel's tiles and `infrawrench dora --json` agree to the last decimal.
 *
 * Three rules carry most of the weight, and each is documented where it lives:
 *
 * - **Production is a setting, not a guess.** An environment counts when its
 *   name matches one of the org's patterns (`isProductionEnvironment`).
 * - **A failure is blamed on one change.** An incident is attributed to the
 *   most recent matching production change inside the failure window, never to
 *   every change in it (`analyzeDora`), so one outage cannot inflate the rate.
 * - **Rollbacks are detected generically.** A deploy that re-ships a commit an
 *   earlier deploy on the same stream already shipped is a rollback of the one
 *   before it, whichever provider ran it (`detectRollbacks`).
 */

import type { CloudFetch } from "./fetch";

/* --------------------------------- settings -------------------------------- */

export interface DoraSettings {
  /** Hours after a change in which an incident or rollback counts against it. */
  failureWindowHours: number;
  /** Environment name patterns that count as production; `*` matches anything. */
  productionEnvironments: string[];
  /**
   * CI pipeline names that count as deploys. Pipeline runs (a Buildkite build,
   * a CircleCI pipeline) are only deploys when the pipeline is one, which no
   * provider says; the org does, by name.
   */
  pipelinePatterns: string[];
  /** Count a production deploy that itself failed as a failed change. */
  countFailedDeploys: boolean;
  /**
   * Count resource changes observed by sync (the change timeline) as changes
   * too, so a console edit that caused an incident shows in the failure rate.
   */
  includeResourceChanges: boolean;
  /** Include the Delivery section in the weekly digest. */
  digestEnabled: boolean;
}

export interface DoraSettingsView extends DoraSettings {
  updatedAt: string | null;
}

export const DORA_SETTINGS_DEFAULTS: DoraSettings = {
  failureWindowHours: 24,
  productionEnvironments: ["production", "prod", "prd", "live", "main"],
  pipelinePatterns: ["*deploy*", "*release*"],
  countFailedDeploys: false,
  includeResourceChanges: false,
  digestEnabled: true,
};

export const DORA_FAILURE_WINDOW_MIN_HOURS = 1;
export const DORA_FAILURE_WINDOW_MAX_HOURS = 720;
export const DORA_MAX_PATTERNS = 50;
export const DORA_MAX_PATTERN_LENGTH = 100;

/** Validate a settings patch; returns a sentence naming the first problem, or null. */
export function validateDoraSettings(input: Partial<DoraSettings>): string | null {
  if (input.failureWindowHours !== undefined) {
    const h = input.failureWindowHours;
    if (
      !Number.isInteger(h) ||
      h < DORA_FAILURE_WINDOW_MIN_HOURS ||
      h > DORA_FAILURE_WINDOW_MAX_HOURS
    ) {
      return `failureWindowHours must be a whole number from ${DORA_FAILURE_WINDOW_MIN_HOURS} to ${DORA_FAILURE_WINDOW_MAX_HOURS}`;
    }
  }
  for (const key of ["productionEnvironments", "pipelinePatterns"] as const) {
    const list = input[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) {
      return `${key} must be a list of strings`;
    }
    if (list.length > DORA_MAX_PATTERNS)
      return `${key} holds at most ${DORA_MAX_PATTERNS} patterns`;
    for (const p of list) {
      if (p.trim().length === 0) return `${key} cannot contain an empty pattern`;
      if (p.length > DORA_MAX_PATTERN_LENGTH) {
        return `${key} patterns are at most ${DORA_MAX_PATTERN_LENGTH} characters`;
      }
    }
  }
  if (input.productionEnvironments?.length === 0) {
    return "productionEnvironments needs at least one pattern";
  }
  return null;
}

/** Trim, drop blanks and duplicates (case-insensitively), keep order. */
export function normalizeDoraPatterns(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const p = raw.trim();
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

/**
 * Case-insensitive glob match where `*` is the only wildcard. Everything else
 * is literal, so an environment called `prod (eu)` needs no escaping.
 */
export function matchesDoraPattern(value: string, pattern: string): boolean {
  const v = value.toLowerCase();
  const parts = pattern.toLowerCase().split("*");
  if (parts.length === 1) return v === parts[0];
  let pos = 0;
  const first = parts[0]!;
  if (!v.startsWith(first)) return false;
  pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = v.indexOf(parts[i]!, pos);
    if (idx < 0) return false;
    pos = idx + parts[i]!.length;
  }
  const last = parts[parts.length - 1]!;
  return v.length - last.length >= pos && v.endsWith(last);
}

export function isProductionEnvironment(
  environment: string | null | undefined,
  patterns: string[],
): boolean {
  if (!environment) return false;
  return patterns.some((p) => matchesDoraPattern(environment, p));
}

/* ---------------------------------- inputs --------------------------------- */

/** Where a deploy event was learned from. */
export type DoraEventSource = "infrafile" | "plugin" | "github" | "api";
export const DORA_EVENT_SOURCES: readonly DoraEventSource[] = [
  "infrafile",
  "plugin",
  "github",
  "api",
];

export type DoraDeployStatus = "success" | "failure" | "in_progress" | "canceled";
export const DORA_DEPLOY_STATUSES: readonly DoraDeployStatus[] = [
  "success",
  "failure",
  "in_progress",
  "canceled",
];

/** A dimension value a change was scoped to, with its display label. */
export interface DoraScopeValue {
  key: string;
  label: string;
}

/**
 * One deploy, normalized across every source. `kind: "pipeline"` marks a CI
 * run that is only a deploy when its name matches `pipelinePatterns`.
 */
export interface DoraDeployEvent {
  id: string;
  source: DoraEventSource;
  kind: "deployment" | "pipeline";
  /** Project, site, service or pipeline name: what a person calls it. */
  name: string;
  environment: string | null;
  repository: string | null;
  commitSha: string | null;
  /** When the deployed commit was authored; null when nobody could say. */
  commitAt: string | null;
  /** When the deploy reached its environment (finish time where known). */
  deployedAt: string;
  status: DoraDeployStatus;
  /** The provider (or the deploy itself) said this was a rollback. */
  isRollback: boolean;
  accountId: string | null;
  pluginId: string | null;
  /** The deploy's own resource, when it is a synced resource. */
  resourceId: string | null;
  /** What was deployed to: the project/site/service resource. */
  targetResourceId: string | null;
  url: string | null;
  /** Dimension id to value; a missing or null entry means "not known". */
  scope: Record<string, DoraScopeValue | null>;
}

export interface DoraIncidentInput {
  id: string;
  title: string;
  severity: string;
  startedAt: string;
  resolvedAt: string | null;
  affectedResourceIds: string[];
  affectedAccountIds: string[];
}

export interface DoraResourceChangeInput {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  displayName: string;
  changeKind: "created" | "updated" | "deleted";
  at: string;
  /** Set when the change was reverted from the change timeline: a rollback. */
  revertedAt: string | null;
  scope: Record<string, DoraScopeValue | null>;
}

/* --------------------------------- analysis -------------------------------- */

export type DoraFailureKind = "incident" | "rollback" | "failed_deploy" | "reverted";

export interface DoraFailure {
  kind: DoraFailureKind;
  /** Incident id, rollback deploy id, or the change itself. */
  refId: string;
  title: string;
  at: string;
}

/** One production change with its verdict: the drill-down row. */
export interface DoraChange {
  id: string;
  type: "deploy" | "resource_change";
  name: string;
  environment: string | null;
  repository: string | null;
  commitSha: string | null;
  at: string;
  status: DoraDeployStatus;
  source: DoraEventSource | "change_timeline";
  pluginId: string | null;
  url: string | null;
  isRollback: boolean;
  leadTimeHours: number | null;
  failure: DoraFailure | null;
  scope: Record<string, DoraScopeValue | null>;
}

/** One recovery: an incident resolved, or a bad deploy rolled back. */
export interface DoraRestore {
  kind: "incident" | "rollback";
  id: string;
  title: string;
  startedAt: string;
  restoredAt: string;
  hours: number;
  /** The change this restore was attributed to, when there was one. */
  changeId: string | null;
}

export interface DoraAnalysisInput {
  events: DoraDeployEvent[];
  incidents: DoraIncidentInput[];
  resourceChanges: DoraResourceChangeInput[];
  settings: DoraSettings;
}

export interface DoraAnalysis {
  /** Production changes, oldest first. */
  changes: DoraChange[];
  restores: DoraRestore[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function ms(iso: string): number {
  return Date.parse(iso);
}

/**
 * Whether an event counts as a production deploy under the settings: right
 * environment, and for a pipeline run, a pipeline the org named as a deploy.
 */
export function isProductionDeploy(event: DoraDeployEvent, settings: DoraSettings): boolean {
  if (!isProductionEnvironment(event.environment, settings.productionEnvironments)) {
    // A pipeline run has no environment of its own; its name is what says it
    // deploys, and a deploy pipeline deploys to production unless told otherwise.
    if (event.kind !== "pipeline" || event.environment) return false;
  }
  if (event.kind === "pipeline") {
    return settings.pipelinePatterns.some((p) => matchesDoraPattern(event.name, p));
  }
  return true;
}

/** Deploys of one thing to one environment, the unit rollbacks are found in. */
export function doraStreamKey(event: DoraDeployEvent): string {
  const target = event.targetResourceId ?? event.repository ?? event.name;
  return `${target}\u0000${(event.environment ?? "").toLowerCase()}`;
}

/**
 * Map each rollback deploy's id to the id of the deploy it rolled back.
 *
 * A deploy is a rollback when the provider said so, or when it re-ships a
 * commit that an earlier successful deploy on the same stream shipped before
 * the one immediately preceding it. Either way the deploy it undid is the
 * previous successful one on the stream.
 */
export function detectRollbacks(events: DoraDeployEvent[]): Map<string, string> {
  const streams = new Map<string, DoraDeployEvent[]>();
  for (const e of events) {
    if (e.status !== "success") continue;
    const k = doraStreamKey(e);
    const list = streams.get(k);
    if (list) list.push(e);
    else streams.set(k, [e]);
  }
  const out = new Map<string, string>();
  for (const list of streams.values()) {
    list.sort((a, b) => ms(a.deployedAt) - ms(b.deployedAt) || a.id.localeCompare(b.id));
    for (let i = 1; i < list.length; i++) {
      const cur = list[i]!;
      const prev = list[i - 1]!;
      let rollback = cur.isRollback;
      if (
        !rollback &&
        cur.commitSha &&
        prev.commitSha &&
        !sameCommit(prev.commitSha, cur.commitSha)
      ) {
        for (let j = i - 2; j >= 0; j--) {
          const earlier = list[j]!.commitSha;
          if (earlier && sameCommit(earlier, cur.commitSha)) {
            rollback = true;
            break;
          }
        }
      }
      if (rollback) out.set(cur.id, prev.id);
    }
  }
  return out;
}

/**
 * Two SHAs name the same commit when the shorter is a prefix of the longer:
 * several providers store abbreviated SHAs (GitLab, Bitbucket, CircleCI keep
 * 12 characters), and the same commit can arrive full from one source and
 * abbreviated from another. Seven characters is git's own minimum.
 */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length < 7 || y.length < 7) return x === y;
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

function leadTimeHours(e: DoraDeployEvent): number | null {
  if (!e.commitAt) return null;
  const diff = ms(e.deployedAt) - ms(e.commitAt);
  if (!Number.isFinite(diff)) return null;
  return Math.max(0, diff) / HOUR_MS;
}

/**
 * Classify every production change and collect the restores.
 *
 * Incidents are attributed to **one** change: the most recent production
 * change in `[startedAt - window, startedAt]` that touched an affected
 * resource or account. An incident naming nothing is attributed to the most
 * recent production change in the window, whatever it touched; the person
 * who declared it said "something broke", and the last change is the honest
 * first suspect. A change can fail at most once, by its earliest failure.
 */
export function analyzeDora(input: DoraAnalysisInput): DoraAnalysis {
  const { settings } = input;
  const windowMs = settings.failureWindowHours * HOUR_MS;

  const rollbacks = detectRollbacks(input.events);
  const eventsById = new Map(input.events.map((e) => [e.id, e]));

  const changes: DoraChange[] = [];
  const changeEvents = new Map<string, DoraDeployEvent>();
  for (const e of input.events) {
    if (!isProductionDeploy(e, settings)) continue;
    const failedDeploy = e.status === "failure" && settings.countFailedDeploys;
    if (e.status !== "success" && !failedDeploy) continue;
    changes.push({
      id: e.id,
      type: "deploy",
      name: e.name,
      environment: e.environment,
      repository: e.repository,
      commitSha: e.commitSha,
      at: e.deployedAt,
      status: e.status,
      source: e.source,
      pluginId: e.pluginId,
      url: e.url,
      isRollback: rollbacks.has(e.id),
      leadTimeHours: e.status === "success" ? leadTimeHours(e) : null,
      failure: failedDeploy
        ? { kind: "failed_deploy", refId: e.id, title: e.name, at: e.deployedAt }
        : null,
      scope: e.scope,
    });
    changeEvents.set(e.id, e);
  }
  const resourceChangeById = new Map<string, DoraResourceChangeInput>();
  if (settings.includeResourceChanges) {
    for (const rc of input.resourceChanges) {
      const reverted =
        rc.revertedAt !== null && ms(rc.revertedAt) - ms(rc.at) <= windowMs
          ? ({
              kind: "reverted",
              refId: rc.id,
              title: rc.displayName,
              at: rc.revertedAt,
            } satisfies DoraFailure)
          : null;
      changes.push({
        id: rc.id,
        type: "resource_change",
        name: rc.displayName,
        environment: null,
        repository: null,
        commitSha: null,
        at: rc.at,
        status: "success",
        source: "change_timeline",
        pluginId: rc.pluginId,
        url: null,
        isRollback: false,
        leadTimeHours: null,
        failure: reverted,
        scope: rc.scope,
      });
      resourceChangeById.set(rc.id, rc);
    }
  }
  changes.sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  const changeById = new Map(changes.map((c) => [c.id, c]));

  const fail = (c: DoraChange, f: DoraFailure) => {
    if (!c.failure || ms(f.at) < ms(c.failure.at)) c.failure = f;
  };

  const restores: DoraRestore[] = [];

  // Rollbacks: the deploy that was undone failed, if the undo came in time.
  for (const [rollbackId, undoneId] of rollbacks) {
    const rb = eventsById.get(rollbackId);
    const undone = changeById.get(undoneId);
    if (!rb || !undone) continue;
    const gap = ms(rb.deployedAt) - ms(undone.at);
    if (gap < 0 || gap > windowMs) continue;
    fail(undone, { kind: "rollback", refId: rb.id, title: rb.name, at: rb.deployedAt });
    restores.push({
      kind: "rollback",
      id: rb.id,
      title: rb.name,
      startedAt: undone.at,
      restoredAt: rb.deployedAt,
      hours: gap / HOUR_MS,
      changeId: undone.id,
    });
  }

  // Incidents: one change each, the most recent matching one in the window.
  for (const inc of input.incidents) {
    const start = ms(inc.startedAt);
    const affectedResources = new Set(inc.affectedResourceIds);
    const affectedAccounts = new Set(inc.affectedAccountIds);
    const namesAnything = affectedResources.size > 0 || affectedAccounts.size > 0;
    let blamed: DoraChange | null = null;
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]!;
      const at = ms(c.at);
      if (at > start) continue;
      if (start - at > windowMs) break;
      if (
        namesAnything &&
        !changeTouches(c, changeEvents, resourceChangeById, affectedResources, affectedAccounts)
      ) {
        continue;
      }
      blamed = c;
      break;
    }
    if (blamed)
      fail(blamed, { kind: "incident", refId: inc.id, title: inc.title, at: inc.startedAt });
    if (inc.resolvedAt) {
      restores.push({
        kind: "incident",
        id: inc.id,
        title: inc.title,
        startedAt: inc.startedAt,
        restoredAt: inc.resolvedAt,
        hours: Math.max(0, ms(inc.resolvedAt) - start) / HOUR_MS,
        changeId: blamed?.id ?? null,
      });
    }
  }

  restores.sort((a, b) => ms(a.restoredAt) - ms(b.restoredAt) || a.id.localeCompare(b.id));
  return { changes, restores };
}

function changeTouches(
  c: DoraChange,
  events: Map<string, DoraDeployEvent>,
  resourceChanges: Map<string, DoraResourceChangeInput>,
  resources: Set<string>,
  accounts: Set<string>,
): boolean {
  const e = events.get(c.id);
  if (e) {
    if (e.resourceId && resources.has(e.resourceId)) return true;
    if (e.targetResourceId && resources.has(e.targetResourceId)) return true;
    if (e.accountId && accounts.has(e.accountId)) return true;
    return false;
  }
  const rc = resourceChanges.get(c.id);
  if (rc) return resources.has(rc.resourceId) || accounts.has(rc.accountId);
  return false;
}

/* --------------------------------- summary --------------------------------- */

export type DoraBand = "elite" | "high" | "medium" | "low";
export const DORA_BANDS: readonly DoraBand[] = ["elite", "high", "medium", "low"];
export type DoraMetric =
  "deployment_frequency" | "lead_time" | "change_failure_rate" | "time_to_restore";
export const DORA_METRICS: readonly DoraMetric[] = [
  "deployment_frequency",
  "lead_time",
  "change_failure_rate",
  "time_to_restore",
];

/**
 * The standard performance bands from the State of DevOps research. Frequency
 * is deploys per day (higher is better); the rest are lower-is-better, lead
 * time and restore in hours, failure rate as a fraction.
 */
export const DORA_BAND_THRESHOLDS = {
  deployment_frequency: { elite: 1, high: 1 / 7, medium: 1 / 30 },
  lead_time: { elite: 24, high: 24 * 7, medium: 24 * 30 },
  change_failure_rate: { elite: 0.05, high: 0.1, medium: 0.15 },
  time_to_restore: { elite: 1, high: 24, medium: 24 * 7 },
} as const;

export function doraBand(metric: DoraMetric, value: number | null): DoraBand | null {
  if (value === null || !Number.isFinite(value)) return null;
  const t = DORA_BAND_THRESHOLDS[metric];
  if (metric === "deployment_frequency") {
    if (value >= t.elite) return "elite";
    if (value >= t.high) return "high";
    if (value >= t.medium) return "medium";
    return "low";
  }
  // Lower is better; the boundary itself belongs to the better band only
  // for the failure rate, whose published bands are inclusive.
  const inclusive = metric === "change_failure_rate";
  const within = (limit: number) => (inclusive ? value <= limit : value < limit);
  if (within(t.elite)) return "elite";
  if (within(t.high)) return "high";
  if (within(t.medium)) return "medium";
  return "low";
}

export interface DoraMetricValue {
  /** Per day, hours, or a 0-1 fraction; null when there was nothing to measure. */
  value: number | null;
  band: DoraBand | null;
  /** How many observations the value rests on. */
  sample: number;
}

export interface DoraSummary {
  deploymentFrequency: DoraMetricValue & { deploys: number; days: number };
  /** Median hours from commit to production. */
  leadTime: DoraMetricValue & { p90Hours: number | null };
  changeFailureRate: DoraMetricValue & { changes: number; failures: number };
  /** Median hours from failure to recovery. */
  timeToRestore: DoraMetricValue & { restores: number };
}

export function doraQuantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function inRange(iso: string, fromMs: number, toMs: number): boolean {
  const t = ms(iso);
  return t >= fromMs && t < toMs;
}

/** The four numbers over `[from, to)`. */
export function summarizeDora(analysis: DoraAnalysis, from: string, to: string): DoraSummary {
  const fromMs = ms(from);
  const toMs = ms(to);
  const days = Math.max(1 / 24, (toMs - fromMs) / DAY_MS);
  const changes = analysis.changes.filter((c) => inRange(c.at, fromMs, toMs));
  const deploys = changes.filter((c) => c.type === "deploy" && c.status === "success").length;
  const leads = changes
    .map((c) => c.leadTimeHours)
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);
  const failures = changes.filter((c) => c.failure !== null).length;
  const restoreHours = analysis.restores
    .filter((r) => inRange(r.restoredAt, fromMs, toMs))
    .map((r) => r.hours)
    .sort((a, b) => a - b);

  const perDay = deploys / days;
  const leadMedian = doraQuantile(leads, 0.5);
  const cfr = changes.length > 0 ? failures / changes.length : null;
  const restoreMedian = doraQuantile(restoreHours, 0.5);
  return {
    deploymentFrequency: {
      value: perDay,
      // No deploys at all is "we know of none", which bands as low only once
      // anything was ever seen; an org with no data gets no band.
      band: deploys > 0 || changes.length > 0 ? doraBand("deployment_frequency", perDay) : null,
      sample: deploys,
      deploys,
      days,
    },
    leadTime: {
      value: leadMedian,
      band: doraBand("lead_time", leadMedian),
      sample: leads.length,
      p90Hours: doraQuantile(leads, 0.9),
    },
    changeFailureRate: {
      value: cfr,
      band: doraBand("change_failure_rate", cfr),
      sample: changes.length,
      changes: changes.length,
      failures,
    },
    timeToRestore: {
      value: restoreMedian,
      band: doraBand("time_to_restore", restoreMedian),
      sample: restoreHours.length,
      restores: restoreHours.length,
    },
  };
}

/* ---------------------------------- scope ---------------------------------- */

export interface DoraDimensionInfo {
  id: string;
  label: string;
}

/** Built in; integrations register more (see `registerDoraScopeDimension` in server-core). */
export const DORA_BUILTIN_DIMENSIONS: readonly DoraDimensionInfo[] = [
  { id: "environment", label: "Environment" },
  { id: "repository", label: "Repository" },
  { id: "owner", label: "Owner" },
];

export interface DoraScopeFilter {
  dimension: string;
  /** A scope key, or null for "not known" (no owner, no repository). */
  value: string | null;
}

/** Keep the changes in scope, and the restores attributable to them. */
export function scopeDoraAnalysis(
  analysis: DoraAnalysis,
  filter: DoraScopeFilter | null,
): DoraAnalysis {
  if (!filter) return analysis;
  const changes = analysis.changes.filter(
    (c) => (c.scope[filter.dimension]?.key ?? null) === filter.value,
  );
  const ids = new Set(changes.map((c) => c.id));
  return {
    changes,
    // An unattributed incident cannot be placed in any scope, so a scoped
    // restore time only counts recoveries from this scope's own changes.
    restores: analysis.restores.filter((r) => r.changeId !== null && ids.has(r.changeId)),
  };
}

/* --------------------------------- report ---------------------------------- */

export type DoraBucketSize = "day" | "week";

export interface DoraTrendBucket {
  /** Bucket start, ISO; weeks start on Monday 00:00 UTC. */
  start: string;
  deploys: number;
  changes: number;
  failures: number;
  restores: number;
  leadTimeMedianHours: number | null;
  changeFailureRate: number | null;
  restoreMedianHours: number | null;
}

export interface DoraBreakdownRow {
  key: string | null;
  label: string;
  summary: DoraSummary;
}

export interface DoraReport {
  from: string;
  to: string;
  bucket: DoraBucketSize;
  filter: DoraScopeFilter | null;
  groupBy: string;
  summary: DoraSummary;
  /** The same-length period immediately before `from`, for deltas. */
  previous: DoraSummary;
  trend: DoraTrendBucket[];
  breakdown: DoraBreakdownRow[];
  dimensions: DoraDimensionInfo[];
  settings: DoraSettingsView;
  /** How many raw deploy events of any environment the window held. */
  eventCount: number;
  /**
   * Every value each dimension took among the window's production changes,
   * before the filter: what the scope picker offers.
   */
  scopeValues: Record<string, DoraScopeValue[]>;
}

export function doraBucketStart(t: number, bucket: DoraBucketSize): number {
  const d = new Date(t);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === "day") return day;
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return day - dow * DAY_MS;
}

export function buildDoraTrend(
  analysis: DoraAnalysis,
  from: string,
  to: string,
  bucket: DoraBucketSize,
): DoraTrendBucket[] {
  const fromMs = ms(from);
  const toMs = ms(to);
  const step = bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const out: DoraTrendBucket[] = [];
  for (let s = doraBucketStart(fromMs, bucket); s < toMs; s += step) {
    const lo = Math.max(s, fromMs);
    const hi = Math.min(s + step, toMs);
    const sum = summarizeDora(analysis, new Date(lo).toISOString(), new Date(hi).toISOString());
    out.push({
      start: new Date(s).toISOString(),
      deploys: sum.deploymentFrequency.deploys,
      changes: sum.changeFailureRate.changes,
      failures: sum.changeFailureRate.failures,
      restores: sum.timeToRestore.restores,
      leadTimeMedianHours: sum.leadTime.value,
      changeFailureRate: sum.changeFailureRate.value,
      restoreMedianHours: sum.timeToRestore.value,
    });
  }
  return out;
}

export const DORA_MAX_BREAKDOWN_ROWS = 25;

export function buildDoraBreakdown(
  analysis: DoraAnalysis,
  dimension: string,
  from: string,
  to: string,
): DoraBreakdownRow[] {
  const fromMs = ms(from);
  const toMs = ms(to);
  const groups = new Map<string, { key: string | null; label: string; count: number }>();
  for (const c of analysis.changes) {
    if (!inRange(c.at, fromMs, toMs)) continue;
    const v = c.scope[dimension] ?? null;
    const id = v ? `k:${v.key}` : "none";
    const g = groups.get(id);
    if (g) g.count++;
    else groups.set(id, { key: v?.key ?? null, label: v?.label ?? "", count: 1 });
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, DORA_MAX_BREAKDOWN_ROWS);
  return rows.map((g) => ({
    key: g.key,
    label: g.label,
    summary: summarizeDora(scopeDoraAnalysis(analysis, { dimension, value: g.key }), from, to),
  }));
}

export interface BuildDoraReportInput extends DoraAnalysisInput {
  from: string;
  to: string;
  bucket: DoraBucketSize;
  filter: DoraScopeFilter | null;
  groupBy: string;
  dimensions: DoraDimensionInfo[];
  settingsView: DoraSettingsView;
}

/**
 * The whole report. The inputs should cover `[from - (to - from) - window, to)`
 * so the previous period's changes can be blamed for failures too.
 */
export function buildDoraReport(input: BuildDoraReportInput): DoraReport {
  const unscoped = analyzeDora(input);
  const analysis = scopeDoraAnalysis(unscoped, input.filter);
  const span = ms(input.to) - ms(input.from);
  const prevFrom = new Date(ms(input.from) - span).toISOString();
  const fromMs = ms(input.from);
  const toMs = ms(input.to);
  return {
    from: input.from,
    to: input.to,
    bucket: input.bucket,
    filter: input.filter,
    groupBy: input.groupBy,
    summary: summarizeDora(analysis, input.from, input.to),
    previous: summarizeDora(analysis, prevFrom, input.from),
    trend: buildDoraTrend(analysis, input.from, input.to, input.bucket),
    breakdown: buildDoraBreakdown(analysis, input.groupBy, input.from, input.to),
    dimensions: input.dimensions,
    settings: input.settingsView,
    eventCount: input.events.filter((e) => inRange(e.deployedAt, fromMs, toMs)).length,
    scopeValues: collectScopeValues(unscoped, input.dimensions, fromMs, toMs),
  };
}

function collectScopeValues(
  analysis: DoraAnalysis,
  dimensions: DoraDimensionInfo[],
  fromMs: number,
  toMs: number,
): Record<string, DoraScopeValue[]> {
  const out: Record<string, DoraScopeValue[]> = {};
  for (const d of dimensions) {
    const seen = new Map<string, DoraScopeValue>();
    for (const c of analysis.changes) {
      if (!inRange(c.at, fromMs, toMs)) continue;
      const v = c.scope[d.id];
      if (v && !seen.has(v.key)) seen.set(v.key, v);
    }
    out[d.id] = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
  return out;
}

/* -------------------------------- formatting ------------------------------- */

/** "4.2/day", "3/week", "1/month", "none". English; UIs wrap it for translation. */
export function formatDeployFrequency(perDay: number | null): string {
  if (perDay === null || perDay <= 0) return "none";
  if (perDay >= 1) return `${round1(perDay)}/day`;
  if (perDay * 7 >= 1) return `${round1(perDay * 7)}/week`;
  return `${round1(perDay * 30)}/month`;
}

/** "45m", "6.5h", "3.2d"; "n/a" for null. */
export function formatDoraHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "n/a";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${round1(hours)}h`;
  return `${round1(hours / 24)}d`;
}

export function formatDoraRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "n/a";
  return `${round1(rate * 100)}%`;
}

function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Better, worse or flat versus the previous period, from the metric's direction. */
export function doraTrendDirection(
  metric: DoraMetric,
  current: number | null,
  previous: number | null,
): "better" | "worse" | "flat" | null {
  if (current === null || previous === null) return null;
  if (Math.abs(current - previous) < 1e-9) return "flat";
  const higherIsBetter = metric === "deployment_frequency";
  return current > previous === higherIsBetter ? "better" : "worse";
}

/* ------------------------------- wire shapes ------------------------------- */

export interface DoraChangesResponse {
  changes: DoraChange[];
  /** True when more matched than were returned. */
  truncated: boolean;
}

export interface DoraRestoresResponse {
  restores: DoraRestore[];
}

/** A deploy recorded from outside (`POST /dora/deployments`). */
export interface DoraDeploymentInput {
  /** Caller's id for the deploy; re-sending it updates rather than duplicates. */
  externalId: string;
  name: string;
  environment: string;
  repository?: string | null;
  commitSha?: string | null;
  commitAt?: string | null;
  deployedAt: string;
  status?: DoraDeployStatus;
  isRollback?: boolean;
  url?: string | null;
}

/** What every client asks the report and drill-down routes for. */
export interface DoraQuery {
  from: string;
  to: string;
  /** Filter dimension; with `value` undefined or null it filters to "not known". */
  dimension?: string | undefined;
  value?: string | null | undefined;
  groupBy?: string | undefined;
  bucket?: DoraBucketSize | undefined;
  failedOnly?: boolean | undefined;
}

/** The query string for `/dora`, `/dora/changes` and `/dora/restores`, without the `?`. */
export function doraQueryString(q: DoraQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  if (q.dimension) {
    p.set("dimension", q.dimension);
    if (q.value) p.set("value", q.value);
  }
  if (q.groupBy) p.set("groupBy", q.groupBy);
  if (q.bucket) p.set("bucket", q.bucket);
  if (q.failedOnly) p.set("failedOnly", "true");
  return p.toString();
}

/** `[from, to)` covering the last `days` days ending now, as ISO strings. */
export function doraRangeForDays(
  days: number,
  now: Date = new Date(),
): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
}

export const DORA_RANGE_DAYS: readonly number[] = [7, 30, 90, 180, 365];

/* ------------------------------- fetch helpers ------------------------------ */

/** `GET /api/org/:orgId/dora` (`deployments:read`). */
export async function fetchDoraReport(
  api: CloudFetch,
  orgId: string,
  query: DoraQuery,
): Promise<DoraReport | null> {
  return api.org<DoraReport>(orgId, `/dora?${doraQueryString(query)}`);
}

/** `GET /api/org/:orgId/dora/changes` (`deployments:read`). */
export async function fetchDoraChanges(
  api: CloudFetch,
  orgId: string,
  query: DoraQuery,
): Promise<DoraChangesResponse> {
  const res = await api.org<DoraChangesResponse>(orgId, `/dora/changes?${doraQueryString(query)}`);
  return res ?? { changes: [], truncated: false };
}

/** `GET /api/org/:orgId/dora/restores` (`deployments:read`). */
export async function fetchDoraRestores(
  api: CloudFetch,
  orgId: string,
  query: DoraQuery,
): Promise<DoraRestoresResponse> {
  const res = await api.org<DoraRestoresResponse>(
    orgId,
    `/dora/restores?${doraQueryString(query)}`,
  );
  return res ?? { restores: [] };
}
