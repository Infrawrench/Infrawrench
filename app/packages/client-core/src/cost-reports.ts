/**
 * Cost reports — a named, addressable saved cost graph.
 *
 * A `cost_graph` dashboard widget stores its whole {@link CostGraphConfig}
 * inline: it belongs to one card on one dashboard, and there is no object to
 * link to, schedule, annotate or file away. A cost *report* is that object. It
 * owns the config, lives at its own URL, and dashboards reference it by id —
 * so one report can appear on many dashboards and editing it updates all of
 * them at once.
 *
 * The ad-hoc `cost_graph` widget stays exactly as it was: a one-off card should
 * not force anyone to name and file a report first.
 *
 * These types live in `@infrawrench/client-core` rather than `@infrawrench/ui`
 * because mobile doesn't depend on that package. `ui/src/cost/config.ts` holds
 * the zod schemas the API validates against and proves, at compile time, that
 * they still parse to exactly these shapes.
 */

import type { CostGraphConfig, CostQueryResponse } from "./costs";

/** Bounds the API enforces on report names and descriptions. */
export const COST_REPORT_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
} as const;

/**
 * Create/update payload for a report (POST/PUT /cost-reports).
 *
 * `folderId` is accepted now and stored on a nullable column; the folders
 * table it will point at does not exist yet (see `costReports` in
 * `server-core/src/db/schema.ts`). Until it does, a client may round-trip
 * whatever it was given and nothing else reads it.
 */
export interface CostReportInput {
  name: string;
  /** Free text shown under the title in the list; absent is no description. */
  description?: string | undefined;
  /** The saved graph — the same blob a `cost_graph` widget stores inline. */
  config: CostGraphConfig;
  /** Reserved for report folders; always null until folders ship. */
  folderId?: string | null | undefined;
}

/** One dashboard card pointing at a report, as listed on {@link CostReport}. */
export interface CostReportPlacement {
  widgetId: string;
  dashboardId: string;
  dashboardName: string;
}

/**
 * A report as returned by the API.
 *
 * `placements` is the same idea as `BudgetWithStatus.placements`: a report
 * exists whether or not any dashboard shows it, so the list view is its home
 * and this is where it happens to say where else it appears.
 */
export interface CostReport {
  id: string;
  name: string;
  description: string | null;
  config: CostGraphConfig;
  /** Reserved for report folders; null until folders ship. */
  folderId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  placements: CostReportPlacement[];
}

/**
 * A cost_report widget is a dashboard view onto a cost_reports row — the report
 * outlives the card, exactly as a budget outlives its own.
 */
export interface CostReportWidgetConfig {
  version: 1;
  reportId: string;
}

/**
 * The answer to `POST /cost-reports/:id/run` — the report's own config resolved
 * to concrete dates, and the series it produced.
 *
 * Running by id exists so a caller (chat, the CLI, a scheduled delivery) never
 * has to reassemble the report's config to execute it; the resolved window
 * rides along because a relative preset means a different fortnight tomorrow.
 */
export interface CostReportRunResult {
  reportId: string;
  name: string;
  /** Inclusive YYYY-MM-DD window the relative preset resolved to. */
  from: string;
  to: string;
  result: CostQueryResponse;
}

/** Trim and bound a report name; returns null when it isn't usable. */
export function normalizeCostReportName(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > COST_REPORT_LIMITS.maxNameLength) return null;
  return name;
}

/**
 * `"Copy of Spend by service"`, `"Copy of Spend by service (2)"`, … — the name
 * a duplicate should take given the names already in use.
 *
 * Shared so the list view, the CLI and the chat tool all name a copy the same
 * way, and so a duplicate never silently collides with a name already there.
 * Falls back to truncating rather than exceeding the stored column.
 */
export function duplicateCostReportName(original: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const base = `Copy of ${original}`.slice(0, COST_REPORT_LIMITS.maxNameLength);
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate =
      base.length + suffix.length > COST_REPORT_LIMITS.maxNameLength
        ? base.slice(0, COST_REPORT_LIMITS.maxNameLength - suffix.length) + suffix
        : base + suffix;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  return base;
}
