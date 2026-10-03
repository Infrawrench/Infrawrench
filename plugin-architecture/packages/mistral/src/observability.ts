import type { LogsFetchParams, LogsFetchResult, MetricSeries } from "@infrawrench/plugin-base";

/**
 * Mistral Studio Observability (Private Preview, Enterprise organizations):
 * OpenTelemetry traces from the Mistral SDK, Workflows, Vibe and anything
 * else instrumented, queryable over the ordinary data-plane key.
 *
 * https://docs.mistral.ai/openapi.yaml (beta.observability.traces / .spans):
 *   - `POST /v1/observability/{traces,spans}/aggregate?from=&to=` takes
 *     `{metric: {measure, aggregation}, time_dimension: {granularity},
 *     search_expression}` and answers `{data: [{time_bucket, metric_value}]}`.
 *   - `POST /v1/observability/{traces,spans}/search?from=&to=&page_size=`
 *     takes `{search_expression}` and answers `{traces|spans: {results}}`.
 *
 * Measures are the documented `GetTrace` / `GetSpan` columns (`duration_ns`,
 * `usage_input_tokens`, `tool_call_count`, ...), and the filters use the
 * Trace Explorer's expression language
 * (https://docs.mistral.ai/studio/observability/traces/explorer).
 *
 * A model is read off **spans** filtered on `request_model`/`response_model`,
 * so its token counts are the model's own calls rather than whole traces that
 * happened to touch it. An agent is read off **traces** filtered on
 * `agent_id`, which is where the per-run tool and LLM call counts live.
 */

/** The data-plane JSON call the client already owns (Bearer, bastion, CA). */
export type ObservabilityFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

type Aggregation = "count" | "sum" | "p50" | "p95";

interface SeriesSpec {
  label: string;
  unit: string;
  measure: string;
  aggregation: Aggregation;
  /** Extra condition ANDed onto the resource filter. */
  where?: string;
  /** Applied to each bucket value (nanoseconds to milliseconds, say). */
  scale?: number;
}

interface AggregationRow {
  time_bucket?: string | null;
  metric_value?: number | null;
}

interface TraceRow {
  trace_id?: string;
  root_span_name?: string;
  start_time?: string;
  duration_ns?: number;
  status_code?: string;
  input_tokens?: number;
  output_tokens?: number;
  tool_call_count?: number;
  llm_call_count?: number;
  models_used?: string[];
}

interface SpanRow {
  trace_id?: string;
  span_name?: string;
  start_time?: string;
  duration_ns?: number;
  status_code?: string;
  status_message?: string;
  operation_name?: string;
  agent_name?: string;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
  response_finish_reasons?: string[] | string;
}

const NS_PER_MS = 1_000_000;
/** Default Metrics tab window for models and agents. */
export const OBSERVABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default Logs tab tail; one search page. */
export const OBSERVABILITY_LOG_LINES = 100;
/** Traces are kept for 30 days, so the Logs tab never looks further back. */
const LOG_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** `page_size` is capped at 100 on both search endpoints. */
const MAX_PAGE_SIZE = 100;

const MODEL_SERIES: SeriesSpec[] = [
  { label: "Calls", unit: "requests", measure: "span_id", aggregation: "count" },
  {
    label: "Errored calls",
    unit: "requests",
    measure: "span_id",
    aggregation: "count",
    where: "status_code = 'Error'",
  },
  {
    label: "Latency p50",
    unit: "ms",
    measure: "duration_ns",
    aggregation: "p50",
    scale: 1 / NS_PER_MS,
  },
  {
    label: "Latency p95",
    unit: "ms",
    measure: "duration_ns",
    aggregation: "p95",
    scale: 1 / NS_PER_MS,
  },
  { label: "Input tokens", unit: "tokens", measure: "usage_input_tokens", aggregation: "sum" },
  { label: "Output tokens", unit: "tokens", measure: "usage_output_tokens", aggregation: "sum" },
  {
    label: "Cached input tokens",
    unit: "tokens",
    measure: "usage_cache_read_input_tokens",
    aggregation: "sum",
  },
];

