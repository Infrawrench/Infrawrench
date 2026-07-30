/**
 * Custom graphs — a third program kind in the QuickJS isolate, after workflows
 * and Infrafiles. A graph script is read-only over the org (costs, resource
 * listings, provider metrics) plus a private key/value store and the proxied
 * `fetch`; it finishes by declaring controls and a chart, which the host
 * persists and clients render. It can create nothing and delete nothing.
 *
 * The render contract (`CustomGraphRenderSpec` and friends) lives in
 * `@infrawrench/client-core` because web, desktop, and mobile all draw it; this
 * module owns only the sandbox-facing halves: the host capability interface and
 * the marshalling limits.
 */
import type {
  CustomGraphControlState,
  CustomGraphRenderSpec,
  CustomGraphSeries,
} from "@infrawrench/client-core";

import type {
  RunLimits,
  RunLogEntry,
  WorkflowFetchRequest,
  WorkflowFetchResponse,
} from "../types.js";

/** Cost query as the sandbox may pose it, already normalized by dispatch. */
export interface GraphCostQuery {
  /** Inclusive ISO dates, resolved from `days` when the guest passed one. */
  from: string;
  to: string;
  binning: "daily" | "weekly" | "monthly" | "cumulative";
  groupBy: "none" | "provider" | "account" | "service" | "region" | "resource" | "tag";
  groupByTagKey?: string | undefined;
  filters: Array<{
    dimension: "provider" | "account" | "service" | "region" | "resource" | "tag";
    op: "in" | "not_in";
    values: string[];
    tagKey?: string | undefined;
  }>;
  topN: number;
}

/** Chart-ready cost result the guest receives from `graph.costs.query`. */
export interface GraphCostResult {
  /** Pass-through-ready for graph.render; currency rides along per series. */
  series: Array<CustomGraphSeries & { currency?: string }>;
  /** Period total per currency. */
  totals: Record<string, number>;
  currencies: string[];
}

export interface GraphResourceFilter {
  pluginId?: string | undefined;
  resourceTypeId?: string | undefined;
  accountId?: string | undefined;
  /** Case-insensitive substring over display name. */
  search?: string | undefined;
}

/** Lite resource row for populating a graph's own pickers. */
export interface GraphResourceInfo {
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string;
}

/** One provider metric series, as `graph.metrics(resourceId)` returns it. */
export interface GraphMetricSeries {
  label: string;
  unit?: string | undefined;
  points: Array<{ timestamp: number; value: number }>;
}

/**
 * Host capabilities behind a graph run. Deliberately NOT a `WorkflowHost` —
 * a graph must not inherit create/update/delete, SSH, or storage powers, so it
 * gets its own narrow interface and its own dispatcher.
 *
 * Every method operates within the org scope the host established; the
 * sandbox can never name an org.
 */
export interface GraphHost {
  /** Org-scoped cost query (ClickHouse on the cloud). */
  queryCosts(query: GraphCostQuery): Promise<GraphCostResult>;
  /** List org resources for the graph's own pickers. Read-only, capped. */
  listResources(filter: GraphResourceFilter): Promise<GraphResourceInfo[]>;
  /** Provider metric series for one org resource. */
  metricSeries(
    resourceId: string,
    range: { startMs: number; endMs: number },
  ): Promise<GraphMetricSeries[]>;

  /** Per-graph key/value store. Values are JSON, capped by the dispatcher. */
  dataGet(key: string): Promise<unknown>;
  dataSet(key: string, value: unknown): Promise<void>;
  dataDelete(key: string): Promise<void>;
  dataList(): Promise<string[]>;

  /**
   * Outbound HTTP, same shape and validation as the workflow `fetch` — cloud
   * hosts send it through the egress proxy. Optional: a host without it makes
   * `fetch()` in graph code throw a clear capability error.
   */
  fetch?(request: WorkflowFetchRequest): Promise<WorkflowFetchResponse>;
}

export interface RunGraphOptions {
  /** The graph's TypeScript source. */
  source: string;
  host: GraphHost;
  /** Current control values, as the client last chose them. */
  controls?: CustomGraphControlState;
  /** Id of the declared button that was pressed, when the run is a press. */
  button?: string;
  /**
   * What started this run, surfaced to the script as `graph.event.kind`:
   * a refreshSeconds tick ("refresh"), a control change ("interaction"), or
   * anything else ("manual", the default). A button press always reports
   * "interaction" regardless.
   */
  trigger?: "manual" | "refresh" | "interaction";
  limits?: Partial<RunLimits>;
  onLog?: (entry: RunLogEntry) => void;
  signal?: AbortSignal;
}

export interface GraphRunResult {
  status: "success" | "failure";
  /** Present iff the run succeeded — a graph that never rendered failed. */
  spec?: CustomGraphRenderSpec;
  error?: { message: string; stack?: string };
  logs: RunLogEntry[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/**
 * A render should be interactive-fast, not a five-minute automation: the graph
 * card blocks on it. `fetch` counts against the budget (as in workflows), so a
 * slow upstream fails the render rather than hanging the dashboard.
 */
export const GRAPH_RUN_LIMITS: RunLimits = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
};

/* ------------------------------------------------------------------ *
 * Marshalling limits, enforced in the graph dispatcher so every host
 * receives identical, pre-checked requests.
 * ------------------------------------------------------------------ */

/** Host-call budget per run, by capability. */
export const GRAPH_MAX_COST_QUERIES = 10;
export const GRAPH_MAX_METRIC_QUERIES = 20;
export const GRAPH_MAX_RESOURCE_LISTS = 10;
export const GRAPH_MAX_DATA_OPS = 100;
export const GRAPH_MAX_FETCHES = 25;
export const GRAPH_MAX_LOGS = 200;

/** Cost query bounds. */
export const GRAPH_MAX_QUERY_DAYS = 1100;
export const GRAPH_MAX_TOP_N = 25;
export const GRAPH_MAX_FILTERS = 10;
export const GRAPH_MAX_FILTER_VALUES = 50;

/** Metric query bounds. */
export const GRAPH_MAX_METRIC_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Key/value store bounds. */
export const GRAPH_MAX_DATA_KEY_LENGTH = 200;
export const GRAPH_MAX_DATA_VALUE_BYTES = 64 * 1024;

/** Render-spec bounds. */
export const GRAPH_MAX_CONTROLS = 20;
export const GRAPH_MAX_SELECT_OPTIONS = 100;
export const GRAPH_MAX_SERIES = 30;
export const GRAPH_MAX_POINTS_PER_SERIES = 2000;
export const GRAPH_MAX_TOTAL_POINTS = 20_000;
export const GRAPH_MAX_PIE_SLICES = 50;
export const GRAPH_MAX_TABLE_COLUMNS = 12;
export const GRAPH_MAX_TABLE_ROWS = 200;
export const GRAPH_MAX_TEXT = 200;
export const GRAPH_MAX_NOTICE = 500;
