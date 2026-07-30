import type {
  CustomGraphDetail,
  CustomGraphRenderRequest,
  CustomGraphRenderResult,
  CustomGraphSummary,
} from "@infrawrench/client-core";

/**
 * The custom-graph contract lives in client-core so mobile (which doesn't
 * depend on this package) shares one definition; re-exported for web/desktop.
 */
export type {
  CustomGraphSummary,
  CustomGraphDetail,
  CustomGraphControl,
  CustomGraphControlState,
  CustomGraphChart,
  CustomGraphRenderSpec,
  CustomGraphRenderRequest,
  CustomGraphRenderResult,
  CustomGraphWidgetConfig,
} from "@infrawrench/client-core";

/** One typecheck diagnostic, as POST /custom-graphs/check returns it. */
export interface CustomGraphDiagnostic {
  line: number;
  column: number;
  code: number;
  category: string;
  message: string;
}

export interface CustomGraphCheckResult {
  diagnostics: CustomGraphDiagnostic[];
  hasErrors: boolean;
  degraded: boolean;
}

/**
 * Host-injected data access for the custom-graph components. Web wraps
 * `apiFetch`; desktop (cloud mode) wraps its cloud-api helpers — the
 * components stay platform-agnostic.
 */
export interface CustomGraphsClient {
  list(): Promise<CustomGraphSummary[]>;
  get(graphId: string): Promise<CustomGraphDetail>;
  render(graphId: string, request: CustomGraphRenderRequest): Promise<CustomGraphRenderResult>;
  /** Absent on read-only hosts — editors hide their affordances. */
  create?(body: {
    name: string;
    description?: string;
    source?: string;
  }): Promise<CustomGraphDetail>;
  update?(
    graphId: string,
    body: { name?: string; description?: string; source?: string },
  ): Promise<CustomGraphDetail>;
  remove?(graphId: string): Promise<void>;
  check?(source: string): Promise<CustomGraphCheckResult>;
  typings?(): Promise<string>;
}