const AGENT_SERIES: SeriesSpec[] = [
  { label: "Runs", unit: "requests", measure: "trace_id", aggregation: "count" },
  {
    label: "Errored runs",
    unit: "requests",
    measure: "trace_id",
    aggregation: "count",
    where: "status_code = 'Error'",
  },
  {
    label: "Run duration p50",
    unit: "ms",
    measure: "duration_ns",
    aggregation: "p50",
    scale: 1 / NS_PER_MS,
  },
  {
    label: "Run duration p95",
    unit: "ms",
    measure: "duration_ns",
    aggregation: "p95",
    scale: 1 / NS_PER_MS,
  },
  { label: "Input tokens", unit: "tokens", measure: "input_tokens", aggregation: "sum" },
  { label: "Output tokens", unit: "tokens", measure: "output_tokens", aggregation: "sum" },
  { label: "LLM calls", unit: "count", measure: "llm_call_count", aggregation: "sum" },
  { label: "Tool calls", unit: "count", measure: "tool_call_count", aggregation: "sum" },
];

/**
 * The expression language quotes strings with single quotes and documents no
 * escape, so a quote is dropped rather than risk breaking out of the literal.
 * Model and agent ids never contain one.
 */
function literal(value: string): string {
  return `'${value.replace(/'/g, "")}'`;
}

function modelFilter(modelId: string): string {
  return `(request_model = ${literal(modelId)} OR response_model = ${literal(modelId)})`;
}

function agentFilter(agentId: string): string {
  return `agent_id = ${literal(agentId)}`;
}

function windowQuery(startMs: number, endMs: number, extra?: Record<string, string>): string {
  const params = new URLSearchParams({
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    ...extra,
  });
  return params.toString();
}

/**
 * Metric series for a model (span-level) or an agent (trace-level). Each
 * series is its own aggregate query; one that the server rejects (a measure
 * a workspace cannot aggregate, a role without Observability access) drops
 * just that series, and an organization without Observability gets an empty
 * Metrics tab rather than an error.
 */
