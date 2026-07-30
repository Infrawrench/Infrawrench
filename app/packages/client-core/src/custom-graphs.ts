/**
 * The custom-graph contract, shared by every client that renders one: the
 * control the script declares, the chart spec a run returns, the request/
 * response of `POST /custom-graphs/:id/render`, and the widget config a
 * dashboard stores.
 *
 * A custom graph is org-authored JavaScript/TypeScript run in the server-side
 * QuickJS sandbox (the workflow isolate). The script declares its own controls
 * (selects, checkboxes, buttons, inputs), queries org cost data, reads
 * resource metrics, fetches external APIs, keeps its own key/value data — and
 * finishes by describing what to draw. Clients never execute graph code; they
 * render the returned spec and post control changes back for a re-run.
 *
 * Types live here rather than in `@infrawrench/ui` because mobile renders the
 * same widgets and doesn't depend on that package — `ui/src/custom-graphs/
 * config.ts` keeps the zod schemas (the API and the sandbox boundary validate
 * against them) and re-exports these types, exactly like the cost contract.
 */

/* ------------------------------------------------------------------ *
 * Controls — the script declares them each run; clients render them in
 * declaration order and post the values back on the next render.
 * ------------------------------------------------------------------ */

export interface CustomGraphSelectOption {
  value: string;
  label: string;
}

export type CustomGraphControl =
  | {
      kind: "select";
      id: string;
      label: string;
      options: CustomGraphSelectOption[];
      /** Current value as resolved by the script this run. */
      value: string;
    }
  | { kind: "checkbox"; id: string; label: string; value: boolean }
  | {
      kind: "button";
      id: string;
      label: string;
      /** Renders in the destructive style and asks for a confirm tap. */
      danger?: boolean | undefined;
    }
  | {
      kind: "text";
      id: string;
      label: string;
      value: string;
      placeholder?: string | undefined;
    }
  | {
      kind: "number";
      id: string;
      label: string;
      value: number;
      min?: number | undefined;
      max?: number | undefined;
      step?: number | undefined;
    };

export type CustomGraphControlKind = CustomGraphControl["kind"];

/** Values the client sends back: control id → last chosen value. */
export type CustomGraphControlState = Record<string, string | number | boolean>;

/* ------------------------------------------------------------------ *
 * Chart spec — what a run says to draw.
 * ------------------------------------------------------------------ */

export const CUSTOM_GRAPH_CHART_TYPES = [
  "line",
  "area",
  "stacked_bar",
  "multi_bar",
  "pie",
  "stat",
  "table",
] as const;
export type CustomGraphChartType = (typeof CUSTOM_GRAPH_CHART_TYPES)[number];

export interface CustomGraphPoint {
  /** Category label, ISO date ("2026-07-30"), or number. */
  x: string | number;
  /** null renders a gap rather than a zero. */
  y: number | null;
}

export interface CustomGraphSeries {
  key: string;
  label?: string | undefined;
  /** CSS color; omitted series take the shared categorical palette in order. */
  color?: string | undefined;
  points: CustomGraphPoint[];
}

export interface CustomGraphAxis {
  label?: string | undefined;
  /**
   * Formats tick and tooltip values: a currency code renders money, a plain
   * unit ("ms", "GB", "%") is suffixed.
   */
  unit?: string | undefined;
  currency?: string | undefined;
}

export type CustomGraphChart =
  | {
      type: "line" | "area" | "stacked_bar" | "multi_bar";
      series: CustomGraphSeries[];
      xAxis?: CustomGraphAxis | undefined;
      yAxis?: CustomGraphAxis | undefined;
    }
  | {
      type: "pie";
      /** One slice per entry. */
      slices: Array<{ label: string; value: number; color?: string | undefined }>;
      unit?: string | undefined;
      currency?: string | undefined;
    }
  | {
      type: "stat";
      value: number | string;
      unit?: string | undefined;
      currency?: string | undefined;
      /** Small secondary line, e.g. "+12% vs last week". */
      caption?: string | undefined;
    }
  | {
      type: "table";
      columns: string[];
      rows: Array<Array<string | number | null>>;
    };

/* ------------------------------------------------------------------ *
 * Render envelope — the whole result of one sandbox run.
 * ------------------------------------------------------------------ */

/** Floor for script-requested refresh, enforced server-side. */
export const CUSTOM_GRAPH_MIN_REFRESH_SECONDS = 30;
/** A spec with no refreshSeconds re-renders only on control changes. */
export const CUSTOM_GRAPH_MAX_REFRESH_SECONDS = 24 * 60 * 60;

export interface CustomGraphRenderSpec {
  version: 1;
  title?: string | undefined;
  chart: CustomGraphChart;
  controls: CustomGraphControl[];
  /**
   * How long this render stays fresh. Clamped to
   * [CUSTOM_GRAPH_MIN_REFRESH_SECONDS, CUSTOM_GRAPH_MAX_REFRESH_SECONDS];
   * absent means no automatic refresh.
   */
  refreshSeconds?: number | undefined;
  /** Informational line rendered under the chart (e.g. data caveats). */
  notice?: string | undefined;
}

export interface CustomGraphRenderRequest {
  /** Current control values; omitted ids fall back to script defaults. */
  controls?: CustomGraphControlState | undefined;
  /** Set when a declared button was pressed; the script sees it as the event. */
  button?: string | undefined;
  /**
   * What started this run, surfaced as `graph.event.kind`: a refreshSeconds
   * tick ("refresh"), a control change ("interaction"), else "manual". A
   * button press always reports "interaction".
   */
  trigger?: "manual" | "refresh" | "interaction" | undefined;
}

export interface CustomGraphRenderResult {
  ok: boolean;
  spec: CustomGraphRenderSpec | null;
  /** Script error message when ok is false. */
  error: string | null;
  /** infra-style log lines emitted during the run, capped server-side. */
  logs: Array<{ level: "info" | "warn" | "error"; message: string }>;
  renderedAt: string;
  /** Wall-clock run duration, for the editor's footer. */
  durationMs: number;
}

/* ------------------------------------------------------------------ *
 * Graph rows and widget config.
 * ------------------------------------------------------------------ */

export interface CustomGraphSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomGraphDetail extends CustomGraphSummary {
  source: string;
}

/** A dashboard card pointing at a custom graph by id. */
export interface CustomGraphWidgetConfig {
  version: 1;
  graphId: string;
}

export const DEFAULT_CUSTOM_GRAPH_SOURCE = `// A custom graph: query data, declare controls, and render.
const range = graph.controls.select("range", {
  label: "Range",
  options: [
    { value: "7", label: "Last 7 days" },
    { value: "30", label: "Last 30 days" },
  ],
  default: "30",
});

const costs = await graph.costs.query({
  days: Number(range),
  groupBy: "provider",
});

graph.render({
  title: "Spend by provider",
  chart: { type: "stacked_bar", series: costs.series },
  refreshSeconds: 3600,
});
`;
