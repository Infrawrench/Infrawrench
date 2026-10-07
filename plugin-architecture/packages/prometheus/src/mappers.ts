/**
 * Raw Prometheus / Alertmanager shapes (only what the plugin reads) and their
 * mapping to `ResourceInstance`s.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinId, labelsKey, labelText } from "./api.js";

export const PLUGIN_ID = "prometheus";

export interface BuildInfo {
  version?: string;
  revision?: string;
  goVersion?: string;
}

export interface RuntimeInfo {
  startTime?: string;
  storageRetention?: string;
  reloadConfigSuccess?: boolean;
  lastConfigTime?: string;
  corruptionCount?: number;
  timeSeriesCount?: number;
}

export interface TsdbStatus {
  headStats?: { numSeries?: number; chunkCount?: number; minTime?: number; maxTime?: number };
  seriesCountByMetricName?: Array<{ name?: string; value?: number }>;
  labelValueCountByLabelName?: Array<{ name?: string; value?: number }>;
  memoryInBytesByLabelName?: Array<{ name?: string; value?: number }>;
  seriesCountByLabelValuePair?: Array<{ name?: string; value?: number }>;
}

export interface Target {
  discoveredLabels?: Record<string, string>;
  labels?: Record<string, string>;
  scrapePool?: string;
  scrapeUrl?: string;
  globalUrl?: string;
  lastError?: string;
  lastScrape?: string;
  lastScrapeDuration?: number;
  health?: string;
  scrapeInterval?: string;
  scrapeTimeout?: string;
}

export interface TargetsData {
  activeTargets?: Target[];
  droppedTargets?: Target[];
}

export interface Alert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  state?: string;
  activeAt?: string;
  value?: string;
}

export interface Rule {
  name?: string;
  query?: string;
  type?: "alerting" | "recording";
  duration?: number;
  keepFiringFor?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  alerts?: Alert[];
  health?: string;
  lastError?: string;
  state?: string;
  evaluationTime?: number;
  lastEvaluation?: string;
}

export interface RuleGroup {
  name?: string;
  file?: string;
  interval?: number;
  rules?: Rule[];
  evaluationTime?: number;
  lastEvaluation?: string;
}

export interface AmStatus {
  cluster?: { name?: string; status?: string; peers?: Array<{ name?: string; address?: string }> };
  versionInfo?: { version?: string };
  config?: { original?: string };
  uptime?: string;
}

export interface Matcher {
  name: string;
  value: string;
  isRegex: boolean;
  isEqual?: boolean;
}

export interface Silence {
  id?: string;
  matchers?: Matcher[];
  startsAt?: string;
  endsAt?: string;
  createdBy?: string;
  comment?: string;
  updatedAt?: string;
  status?: { state?: string };
}

export interface AmAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  receivers?: Array<{ name?: string }>;
  fingerprint?: string;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  status?: { state?: string; silencedBy?: string[]; inhibitedBy?: string[] };
}

type FieldValue = string | number | boolean | undefined | null;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

const iso = (ms: number | undefined) =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;

export function mapServer(
  accountId: string,
  url: string,
  build: BuildInfo | undefined,
  runtime: RuntimeInfo | undefined,
  tsdb: TsdbStatus | undefined,
  targets: TargetsData | undefined,
  groups: RuleGroup[] | undefined,
  alertmanagers: string[] | undefined,
): ResourceInstance {
  const active = targets?.activeTargets ?? [];
  const rules = (groups ?? []).flatMap((g) => g.rules ?? []);
  const alerts = rules.flatMap((r) => r.alerts ?? []);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const r = instance(accountId, "prometheus-server", "server", host || "Prometheus", {
    url,
    version: build?.version,
    revision: build?.revision,
    goVersion: build?.goVersion,
    startTime: runtime?.startTime,
    storageRetention: runtime?.storageRetention,
    reloadConfigSuccess: runtime?.reloadConfigSuccess,
    lastConfigTime: runtime?.lastConfigTime,
    corruptionCount: runtime?.corruptionCount,
    headSeries: tsdb?.headStats?.numSeries ?? runtime?.timeSeriesCount,
    headChunks: tsdb?.headStats?.chunkCount,
    oldestHeadSample: iso(tsdb?.headStats?.minTime),
    targetsUp: targets ? active.filter((t) => t.health === "up").length : undefined,
    targetsDown: targets ? active.filter((t) => t.health === "down").length : undefined,
    scrapePools: targets ? new Set(active.map((t) => t.scrapePool)).size : undefined,
    ruleGroups: groups?.length,
    rules: groups ? rules.length : undefined,
    rulesUnhealthy: groups ? rules.filter((x) => x.health && x.health !== "ok").length : undefined,
    alertsFiring: groups ? alerts.filter((a) => a.state === "firing").length : undefined,
    alertsPending: groups ? alerts.filter((a) => a.state === "pending").length : undefined,
    alertmanagers: alertmanagers?.join(", "),
  });
  r.resolvedOutputs = { url };
  return r;
}

export function mapScrapePool(
  accountId: string,
  name: string,
  targets: Target[],
  dropped: number,
): ResourceInstance {
  return instance(accountId, "prometheus-scrape-pool", joinId(name), name, {
    name,
    targets: targets.length,
    up: targets.filter((t) => t.health === "up").length,
    down: targets.filter((t) => t.health === "down").length,
    dropped,
    scrapeInterval: targets[0]?.scrapeInterval,
    scrapeTimeout: targets[0]?.scrapeTimeout,
  });
}

export function targetId(t: Target): string {
  return joinId(t.scrapePool ?? "", t.scrapeUrl ?? "", labelsKey(t.labels));
}

export function mapTarget(accountId: string, t: Target): ResourceInstance {
  const pool = t.scrapePool ?? "";
  const instanceLabel = t.labels?.["instance"] ?? "";
  const r = instance(
    accountId,
    "prometheus-target",
    targetId(t),
    instanceLabel || t.scrapeUrl || pool,
    {
      scrapePool: pool,
      instance: instanceLabel,
      job: t.labels?.["job"],
      scrapeUrl: t.scrapeUrl,
      health: t.health,
      lastError: t.lastError,
      lastScrape: t.lastScrape,
      lastScrapeDuration:
        typeof t.lastScrapeDuration === "number"
          ? Math.round(t.lastScrapeDuration * 10_000) / 10_000
          : undefined,
      scrapeInterval: t.scrapeInterval,
      scrapeTimeout: t.scrapeTimeout,
      labels: labelText(t.labels),
    },
    { parentResourceId: `${accountId}:prometheus-scrape-pool:${joinId(pool)}` },
  );
  r.resolvedOutputs = { scrapeUrl: t.scrapeUrl ?? "", instance: instanceLabel };
  return r;
}

export function groupId(g: RuleGroup): string {
  return joinId(g.file ?? "", g.name ?? "");
}

export function mapRuleGroup(accountId: string, g: RuleGroup): ResourceInstance {
  const rules = g.rules ?? [];
  return instance(accountId, "prometheus-rule-group", groupId(g), g.name ?? "", {
    name: g.name,
    file: g.file,
    interval: g.interval,
    rules: rules.length,
    alertingRules: rules.filter((r) => r.type === "alerting").length,
    recordingRules: rules.filter((r) => r.type === "recording").length,
    unhealthy: rules.filter((r) => r.health && r.health !== "ok").length,
    firing: rules.filter((r) => r.state === "firing").length,
    evaluationTime:
      typeof g.evaluationTime === "number"
        ? Math.round(g.evaluationTime * 10_000) / 10_000
        : undefined,
    lastEvaluation: g.lastEvaluation,
  });
}

/** Rule ids: file / group / name, with `#n` added when a name repeats inside a group. */
export function ruleIds(g: RuleGroup): string[] {
  const seen = new Map<string, number>();
  return (g.rules ?? []).map((r) => {
    const name = r.name ?? "";
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return joinId(g.file ?? "", g.name ?? "", n > 1 ? `${name}#${n}` : name);
  });
}

