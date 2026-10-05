import type {
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import type {
  TelemetryQueryParams,
  TelemetryQueryResponse,
} from "cloudflare/resources/workers/observability/telemetry";
import { type CloudflareApi, withAuthErrorHint } from "./shared.js";

/**
 * Workers Observability: the Telemetry query API behind the dashboard's
 * Workers Logs and Traces views and, since 2026-10-02, the Custom Dashboards
 * "Workers Observability" datasets.
 *
 *   POST /accounts/{account_id}/workers/observability/telemetry/query
 *   https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/
 *
 * One endpoint, several response shapes picked by `view`: `events` (log
 * lines), `calculations` (count/avg/pNN with group-bys and a time series when
 * `chart` is set) and `traces` (one summary per distributed trace). Every
 * query here filters on `$metadata.service`, which is the Worker script name.
 * Queries run with `dry: true` so they don't pile up as saved query runs in
 * the user's dashboard.
 *
 * The API reference lists "Workers Observability Write" as the accepted
 * permission (shown as Workers Observability · Edit in the token UI), even
 * for these read-only queries.
 */

/** Token permission named in the missing-permission hint. */
export const WORKERS_OBSERVABILITY_SCOPE = "Account · Workers Observability:Edit";

/** Dataset holding Workers Logs (invocation + console events). */
const LOGS_DATASET = "cloudflare-workers";

/** API cap on `limit` for the events view. */
const MAX_EVENTS = 2000;
const DEFAULT_EVENTS = 200;

const DAY_MS = 24 * 3_600_000;
/** Workers Logs retention on the paid plan; the free plan keeps three days. */
const RETENTION_MS = 7 * DAY_MS;

type Filter = TelemetryQueryParams.Parameters.WorkersObservabilityFilterLeaf;
type TelemetryEvent = NonNullable<NonNullable<TelemetryQueryResponse["events"]>["events"]>[number];
export type WorkerTraceSummary = TelemetryQueryResponse.Trace;

const serviceFilter = (scriptName: string): Filter => ({
  key: "$metadata.service",
  operation: "eq",
  type: "string",
  value: scriptName,
});

/**
 * Logs-tab filters, surfaced through the host's container dropdown (the
 * Deepgram precedent): `LogsFetchParams` has no level or outcome field of its
 * own, and a dropdown beats asking the user to type a query key.
 */
export const WORKER_LOG_FILTERS: ReadonlyArray<{ id: string; filters: Filter[] }> = [
  { id: "all events", filters: [] },
  {
    id: "errors",
    filters: [{ key: "$metadata.level", operation: "eq", type: "string", value: "error" }],
  },
  {
    id: "warnings and errors",
    filters: [{ key: "$metadata.level", operation: "in", type: "string", value: "warn,error" }],
  },
  {
    // Any invocation that didn't finish cleanly: uncaught exception, CPU or
    // memory limit, canceled, and so on.
    id: "failed invocations",
    filters: [
      { key: "$workers.outcome", operation: "exists", type: "string" },
      { key: "$workers.outcome", operation: "neq", type: "string", value: "ok" },
    ],
  },
  {
    id: "invocations only",
    filters: [{ key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-event" }],
  },
  {
    id: "console logs only",
    filters: [{ key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-log" }],
  },
];

/** Run one telemetry query, mapping an auth failure onto the permission hint. */
async function runQuery(
  api: CloudflareApi,
  body: Omit<TelemetryQueryParams, "account_id">,
): Promise<TelemetryQueryResponse> {
  const account_id = await api.getAccountId();
  return withAuthErrorHint(
    () => api.cf.workers.observability.telemetry.query({ account_id, dry: true, ...body }),
    "Workers Observability data",
    WORKERS_OBSERVABILITY_SCOPE,
  );
}

/** Observability switches as the script settings endpoint reports them. */
export interface WorkerObservabilityState {
  enabled: boolean;
  logsEnabled: boolean;
  invocationLogs: boolean;
  tracesEnabled: boolean;
  headSamplingRate: number | null;
  logsSamplingRate: number | null;
  tracesSamplingRate: number | null;
}

/**
 * Read the Worker's observability settings. `logs` and `traces` are optional
 * sub-objects: when `logs` is absent, logs follow the top-level switch, which
 * is how Wrangler writes `[observability] enabled = true`.
 */
export async function getWorkerObservabilityState(
  api: CloudflareApi,
  scriptName: string,
): Promise<WorkerObservabilityState> {
  const account_id = await api.getAccountId();
  const s = await api.cf.workers.scripts.settings.get(scriptName, { account_id });
  const o = s.observability;
  const enabled = o?.enabled === true;
  return {
    enabled,
    logsEnabled: enabled && (o?.logs ? o.logs.enabled !== false : true),
    invocationLogs: enabled && (o?.logs ? o.logs.invocation_logs !== false : true),
    tracesEnabled: enabled && o?.traces?.enabled === true,
    headSamplingRate: o?.head_sampling_rate ?? null,
    logsSamplingRate: o?.logs?.head_sampling_rate ?? null,
    tracesSamplingRate: o?.traces?.head_sampling_rate ?? null,
  };
}

const ENABLE_HINT =
  "Turn it on in this Worker's Settings tab (Observability), or set " +
  "`observability.enabled = true` in your Wrangler config and redeploy, then send it some traffic.";

/** Explain an empty log window, distinguishing "off" from "quiet". */
async function emptyLogsText(
  api: CloudflareApi,
  scriptName: string,
  filterId: string,
): Promise<string> {
  let state: WorkerObservabilityState | null = null;
  try {
    state = await getWorkerObservabilityState(api, scriptName);
  } catch {
    state = null;
  }
  if (state && !state.enabled) {
    return `Workers Logs is off for this Worker, so Cloudflare isn't storing its logs. ${ENABLE_HINT}\n`;
  }
  if (state && !state.logsEnabled) {
    return "Observability is on but its logs are turned off for this Worker. Turn on Logs under Observability in the Settings tab.\n";
  }
  const scope = filterId === WORKER_LOG_FILTERS[0]!.id ? "" : ` matching "${filterId}"`;
  return `No log events${scope} in the last 7 days. Workers Logs keeps up to 7 days (3 on Free); newly enabled Workers only show events from then on.\n`;
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Pick the human-readable payload out of a console log event. */
function messageOf(e: TelemetryEvent): string {
  const m = e.$metadata;
  if (m.message) return m.message;
  if (m.error) return m.error;
  if (typeof e.source === "string") return e.source;
  const src = e.source as Record<string, unknown> | undefined;
  if (src && typeof src["message"] === "string") return src["message"];
  return str(src);
}

const ms = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 10) / 10}ms` : "";

/**
 * Render one event as a log line. Invocation events (one per request, cron
 * run, queue batch...) get the request summary: trigger, status, outcome, CPU
 * and wall time, colo. Console events get their level and message. The
 * request id prefix ties a console line back to its invocation.
 */
export function formatWorkerLogLine(e: TelemetryEvent): string {
  const m = e.$metadata;
  const w = (e.$workers ?? {}) as Record<string, unknown>;
  const ts = Number.isFinite(e.timestamp) ? new Date(e.timestamp).toISOString() : "";
  const requestId = str(m.requestId || w["requestId"]);
  const req = requestId ? `req=${requestId.slice(0, 8)}` : "";
  const isInvocation = m.type === "cf-worker-event" || (!m.message && "outcome" in w);

  if (isInvocation) {
    const outcome = str(w["outcome"]);
    const level = outcome && outcome !== "ok" ? "ERROR" : "INFO";
    const trigger = m.trigger || [str(w["eventType"]), m.url ?? ""].filter(Boolean).join(" ");
    const bits = [
      ts,
      level.padEnd(5),
      trigger,
      m.statusCode != null ? String(m.statusCode) : "",
      outcome ? `outcome=${outcome}` : "",
      w["cpuTimeMs"] != null ? `cpu=${ms(w["cpuTimeMs"])}` : "",
      w["wallTimeMs"] != null ? `wall=${ms(w["wallTimeMs"])}` : "",
      m.region ? `colo=${m.region}` : "",
      req,
      m.error ?? "",
    ];
    return bits.filter(Boolean).join("  ");
  }

  const level = (m.level || "log").toUpperCase().padEnd(5);
  return [ts, level, req, messageOf(e)].filter(Boolean).join("  ");
}

/**
 * Logs tab for a Worker: the newest `tailLines` Workers Logs events, oldest
 * first, through the filter picked in the dropdown. Looks back 24 hours, then
 * the full 7-day retention when that came back empty so a quiet Worker still
 * shows its last activity. When nothing comes back at all it checks the
 * Worker's settings to say whether logging is off or the Worker is just idle.
 */
export async function fetchWorkerLogs(
  api: CloudflareApi,
  scriptName: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const filter =
    WORKER_LOG_FILTERS.find((f) => f.id === params.container) ?? WORKER_LOG_FILTERS[0]!;
  const limit = Math.min(
    MAX_EVENTS,
    Math.max(1, params.tailLines && params.tailLines > 0 ? params.tailLines : DEFAULT_EVENTS),
  );
  const containers = WORKER_LOG_FILTERS.map((f) => f.id);

  const query = async (windowMs: number): Promise<TelemetryEvent[]> => {
    const to = Date.now();
    const res = await runQuery(api, {
      queryId: "infrawrench-worker-logs",
      view: "events",
      limit,
      timeframe: { from: to - windowMs, to },
      parameters: {
        datasets: [LOGS_DATASET],
        filterCombination: "and",
        filters: [serviceFilter(scriptName), ...filter.filters],
      },
    });
    return res.events?.events ?? [];
  };

  let events = await query(DAY_MS);
  if (events.length === 0) events = await query(RETENTION_MS);
  if (events.length === 0) {
    return {
      text: await emptyLogsText(api, scriptName, filter.id),
      containers,
      activeContainer: filter.id,
    };
  }
  const lines = [...events]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit)
    .map(formatWorkerLogLine);
  return { text: `${lines.join("\n")}\n`, containers, activeContainer: filter.id };
}

/**
 * Recent distributed traces for the Worker (`view: "traces"`), newest first.
 * Each summary carries the root span, span count, duration, the services it
 * crossed and any error messages. Only populated when Workers Traces is on.
 */
export async function fetchRecentWorkerTraces(
  api: CloudflareApi,
  scriptName: string,
  limit = 25,
): Promise<WorkerTraceSummary[]> {
  const to = Date.now();
  const res = await runQuery(api, {
    queryId: "infrawrench-worker-traces",
    view: "traces",
    limit,
    timeframe: { from: to - DAY_MS, to },
    parameters: { filters: [serviceFilter(scriptName)] },
  });
  return [...(res.traces ?? [])].sort((a, b) => b.traceStartMs - a.traceStartMs).slice(0, limit);
}

/**
 * Collapse a `calculations` result into one series per group (or one series
 * when ungrouped). Each bucket's `data` holds one entry per group.
 */
export function calculationSeries(
  calc: TelemetryQueryResponse.Calculation | undefined,
  label: (group: string) => string,
  unit: string,
): MetricSeries[] {
  if (!calc) return [];
  const byGroup = new Map<string, Map<number, number>>();
  for (const bucket of calc.series ?? []) {
    const t = new Date(bucket.time).getTime();
    if (!Number.isFinite(t)) continue;
    for (const d of bucket.data ?? []) {
      const group = (d.groups ?? []).map((g) => str(g.value)).join(" / ");
      let m = byGroup.get(group);
      if (!m) {
        m = new Map();
        byGroup.set(group, m);
      }
      m.set(t, (m.get(t) ?? 0) + (Number(d.value) || 0));
    }
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, m]) => ({
      label: label(group),
      unit,
      points: [...m.entries()]
        .sort(([a], [b]) => a - b)
        .map(([timestamp, value]) => ({ timestamp, value })),
    }));
}

const findCalc = (
  res: TelemetryQueryResponse,
  alias: string,
): TelemetryQueryResponse.Calculation | undefined =>
  (res.calculations ?? []).find((c) => c.alias === alias || c.calculation === alias);

/**
 * Telemetry-backed Worker series: log events by level (from Workers Logs) and
 * span count plus span-duration p50/p99 (from Workers Traces; spans are the
 * events carrying `$metadata.spanName`). Each half is independent and
 * best-effort: a Worker with observability off, or a token without the
 * Workers Observability permission, just contributes no series, leaving the
 * GraphQL invocation charts intact.
 */
export async function fetchWorkerTelemetrySeries(
  api: CloudflareApi,
  scriptName: string,
  startMs: number,
  endMs: number,
): Promise<MetricSeries[]> {
  const timeframe = { from: startMs, to: endMs };
  const levels = runQuery(api, {
    queryId: "infrawrench-worker-log-levels",
    view: "calculations",
    chart: true,
    timeframe,
    parameters: {
      datasets: [LOGS_DATASET],
      filters: [serviceFilter(scriptName)],
      calculations: [{ operator: "count", alias: "events" }],
      groupBys: [{ type: "string", value: "$metadata.level" }],
      limit: 10,
    },
  })
    .then((res) =>
      calculationSeries(
        findCalc(res, "events"),
        (level) => `Log events: ${level || "unknown"}`,
        "events",
      ),
    )
    .catch(() => [] as MetricSeries[]);

  const spans = runQuery(api, {
    queryId: "infrawrench-worker-spans",
    view: "calculations",
    chart: true,
    timeframe,
    parameters: {
      filters: [
        serviceFilter(scriptName),
        { key: "$metadata.spanName", operation: "exists", type: "string" },
      ],
      calculations: [
        { operator: "count", alias: "spans" },
        { operator: "median", key: "$metadata.duration", keyType: "number", alias: "span_p50" },
        { operator: "p99", key: "$metadata.duration", keyType: "number", alias: "span_p99" },
      ],
    },
  })
    .then((res) => [
      ...calculationSeries(findCalc(res, "spans"), () => "Spans", "spans"),
      ...calculationSeries(findCalc(res, "span_p50"), () => "Span duration p50", "ms"),
      ...calculationSeries(findCalc(res, "span_p99"), () => "Span duration p99", "ms"),
    ])
    .catch(() => [] as MetricSeries[]);

  const out = (await Promise.all([levels, spans])).flat();
  return out.filter((s) => s.points.some((p) => p.value > 0));
}

/**
 * Detail-page enrichment for a Worker: its observability switches and, when
 * Workers Traces is on, the most recent traces. Stored as JSON in
 * `resolvedOutputs` (`__observability__`, `__traces__`, `__tracesError__`)
 * for the synchronous renderer. Each lookup is best-effort: a token without
 * the permission must not blank the page.
 */
export async function enrichWorkerDetail(
  api: CloudflareApi,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  const scriptName = resource.externalId ?? String(resource.fields["name"] ?? "");
  if (!scriptName) return resource;
  const extra: Record<string, string> = {};
  let state: WorkerObservabilityState | null = null;
  try {
    state = await getWorkerObservabilityState(api, scriptName);
    extra["__observability__"] = JSON.stringify(state);
  } catch {
    state = null;
  }
  if (state?.tracesEnabled) {
    try {
      extra["__traces__"] = JSON.stringify(await fetchRecentWorkerTraces(api, scriptName));
    } catch (err) {
      extra["__tracesError__"] = err instanceof Error ? err.message : String(err);
    }
  }
  if (Object.keys(extra).length === 0) return resource;
  return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
}
