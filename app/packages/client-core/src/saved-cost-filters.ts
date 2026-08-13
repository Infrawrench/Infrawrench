/**
 * Saved cost filters — a named, reusable `CostFilter[]`.
 *
 * The same filter ("prod only", "team platform's accounts") otherwise gets
 * rebuilt by hand in every cost graph, report and budget. A saved filter makes
 * it one object: configs reference it **by id**, and the server resolves the
 * id at query time — so editing "prod only" once changes every graph, report
 * and budget that references it. Nothing ever copies the rows at pick time;
 * copying would fossilise the filter and defeat the object.
 *
 * Two consequences of resolve-at-query-time are contractual, not incidental:
 *
 * - A referenced filter that fails to resolve (deleted through a race, corrupt)
 *   is an **error, never a fallback to unfiltered** — an unfiltered total
 *   silently standing in for "prod only" is the one failure this feature must
 *   never produce, because it would un-scope a budget and could fire or
 *   suppress its alerts.
 * - Deleting a saved filter that is still referenced is refused (HTTP 409,
 *   body listing the referents), for the same reason from the other side.
 *
 * The stored form is the structured `CostFilter[]`; the query-language text
 * (`cost-query-language.ts`) is derived from it and always derivable — input
 * validation refuses the one filter shape the language cannot express (a tag
 * filter with no key). The API accepts either spelling on write, exactly like
 * `POST /costs/query`: `filters` or `query`, never both.
 *
 * Types live here rather than in `@infrawrench/ui` because mobile doesn't
 * depend on that package; `ui/src/cost/config.ts` holds the zod schema and
 * proves at compile time that it parses to exactly these shapes.
 */

import { CostQueryFormatError, formatCostQuery, parseCostQuery } from "./cost-query-language";
import type { CostFilter } from "./costs";
import { CloudApiError, type CloudFetch } from "./fetch";

/** Bounds the API enforces on saved filter names and descriptions. */
export const SAVED_COST_FILTER_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  /** More terms than this is a generated blob, not a filter a human reuses. */
  maxFilters: 50,
} as const;

/**
 * Create/update payload (POST/PUT /saved-cost-filters).
 *
 * `filters` and `query` are two spellings of the same thing, mirroring
 * `CostQueryRequest`: send one or the other. Sending both (a query alongside a
 * non-empty `filters`) is rejected rather than resolved by a precedence rule,
 * and an *empty* filter is rejected outright — a saved filter that matches
 * everything is indistinguishable from no filter, and applying it would only
 * ever be a mistake wearing a name.
 */
export interface SavedCostFilterInput {
  name: string;
  /** Free text shown under the name in the list; absent is no description. */
  description?: string | undefined;
  /** The structured filter. May be empty only when `query` is sent instead. */
  filters: CostFilter[];
  /** The same filter in cost query language text — an alternative to `filters`. */
  query?: string | undefined;
}

/** A saved filter as returned by the API. */
export interface SavedCostFilter {
  id: string;
  name: string;
  description: string | null;
  filters: CostFilter[];
  /**
   * The canonical query-language rendering of `filters`
   * (`formatCostQuery(filters)`), derived server-side so every surface shows
   * the same one-line spelling without re-deriving it.
   */
  query: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What kind of object references a saved filter. */
export type SavedCostFilterReferentKind = "budget" | "cost_report" | "cost_graph_widget";

/**
 * One object still pointing at a saved filter — what a refused DELETE lists,
 * and what `GET /saved-cost-filters/:id/referents` answers with.
 */
export interface SavedCostFilterReferent {
  kind: SavedCostFilterReferentKind;
  /** Budget id, report id, or dashboard-widget id. */
  id: string;
  /** Budget name, report name, or the widget's title. */
  name: string;
  /** Set for `cost_graph_widget` referents — where the card lives. */
  dashboardId?: string | undefined;
  dashboardName?: string | undefined;
}

/**
 * Resolve an input's two spellings to the one stored `CostFilter[]`.
 *
 * The rules, shared by every write path (HTTP route, and any future tool):
 *
 * - `query` and a non-empty `filters` together are an error — same stance as
 *   `POST /costs/query`, and for the same reason: two filters were expressed
 *   and silently running one of them answers a different question.
 * - The result must be non-empty. An empty saved filter matches everything;
 *   naming it "prod only" and applying it anywhere would widen scope without
 *   any surface saying so.
 * - Every tag term must carry its key, so the stored filter is always
 *   expressible in query text (`formatCostQuery` round-trips it). This is
 *   checked by *rendering* the filter, which is also what guarantees the
 *   round-trip rather than approximating it.
 *
 * @throws {Error} with a caller-presentable message (including
 * `CostQueryParseError` for bad query text, whose offset survives).
 */
export function resolveSavedCostFilterInput(input: SavedCostFilterInput): CostFilter[] {
  const text = input.query?.trim();
  let filters: CostFilter[];
  if (text) {
    if (input.filters.length > 0) {
      throw new Error(
        "Send either `filters` or `query`, not both — they are two spellings of the same filter.",
      );
    }
    filters = parseCostQuery(text);
  } else {
    // Rows with no values are what a half-finished editor row looks like; the
    // editors drop them before saving, and so does the API.
    filters = input.filters.filter((f) => f.values.length > 0);
  }
  if (filters.length === 0) {
    throw new Error(
      "A saved filter needs at least one term — an empty filter matches everything, " +
        "which is the same as applying no filter at all.",
    );
  }
  try {
    // Rendering is the proof of expressibility: the one inexpressible shape
    // (a tag term with no key) throws here, before it can be stored.
    formatCostQuery(filters);
  } catch (e) {
    if (e instanceof CostQueryFormatError) {
      throw new Error(`${e.message} (term ${e.index + 1})`);
    }
    throw e;
  }
  return filters;
}

/** "Budget \"prod\", report \"AWS spend\"" — how a refusal names referents. */
export function describeSavedCostFilterReferents(referents: SavedCostFilterReferent[]): string {
  const label: Record<SavedCostFilterReferentKind, string> = {
    budget: "budget",
    cost_report: "report",
    cost_graph_widget: "dashboard graph",
  };
  return referents
    .map((r) => {
      const where = r.dashboardName ? ` on ${r.dashboardName}` : "";
      return `${label[r.kind]} "${r.name}"${where}`;
    })
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * Fetch helpers — used by mobile (the web and desktop hosts go through
 * their own transports, like the rest of the cost surface).
 * ------------------------------------------------------------------ */

/** The org's saved filters (`GET /saved-cost-filters`, `costs:read`). */
export async function listSavedCostFilters(
  api: CloudFetch,
  orgId: string,
): Promise<SavedCostFilter[]> {
  return (await api.org<SavedCostFilter[]>(orgId, "/saved-cost-filters")) ?? [];
}

/**
 * One saved filter by id, or null when the server says it doesn't exist —
 * which a caller must surface as "this reference is broken", never render as
 * "no filter".
 */
export async function getSavedCostFilter(
  api: CloudFetch,
  orgId: string,
  savedFilterId: string,
): Promise<SavedCostFilter | null> {
  try {
    return await api.org<SavedCostFilter>(
      orgId,
      `/saved-cost-filters/${encodeURIComponent(savedFilterId)}`,
    );
  } catch (error) {
    // Only a 404 is "no such filter". Network, auth, and 5xx failures
    // propagate so callers show an error state instead of a broken reference.
    if (error instanceof CloudApiError && error.status === 404) return null;
    throw error;
  }
}
