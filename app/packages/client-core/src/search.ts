import type { CloudFetch } from "./fetch";
import type { Service } from "./services";

/**
 * The saved objects the command palette indexes besides resources and
 * workflows. Each is something a member opens by name: a report, a dashboard,
 * a budget, a runbook. The server answers each kind only for callers whose
 * role can read it, and only with the objects that caller could open (per
 * object sharing for reports, folders, dashboards and canvases; cost
 * visibility for budgets), so a hit is never a dead end.
 *
 * Adding a kind: append it here, give it labels below, a loader in
 * `web/src/services/palette-search.ts`, a target in
 * `ui/src/command-palette/kinds.ts`, and a web URL in `deep-links.ts`.
 */
export const SEARCH_OBJECT_KINDS = [
  "cost_report",
  "cost_report_folder",
  "dashboard",
  "budget",
  "cost_canvas",
  "saved_cost_filter",
  "virtual_tag",
  "business_metric",
  "scenario_model",
  "slo",
  "service",
  "runbook",
  "status_page",
  "probe",
  "log_query",
  "query_monitor",
] as const;

export type SearchObjectKind = (typeof SEARCH_OBJECT_KINDS)[number];

/** Every kind of `/search` hit. Resources and workflows are the originals. */
export const SEARCH_RESULT_KINDS = ["resource", "workflow", ...SEARCH_OBJECT_KINDS] as const;

export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

export function isSearchResultKind(value: unknown): value is SearchResultKind {
  return typeof value === "string" && (SEARCH_RESULT_KINDS as readonly string[]).includes(value);
}

export function isSearchObjectKind(value: unknown): value is SearchObjectKind {
  return typeof value === "string" && (SEARCH_OBJECT_KINDS as readonly string[]).includes(value);
}

/**
 * English labels for each kind, for surfaces without a translation layer (the
 * server's `resourceTypeLabel`, the CLI, the editor extensions). The web and
 * desktop palettes translate their own copies.
 */
export const SEARCH_KIND_LABELS: Record<SearchResultKind, { singular: string; plural: string }> = {
  resource: { singular: "Resource", plural: "Resources" },
  workflow: { singular: "Workflow", plural: "Workflows" },
  cost_report: { singular: "Cost report", plural: "Cost reports" },
  cost_report_folder: { singular: "Report folder", plural: "Report folders" },
  dashboard: { singular: "Dashboard", plural: "Dashboards" },
  budget: { singular: "Budget", plural: "Budgets" },
  cost_canvas: { singular: "Canvas", plural: "Canvases" },
  saved_cost_filter: { singular: "Saved filter", plural: "Saved filters" },
  virtual_tag: { singular: "Virtual tag", plural: "Virtual tags" },
  business_metric: { singular: "Business metric", plural: "Business metrics" },
  scenario_model: { singular: "Scenario model", plural: "Scenario models" },
  slo: { singular: "SLO", plural: "SLOs" },
  service: { singular: "Service", plural: "Services" },
  runbook: { singular: "Runbook", plural: "Runbooks" },
  status_page: { singular: "Status page", plural: "Status pages" },
  probe: { singular: "Probe", plural: "Probes" },
  log_query: { singular: "Saved log query", plural: "Saved log queries" },
  query_monitor: { singular: "Query monitor", plural: "Query monitors" },
};

/**
 * The spotlight search contract (`GET /api/org/:orgId/search?q=`): resources
 * across every account, plus workflows under the `__workflows__` pseudo
 * plugin. At most 50 resources come back; the match is a case-insensitive
 * substring over the name, account, provider and type label.
 *
 * With `kinds=` the same route also answers saved objects (see
 * {@link SEARCH_OBJECT_KINDS}), ranked by the shared fuzzy matcher. Those hits
 * carry `kind`, `pluginId` {@link SEARCH_OBJECT_PLUGIN_ID} and the kind as
 * `resourceTypeId`, so a client that predates them never receives one: they
 * only come back when asked for by name.
 */
export interface SearchResult {
  id: string;
  /**
   * What the hit is. Present on every hit from a server that knows kinds;
   * read it through {@link searchResultKind}, which fills it in for older ones.
   */
  kind?: SearchResultKind | undefined;
  pluginId: string;
  pluginDisplayName: string;
  /** Inline SVG markup for the provider logo. Empty for saved objects. */
  pluginLogoSvg: string;
  resourceTypeId: string;
  resourceTypeLabel: string;
  /** Empty for workflows and saved objects. */
  accountId: string;
  accountName: string;
  displayName: string;
  subtitle?: string | undefined;
}

/** Workflows ride the resource search under this pseudo plugin id. */
export const SEARCH_WORKFLOW_PLUGIN_ID = "__workflows__";

