/**
 * Commitment report tools: list and run saved commitment reports from chat
 * and MCP. Reads only; reports are created and edited in the app (or through
 * the API). Permissions mirror the routes (`costs:read`), and every read runs
 * under the caller's cost visibility scope (`runToolHandler`).
 */
import { Schema } from "effect";
import type {
  CommitmentReportPoint,
  CommitmentReportRunResult,
  CommitmentReportSeries,
} from "@infrawrench/client-core";
import { listCommitmentReports, runSavedCommitmentReport } from "../services/commitment-reports";
import { ok, err, type ToolDefinition } from "./types";

/** Groups a run returns at most; the rest are counted, not listed. */
const MAX_GROUPS = 50;
/** Buckets of the headline trend returned at most, the latest ones. */
const MAX_TREND_BUCKETS = 60;

const METRICS_GUIDE =
  "Ratios are fractions between 0 and 1 (coverage, eligibleCoverage, utilization, " +
  "effectiveSavingsRate); a null ratio means there was nothing to measure, never zero. " +
  "netSavings is null when covered usage had no reported on-demand equivalent. Money is in the " +
  "series currency; currencies are never summed together.";

const point = (p: CommitmentReportPoint) => ({ bucket: p.bucket, ...p.metrics });

/**
 * The run trimmed for a model: the headline per currency with its trend, and
 * each group's totals without the per-bucket series, which can run to
 * hundreds of points and say nothing a sentence needs.
 */
function summarize(run: CommitmentReportRunResult) {
  const group = (s: CommitmentReportSeries) => ({
    groupKey: s.groupKey,
    label: s.label,
    currency: s.currency,
    ...s.total.metrics,
  });
  return {
    reportId: run.reportId,
    name: run.name,
    from: run.from,
    to: run.to,
    granularity: run.granularity,
    groupBy: run.groupBy,
    overall: run.overall.map((s) => ({
      currency: s.currency,
      total: s.total.metrics,
      trend: s.points.slice(-MAX_TREND_BUCKETS).map(point),
      trendBucketsOmitted: Math.max(0, s.points.length - MAX_TREND_BUCKETS),
    })),
    groups: run.groupBy === "none" ? [] : run.series.slice(0, MAX_GROUPS).map(group),
    groupsOmitted: run.groupBy === "none" ? 0 : Math.max(0, run.series.length - MAX_GROUPS),
    providers: run.providers,
    notices: run.notices,
  };
}

export function commitmentReportTools(): ToolDefinition[] {
  return [
    {
      name: "list_commitment_reports",
      title: "List commitment reports",
      description:
        "List the organization's saved commitment reports: coverage, utilization, effective " +
        "savings rate, net savings against on-demand and commitment cost (used and unused) for " +
        "reservations, savings plans and committed-use discounts over a window, by provider, " +
        "commitment type, commitment, service, account or region. Returns definitions; use " +
        "run_commitment_report for numbers.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const reports = await listCommitmentReports(auth.organizationId);
        return ok(
          reports.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            config: r.config,
            updatedAt: r.updatedAt,
          })),
        );
      },
    },
    {
      name: "run_commitment_report",
      title: "Run commitment report",
      description:
        "Run a saved commitment report and return, per currency, its headline metrics and their " +
        `trend (the latest ${MAX_TREND_BUCKETS} buckets), plus each group's totals (at most ` +
        `${MAX_GROUPS}), the providers in scope and any notices about how far the numbers can ` +
        `be read. ${METRICS_GUIDE} Quote the returned window with figures.`,
      inputSchema: { reportId: Schema.String },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const reportId = input["reportId"] as string;
        const run = await runSavedCommitmentReport(auth.organizationId, reportId);
        if (!run) return err(`Commitment report not found: ${reportId}`);
        return ok(summarize(run));
      },
    },
  ];
}
