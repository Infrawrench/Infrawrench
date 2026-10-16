/**
 * Unused custom metrics (`manifest.idleFindings`): custom metrics still
 * reporting (and billing) that nobody queried over a window and that no
 * dashboard, monitor, notebook or SLO uses.
 *
 * One endpoint, read twice (https://docs.datadoghq.com/api/latest/metrics/,
 * "Get a list of metrics", `GET /api/v2/metrics`, permission `metrics_read`,
 * verified 2026-10):
 *
 * 1. `filter[queried]=false` with `filter[queried][window][seconds]`: metrics
 *    not queried in the window (default 30 days, at most 180);
 * 2. the same plus `filter[related_assets]=true`: of those, the ones a
 *    dashboard, monitor, notebook or SLO references.
 *
 * The difference is the finding. `window[seconds]` keeps it to metrics that
 * reported in the last day (a metric that stopped reporting no longer bills),
 * `filter[is_configurable]=true` to the metrics Metrics without Limits can
 * configure (custom metrics), and `include=metric_volumes` returns each
 * one's indexed and ingested volume (estimated hourly averages of distinct
 * series), which is what a custom metric bills on.
 *
 * Pricing: Datadog's published list price is $5 per 100 custom metrics a
 * month (https://www.datadoghq.com/pricing/list/), so the estimate is the
 * indexed volume × $0.05. Plans include an allotment per host, and removing
 * metrics inside it saves nothing; the note says so.
 */
import type {
  IdleFindingRecord,
  IdleFindingsCapabilityDeclaration,
  IdleScanRequest,
} from "@infrawrench/plugin-base";
import { IdleFindingAccessError } from "@infrawrench/plugin-base";

import { ddFetch, statusOf, type DatadogContext } from "./api.js";

/** List price per indexed custom metric per month: $5 per 100. */
export const CUSTOM_METRIC_MONTHLY_USD = 0.05;
/** Findings per account, largest volume first; the rest wait for the next read. */
export const MAX_UNUSED_METRIC_FINDINGS = 100;
const PAGE_SIZE = 10_000;
const MAX_PAGES = 20;

export const DATADOG_IDLE_FINDINGS: IdleFindingsCapabilityDeclaration = {
  rules: [
    {
      id: "unused-custom-metric",
      label: "Unused custom metric",
      description:
        "A custom metric still reporting that nobody queried within the window and that no dashboard, monitor, notebook or SLO uses. Every distinct series it indexes counts toward the custom metrics bill.",
      resourceTypeIds: [],
      action: "reconfigure",
      thresholds: [
        {
          key: "notQueriedDays",
          label: "Not queried for",
          description: "Days without a query (Datadog's own look-back, 1 to 180).",
          unit: "days",
          default: 30,
          min: 1,
          max: 180,
        },
        {
          key: "minIndexedSeries",
          label: "Indexed series at least",
          description: "Only metrics indexing at least this many distinct series are listed.",
          unit: "count",
          default: 1,
          min: 0,
          max: 1_000_000,
        },
      ],
    },
  ],
};

interface MetricListPage {
  data?: Array<{ id?: string; type?: string }>;
  included?: Array<{
    id?: string;
    type?: string;
    attributes?: { indexed_volume?: number; ingested_volume?: number };
  }>;
  meta?: { pagination?: { next_cursor?: string | null } };
}

export interface MetricVolume {
  name: string;
  indexed: number | null;
  ingested: number | null;
}

/** Seam for tests: one page of `GET /api/v2/metrics`. */
export type MetricListFetch = (
  query: Record<string, string | number | boolean>,
) => Promise<MetricListPage>;