export async function fetchObservabilitySeries(
  fetch: ObservabilityFetch,
  typeId: string,
  externalId: string,
  timeRange?: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  if (!externalId) return [];
  const endMs = timeRange?.endMs ?? Date.now();
  const startMs = timeRange?.startMs ?? endMs - OBSERVABILITY_WINDOW_MS;

  let path: string;
  let specs: SeriesSpec[];
  let filter: string;
  if (typeId === "mistral-model") {
    path = "/observability/spans/aggregate";
    specs = MODEL_SERIES;
    filter = modelFilter(externalId);
  } else if (typeId === "mistral-agent") {
    path = "/observability/traces/aggregate";
    specs = AGENT_SERIES;
    filter = agentFilter(externalId);
  } else {
    return [];
  }

  const query = windowQuery(startMs, endMs);
  const settled = await Promise.allSettled(
    specs.map(async (spec): Promise<MetricSeries | null> => {
      const body = await fetch<{ data?: AggregationRow[] }>(`${path}?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metric: { measure: spec.measure, aggregation: spec.aggregation },
          time_dimension: { granularity: "auto" },
          search_expression: spec.where ? `${filter} AND ${spec.where}` : filter,
        }),
      });
      const points: Array<{ timestamp: number; value: number }> = [];
      for (const row of body.data ?? []) {
        if (!row.time_bucket || typeof row.metric_value !== "number") continue;
        const timestamp = Date.parse(row.time_bucket);
        if (Number.isNaN(timestamp)) continue;
        points.push({ timestamp, value: row.metric_value * (spec.scale ?? 1) });
      }
      if (points.length === 0) return null;
      points.sort((a, b) => a.timestamp - b.timestamp);
      return { label: spec.label, unit: spec.unit, points };
    }),
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
}

function formatDuration(ns: number | undefined): string {
  if (typeof ns !== "number" || !Number.isFinite(ns)) return "-";
  const ms = ns / NS_PER_MS;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function statusWord(status: string | undefined): string {
  return status === "Error" ? "ERROR" : "OK";
}

function byStart<T extends { start_time?: string }>(a: T, b: T): number {
  return (Date.parse(a.start_time ?? "") || 0) - (Date.parse(b.start_time ?? "") || 0);
}

function traceLine(trace: TraceRow): string {
  const parts = [
    trace.start_time ?? "",
    statusWord(trace.status_code),
    trace.root_span_name || "trace",
    formatDuration(trace.duration_ns),
    `in=${trace.input_tokens ?? 0}`,
    `out=${trace.output_tokens ?? 0}`,
    `llm=${trace.llm_call_count ?? 0}`,
    `tools=${trace.tool_call_count ?? 0}`,
  ];
  if (trace.models_used?.length) parts.push(`models=${trace.models_used.join(",")}`);
  parts.push(`trace=${trace.trace_id ?? ""}`);
  return parts.join("  ");
}

function spanLine(span: SpanRow): string {
  const finish = Array.isArray(span.response_finish_reasons)
    ? span.response_finish_reasons.join(",")
    : (span.response_finish_reasons ?? "");
  const parts = [
    span.start_time ?? "",
    statusWord(span.status_code),
    span.span_name || span.operation_name || "call",
    formatDuration(span.duration_ns),
    `in=${span.usage_input_tokens ?? 0}`,
    `out=${span.usage_output_tokens ?? 0}`,
  ];
  if (finish) parts.push(`finish=${finish}`);
  if (span.agent_name) parts.push(`agent=${span.agent_name}`);
  if (span.status_code === "Error" && span.status_message)
    parts.push(`error=${span.status_message}`);
  parts.push(`trace=${span.trace_id ?? ""}`);
  return parts.join("  ");
}

/**
 * The Logs tab: one line per agent run (trace) or model call (span) from the
 * last 30 days, one search page of them, sorted oldest first so the tail of
 * the tab is the newest.
 */
export async function fetchObservabilityLogs(
  fetch: ObservabilityFetch,
  typeId: string,
  externalId: string,
  params: LogsFetchParams,
): Promise<LogsFetchResult> {
  const isAgent = typeId === "mistral-agent";
  const container = isAgent ? "runs" : "calls";
  if (typeId !== "mistral-agent" && typeId !== "mistral-model") {
    throw new Error(`Mistral plugin: logs are not available on "${typeId}"`);
  }
  const tail = params.tailLines && params.tailLines > 0 ? params.tailLines : MAX_PAGE_SIZE;
  const endMs = Date.now();
  const query = windowQuery(endMs - LOG_LOOKBACK_MS, endMs, {
    page_size: String(Math.min(tail, MAX_PAGE_SIZE)),
  });

  let lines: string[];
  try {
    if (isAgent) {
      const body = await fetch<{ traces?: { results?: TraceRow[] } }>(
        `/observability/traces/search?${query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ search_expression: agentFilter(externalId) }),
        },
      );
      lines = [...(body.traces?.results ?? [])].sort(byStart).map(traceLine);
    } else {
      const body = await fetch<{ spans?: { results?: SpanRow[] } }>(
        `/observability/spans/search?${query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ search_expression: modelFilter(externalId) }),
        },
      );
      lines = [...(body.spans?.results ?? [])].sort(byStart).map(spanLine);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/API error (401|403|404)\b/.test(message)) {
      return {
        text: "Mistral Observability is not available to this API key. It is in Private Preview for Enterprise organizations, and reading traces needs the Org Admin, Workspace Admin or Observability Viewer role.\n",
        containers: [container],
        activeContainer: container,
      };
    }
    throw error;
  }

  if (lines.length === 0) {
    lines = [
      isAgent
        ? "No traces for this agent in the last 30 days. Traces arrive once the application is instrumented (Mistral SDK telemetry, Workflows or OpenTelemetry)."
        : "No traced calls to this model in the last 30 days. Traces arrive once the application is instrumented (Mistral SDK telemetry, Workflows or OpenTelemetry).",
    ];
  }
  const kept = lines.slice(-tail);
  return { text: `${kept.join("\n")}\n`, containers: [container], activeContainer: container };
}