export function mapRule(accountId: string, g: RuleGroup, r: Rule, id: string): ResourceInstance {
  const res = instance(
    accountId,
    "prometheus-rule",
    id,
    r.name ?? "",
    {
      group: g.name,
      file: g.file,
      name: r.name,
      type: r.type,
      query: r.query,
      duration: r.duration,
      keepFiringFor: r.keepFiringFor || undefined,
      state: r.type === "alerting" ? r.state : undefined,
      activeAlerts: r.type === "alerting" ? (r.alerts ?? []).length : undefined,
      health: r.health,
      lastError: r.lastError,
      labels: labelText(r.labels),
      annotations: Object.entries(r.annotations ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
      evaluationTime:
        typeof r.evaluationTime === "number"
          ? Math.round(r.evaluationTime * 1_000_000) / 1_000_000
          : undefined,
      lastEvaluation: r.lastEvaluation,
    },
    { parentResourceId: `${accountId}:prometheus-rule-group:${groupId(g)}` },
  );
  res.resolvedOutputs = { query: r.query ?? "" };
  return res;
}

export function mapAlert(accountId: string, a: Alert): ResourceInstance {
  const l = a.labels ?? {};
  return instance(accountId, "prometheus-alert", labelsKey(l), l["alertname"] ?? "alert", {
    alertname: l["alertname"],
    state: a.state,
    severity: l["severity"],
    activeAt: a.activeAt,
    value: a.value,
    labels: labelText(l),
    summary: a.annotations?.["summary"],
    description: a.annotations?.["description"],
  });
}

export function mapAlertmanager(
  accountId: string,
  url: string,
  s: AmStatus | undefined,
  counts: { receivers?: number; silences?: number; alerts?: number },
): ResourceInstance {
  return instance(
    accountId,
    "prometheus-alertmanager",
    "alertmanager",
    (() => {
      try {
        return new URL(url).host;
      } catch {
        return "Alertmanager";
      }
    })(),
    {
      url,
      version: s?.versionInfo?.version,
      clusterStatus: s?.cluster?.status,
      clusterName: s?.cluster?.name,
      peers: s?.cluster?.peers?.length,
      uptime: s?.uptime,
      receivers: counts.receivers,
      activeSilences: counts.silences,
      alerts: counts.alerts,
    },
    { resolvedOutputs: { url } },
  );
}

const AM_PARENT = (accountId: string) => `${accountId}:prometheus-alertmanager:alertmanager`;

export function matcherText(m: Matcher): string {
  const op = m.isRegex ? (m.isEqual === false ? "!~" : "=~") : m.isEqual === false ? "!=" : "=";
  return `${m.name}${op}"${m.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Parse `a="b", c=~"d.*", e!="f"` (quotes optional) into matchers. */
export function parseMatchers(raw: string): Matcher[] {
  const out: Matcher[] = [];
  const re =
    /\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*(?:"((?:[^"\\]|\\.)*)"|([^,]*))\s*(?:,|$)/gy;
  const text = raw.trim().replace(/^\{|\}$/g, "");
  let m: RegExpExecArray | null;
  let last = 0;
  while (last < text.length && (m = re.exec(text)) !== null) {
    if (m[0] === "") break;
    last = re.lastIndex;
    const op = m[2]!;
    const value = m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : (m[4] ?? "").trim();
    out.push({ name: m[1]!, value, isRegex: op.includes("~"), isEqual: !op.startsWith("!") });
  }
  if (last < text.length && text.slice(last).trim()) {
    throw new Error(`Cannot read the matchers near "${text.slice(last, last + 30)}"`);
  }
  return out;
}

export function mapSilence(accountId: string, s: Silence): ResourceInstance {
  const matchers = (s.matchers ?? []).map(matcherText).join(", ");
  return instance(
    accountId,
    "prometheus-silence",
    s.id ?? "",
    matchers || s.id || "silence",
    {
      matchers,
      state: s.status?.state,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      createdBy: s.createdBy,
      comment: s.comment,
      updatedAt: s.updatedAt,
    },
    { parentResourceId: AM_PARENT(accountId) },
  );
}

export function mapAmAlert(accountId: string, a: AmAlert): ResourceInstance {
  const l = a.labels ?? {};
  return instance(
    accountId,
    "prometheus-am-alert",
    a.fingerprint || labelsKey(l),
    l["alertname"] ?? "alert",
    {
      alertname: l["alertname"],
      state: a.status?.state,
      severity: l["severity"],
      receivers: (a.receivers ?? []).map((r) => r.name).join(", "),
      silencedBy: (a.status?.silencedBy ?? []).join(", "),
      inhibitedBy: (a.status?.inhibitedBy ?? []).join(", "),
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      labels: labelText(l),
      summary: a.annotations?.["summary"],
      generatorUrl: a.generatorURL,
    },
    { parentResourceId: AM_PARENT(accountId) },
  );
}

export function mapReceiver(accountId: string, name: string, alerts: number): ResourceInstance {
  return instance(
    accountId,
    "prometheus-receiver",
    joinId(name),
    name,
    { name, alerts },
    { parentResourceId: AM_PARENT(accountId) },
  );
}

/** `labels` text (`a="b", c="d"`) back to equality matchers, for "silence this alert". */
export function labelsToMatchers(labels: Record<string, string>): string {
  return Object.entries(labels)
    .filter(([k]) => k !== "__name__")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => matcherText({ name: k, value: v, isRegex: false }))
    .join(", ");
}