/** Saved objects (reports, dashboards, SLOs, …) ride under this one. */
export const SEARCH_OBJECT_PLUGIN_ID = "__objects__";

export function isWorkflowSearchResult(r: Pick<SearchResult, "pluginId">): boolean {
  return r.pluginId === SEARCH_WORKFLOW_PLUGIN_ID;
}

/** The hit's kind, inferred for hits from a server that predates `kind`. */
export function searchResultKind(
  r: Pick<SearchResult, "kind" | "pluginId" | "resourceTypeId">,
): SearchResultKind {
  if (r.kind) return r.kind;
  if (r.pluginId === SEARCH_WORKFLOW_PLUGIN_ID) return "workflow";
  if (r.pluginId === SEARCH_OBJECT_PLUGIN_ID && isSearchObjectKind(r.resourceTypeId)) {
    return r.resourceTypeId;
  }
  return "resource";
}

/**
 * What the editor extensions ask `/search` for: everything except services,
 * which they list from `/services` themselves (with tier, owners and on-call
 * the search hit does not carry).
 */
export const EDITOR_SEARCH_KINDS: readonly SearchResultKind[] = SEARCH_RESULT_KINDS.filter(
  (k) => k !== "service",
);

/** Saved-object hits (not resources or workflows), in the order they came. */
export function objectSearchResults(
  results: readonly SearchResult[],
): (SearchResult & { kind: SearchObjectKind })[] {
  const out: (SearchResult & { kind: SearchObjectKind })[] = [];
  for (const r of results) {
    const kind = searchResultKind(r);
    if (isSearchObjectKind(kind)) out.push({ ...r, kind });
  }
  return out;
}

export interface SearchOrgOptions {
  /**
   * Which kinds to answer. Omitted means the original contract (resources
   * and workflows); `"all"` means every kind the caller may read.
   */
  kinds?: readonly SearchResultKind[] | "all" | undefined;
}

/** The query string for `GET /search`. */
export function searchQueryString(query: string, options?: SearchOrgOptions): string {
  const params = new URLSearchParams({ q: query.trim() });
  const kinds = options?.kinds;
  if (kinds === "all") params.set("kinds", "all");
  else if (kinds && kinds.length > 0) params.set("kinds", kinds.join(","));
  return params.toString();
}

export async function searchOrg(
  api: CloudFetch,
  orgId: string,
  query: string,
  init?: RequestInit,
  options?: SearchOrgOptions,
): Promise<SearchResult[]> {
  return (
    (await api.org<SearchResult[]>(orgId, `/search?${searchQueryString(query, options)}`, init)) ??
    []
  );
}

/**
 * Services matching a query, by name, slug, owning team or description. The
 * search endpoint does not index services, so clients filter the (small)
 * service list themselves; an empty query returns them all.
 */
export function filterServices(services: readonly Service[], query: string): Service[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...services];
  return services.filter((s) =>
    [s.name, s.slug, s.ownerTeam ?? "", s.description ?? ""].some((v) =>
      v.toLowerCase().includes(q),
    ),
  );
}

/* ------------------------------ starred items ----------------------------- */

/** How many items one member may star in one org. */
export const MAX_STARRED_ITEMS = 200;

/**
 * One starred object, as `GET /starred` returns it: the same shape as a search
 * hit (resolved fresh, so a rename shows), plus when it was starred. Stars on
 * objects the member can no longer open (deleted, unshared, outside a new cost
 * visibility scope) are left out of the listing rather than deleted, so access
 * coming back brings the star back too.
 */
export interface StarredItem extends SearchResult {
  kind: SearchResultKind;
  /** ISO timestamp. */
  starredAt: string;
}

export interface StarredListResponse {
  items: StarredItem[];
}

/** The identity of a starrable object: what `PUT /starred/{kind}/{id}` takes. */
export interface StarRef {
  kind: SearchResultKind;
  id: string;
}

/** A stable map key for a star. */
export function starKey(ref: StarRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** The org-relative path of one star. */
export function starPath(ref: StarRef): string {
  return `/starred/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.id)}`;
}

export async function listStarred(
  api: CloudFetch,
  orgId: string,
  init?: RequestInit,
): Promise<StarredItem[]> {
  return (await api.org<StarredListResponse>(orgId, "/starred", init))?.items ?? [];
}

export async function starObject(api: CloudFetch, orgId: string, ref: StarRef): Promise<void> {
  await api.org(orgId, starPath(ref), { method: "PUT" });
}

export async function unstarObject(api: CloudFetch, orgId: string, ref: StarRef): Promise<void> {
  await api.org(orgId, starPath(ref), { method: "DELETE" });
}
