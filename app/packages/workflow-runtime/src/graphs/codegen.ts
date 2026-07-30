/**
 * The ambient `graph.d.ts` for custom-graph scripts. Unlike the workflow
 * `infra.d.ts` it is static — a graph's surface doesn't depend on the org's
 * connected accounts — so one string serves the Monaco editor, the headless
 * typecheck, and the MCP typings tool alike. Its shape must mirror
 * `graphs/prelude.ts` exactly.
 */
export function generateGraphDts(): string {
  return GRAPH_DTS;
}

const GRAPH_DTS = `/**
 * Custom-graph runtime API.
 *
 * A graph script runs server-side in a sandbox, gathers data, declares its
 * interactive controls, and calls graph.render(...) exactly once to describe
 * what to draw. Control values chosen by the viewer are passed back into the
 * next run, so reading a control returns the current choice.
 */

/** One option in a select control. */
interface GraphSelectOption {
  value: string;
  label: string;
}

interface GraphControls {
  /**
   * Declare a dropdown and return its current value (the viewer's choice,
   * else the default, else the first option). Synchronous — no await needed.
   */
  select(
    id: string,
    opts: {
      label?: string;
      options: Array<string | GraphSelectOption>;
      default?: string;
    },
  ): string;
  /** Declare a checkbox and return its current value. */
  checkbox(id: string, opts?: { label?: string; default?: boolean }): boolean;
  /** Declare a free-text input and return its current value. */
  text(id: string, opts?: { label?: string; default?: string; placeholder?: string }): string;
  /** Declare a numeric input and return its current value (clamped to min/max). */
  number(
    id: string,
    opts?: { label?: string; default?: number; min?: number; max?: number; step?: number },
  ): number;
  /**
   * Declare a button. Returns true when THIS run was started by pressing it —
   * use that to perform the button's action (reset a baseline, clear a cache).
   */
  button(id: string, opts?: { label?: string; danger?: boolean }): boolean;
}

interface GraphCostQueryOptions {
  /** Trailing window in days (default 30, max 1100). Ignored when from/to are set. */
  days?: number;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Bucket size (default "daily"). "cumulative" is a running total. */
  binning?: "daily" | "weekly" | "monthly" | "cumulative";
  /** Split spend into one series per value of this dimension. */
  groupBy?: "none" | "provider" | "account" | "service" | "region" | "resource" | "tag";
  /** Required when groupBy is "tag". */
  groupByTagKey?: string;
  filters?: Array<{
    dimension: "provider" | "account" | "service" | "region" | "resource" | "tag";
    op?: "in" | "not_in";
    values: string[];
    /** Required when dimension is "tag". */
    tagKey?: string;
  }>;
  /** Keep the top N series and fold the rest into "Other" (default 10, max 25). */
  topN?: number;
}

interface GraphSeriesPoint {
  x: string | number;
  y: number | null;
}

interface GraphCostSeries {
  key: string;
  label?: string;
  currency?: string;
  /** Chart-ready: pass straight to graph.render as a series. */
  points: GraphSeriesPoint[];
}

interface GraphCostResult {
  series: GraphCostSeries[];
  /** Period total per currency code. */
  totals: Record<string, number>;
  currencies: string[];
}

interface GraphResourceInfo {
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string;
}

interface GraphMetricSeries {
  label: string;
  unit?: string;
  points: Array<{ timestamp: number; value: number }>;
}

interface GraphChartSeries {
  key: string;
  label?: string;
  /** Hex (#rrggbb) or a plain color name; omitted series use the palette. */
  color?: string;
  points: GraphSeriesPoint[];
}

interface GraphAxis {
  label?: string;
  /** Unit suffix for ticks and tooltips ("ms", "GB", "%"). */
  unit?: string;
  /** Currency code — formats values as money instead. */
  currency?: string;
}

type GraphChart =
  | {
      type: "line" | "area" | "stacked_bar" | "multi_bar";
      series: GraphChartSeries[];
      xAxis?: GraphAxis;
      yAxis?: GraphAxis;
    }
  | {
      type: "pie";
      slices: Array<{ label: string; value: number; color?: string }>;
      unit?: string;
      currency?: string;
    }
  | {
      type: "stat";
      value: number | string;
      unit?: string;
      currency?: string;
      /** Small secondary line, e.g. "+12% vs last week". */
      caption?: string;
    }
  | {
      type: "table";
      columns: string[];
      rows: Array<Array<string | number | null>>;
    };

interface GraphRenderSpec {
  title?: string;
  chart: GraphChart;
  /** Re-run automatically after this many seconds (min 30, max 86400). */
  refreshSeconds?: number;
  /** Informational line shown under the chart. */
  notice?: string;
}

interface GraphData {
  /** Read a stored value (null when the key was never set). */
  get(key: string): Promise<unknown>;
  /** Store a JSON-serializable value (64 KiB max) under this graph. */
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys this graph has stored. */
  list(): Promise<string[]>;
}

interface Graph {
  controls: GraphControls;
  /** What started this run; button is set when a declared button was pressed. */
  event: { kind: "manual" | "refresh" | "interaction"; button?: string };
  costs: {
    /** Query the organization's collected spend (same data as cost graphs). */
    query(opts?: GraphCostQueryOptions): Promise<GraphCostResult>;
  };
  resources: {
    /** List the organization's resources, e.g. to build a picker. */
    list(filter?: {
      pluginId?: string;
      resourceTypeId?: string;
      accountId?: string;
      /** Case-insensitive substring over display names. */
      search?: string;
    }): Promise<GraphResourceInfo[]>;
  };
  /** Provider metric series (CPU, bandwidth, …) for one resource. */
  metrics(
    resourceId: string,
    opts?: { hours?: number; startMs?: number; endMs?: number },
  ): Promise<GraphMetricSeries[]>;
  /** Private key/value store persisted between runs of this graph. */
  data: GraphData;
  /** Describe what to draw. Call exactly once; the last call wins. */
  render(spec: GraphRenderSpec): void;
  /** Append a line to the run log (visible in the editor). */
  log(...parts: unknown[]): void;
}

declare const graph: Graph;

interface GraphFetchInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  /** Strings and bytes pass through; anything else is sent as JSON. */
  body?: string | Uint8Array | ArrayBuffer | object;
  /** Per-request timeout in ms (default 30000, max 120000). */
  timeoutMs?: number;
  /** Response size cap in bytes (default 5 MiB, max 10 MiB). */
  maxBytes?: number;
  redirect?: "follow" | "manual";
}

interface GraphFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: {
    get(name: string): string | null;
    has(name: string): boolean;
    keys(): string[];
    entries(): Array<[string, string]>;
    forEach(fn: (value: string, key: string) => void): void;
  };
  text(): Promise<string>;
  json(): Promise<any>;
  bytes(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** HTTP from the graph. Runs through Infrawrench's egress proxy on the cloud. */
declare function fetch(url: string, init?: GraphFetchInit): Promise<GraphFetchResponse>;

declare const console: {
  log(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
  debug(...parts: unknown[]): void;
};
`;