/** Every metric a filter set matches, with volumes, following the cursor. */
export async function listMetrics(
  fetchPage: MetricListFetch,
  filters: Record<string, string | number | boolean>,
): Promise<Map<string, MetricVolume>> {
  const out = new Map<string, MetricVolume>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await fetchPage({
      ...filters,
      include: "metric_volumes",
      "page[size]": PAGE_SIZE,
      ...(cursor ? { "page[cursor]": cursor } : {}),
    });
    const volumes = new Map(
      (body.included ?? [])
        .filter((i) => i.type === "metric_volumes" && i.id)
        .map((i) => [i.id!, i.attributes ?? {}]),
    );
    for (const item of body.data ?? []) {
      if (!item.id) continue;
      const v = volumes.get(item.id);
      out.set(item.id, {
        name: item.id,
        indexed: typeof v?.indexed_volume === "number" ? v.indexed_volume : null,
        ingested: typeof v?.ingested_volume === "number" ? v.ingested_volume : null,
      });
    }
    cursor = body.meta?.pagination?.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

export function datadogMetricListFetch(ctx: DatadogContext): MetricListFetch {
  return async (query) => {
    try {
      return await ddFetch<MetricListPage>(ctx, "/api/v2/metrics", { query });
    } catch (err) {
      if (statusOf(err) === 403) {
        throw new IdleFindingAccessError(
          "Datadog refused the metrics list: the application key needs the metrics_read scope.",
          {
            label: "Scoped application keys",
            url: "https://docs.datadoghq.com/account_management/api-app-keys/#scopes",
          },
        );
      }
      throw err;
    }
  };
}

export interface DatadogIdleDeps {
  fetchPage: MetricListFetch;
  /** The site's API base URL, for the remediation commands. */
  apiUrl: string;
}

/** Unused custom metrics for one organization. Throws on a failed read. */
export async function fetchDatadogIdleFindings(
  request: IdleScanRequest,
  deps: DatadogIdleDeps,
): Promise<IdleFindingRecord[]> {
  const rule = request.rules["unused-custom-metric"];
  if (!rule) return [];
  const days = Math.round(rule.thresholds["notQueriedDays"] ?? 30);
  const minSeries = rule.thresholds["minIndexedSeries"] ?? 1;
  const base = {
    "filter[queried]": false,
    "filter[queried][window][seconds]": days * 86_400,
    "filter[is_configurable]": true,
    "window[seconds]": 86_400,
  };
  const unqueried = await listMetrics(deps.fetchPage, base);
  if (unqueried.size === 0) return [];
  const used = await listMetrics(deps.fetchPage, { ...base, "filter[related_assets]": true });

  const unused = [...unqueried.values()]
    .filter((m) => !used.has(m.name))
    .filter((m) => (m.indexed ?? 0) >= minSeries)
    .sort((a, b) => (b.indexed ?? 0) - (a.indexed ?? 0) || a.name.localeCompare(b.name))
    .slice(0, MAX_UNUSED_METRIC_FINDINGS);

  return unused.map((m) => ({
    ruleId: "unused-custom-metric",
    subjectKey: m.name,
    resourceId: null,
    resourceTypeId: null,
    displayName: m.name,
    subjectLabel: "Custom metric",
    reason:
      `Not queried in ${days} days and used by no dashboard, monitor, notebook or SLO` +
      (m.indexed !== null
        ? `, while indexing ${Math.round(m.indexed).toLocaleString("en-US")} series`
        : ""),
    evidence: [
      {
        metric: "filter[queried]",
        label: `Queried in the last ${days} days`,
        statistic: "count",
        value: 0,
        unit: "count",
        threshold: 0,
        comparison: "atMost",
      },
      {
        metric: "filter[related_assets]",
        label: "Dashboards, monitors, notebooks and SLOs using it",
        statistic: "count",
        value: 0,
        unit: "count",
      },
      {
        metric: "indexed_volume",
        label: "Indexed series (hourly average)",
        statistic: "average",
        value: m.indexed,
        unit: "count",
        threshold: minSeries,
        comparison: "atLeast",
      },
      {
        metric: "ingested_volume",
        label: "Ingested series (hourly average)",
        statistic: "average",
        value: m.ingested,
        unit: "count",
      },
    ],
    estimate:
      m.indexed !== null && m.indexed > 0
        ? {
            monthlyAmount: Math.round(m.indexed * CUSTOM_METRIC_MONTHLY_USD * 100) / 100,
            currency: "USD",
            basis: "list-price" as const,
            note: "At $5 per 100 custom metrics a month. Metrics inside your plan's included allotment save nothing.",
          }
        : null,
    fields: { apiUrl: deps.apiUrl },
  }));
}
