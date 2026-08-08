// `infrawrench reports` — the org's saved cost reports, and running one.
//
// A report is a named cost graph the org already agreed on, which is exactly
// what makes it worth a CLI verb: `infrawrench reports "Monthly spend" --json`
// pipes the same numbers the dashboard card draws, without anyone having to
// restate the filters on the command line.
//
// The wire types come from `@infrawrench/client-core` — the same definitions
// the web, desktop and mobile cost views use — so a server-side change breaks
// this file's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { CostReport, CostReportRunResult } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { matchCostReport } from "../format";
import { c, printJson, println, printTable, formatMoney, seriesColor } from "../output";
import { barChart, sparkline } from "../charts";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Cost reports live in Infrawrench Cloud — there is no local report store or cost history.",
    );
  }
}

/** `"stacked bar · by service · last 30 days"` — how a saved report reads. */
function describeReport(report: CostReport): string {
  const { config } = report;
  const range =
    config.dateRange.kind === "absolute"
      ? `${config.dateRange.from} → ${config.dateRange.to}`
      : config.dateRange.preset;
  const groupBy = config.groupBy === "none" ? "ungrouped" : `by ${config.groupBy}`;
  return `${config.chartType.replace("_", " ")} · ${groupBy} · ${range}`;
}

/** `infrawrench reports` — list the org's saved reports. */
export async function cmdReports(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const reports = await orgFetch<CostReport[]>(org.id, "/cost-reports");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, reports });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· saved cost reports")}`);
  println();

  if (reports.length === 0) {
    println(
      c.dim(
        "No saved reports. A report is a cost graph with a name — save one from the Reports page, then run it here by name.",
      ),
    );
    return;
  }

  printTable(reports, [
    { header: "name", value: (r) => c.bold(r.name) },
    { header: "shape", value: (r) => c.dim(describeReport(r)) },
    {
      header: "dashboards",
      // The placement count is the honest answer to "who will notice if I
      // change this" — a report on five dashboards is not a private draft.
      value: (r) => (r.placements.length === 0 ? c.dim("—") : String(r.placements.length)),
      align: "right",
    },
    { header: "id", value: (r) => c.dim(r.id) },
  ]);

  println();
  println(c.dim("Run one with `infrawrench reports <name|id>`."));
}

/** `infrawrench reports <name|id>` — run a saved report and chart it. */
export async function cmdRunReport(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const reports = await orgFetch<CostReport[]>(org.id, "/cost-reports");

  const found = matchCostReport(reports, query);
  if (!found.match) {
    if (found.candidates.length === 0) {
      throw new CliError(
        `No cost report matches "${query}". Run \`infrawrench reports\` to see the saved ones.`,
      );
    }
    throw new CliError(
      `"${query}" matches ${found.candidates.length} reports: ${found.candidates
        .map((r) => r.name)
        .join(", ")}. Use the full name or the id.`,
    );
  }
  const report = found.match;

  // Run server-side by id: the report is the query, so the CLI never
  // reassembles its config and can never drift from what the dashboard draws.
  const run = await orgFetch<CostReportRunResult>(
    org.id,
    `/cost-reports/${encodeURIComponent(report.id)}/run`,
    { method: "POST" },
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, report, ...run });
    return;
  }

  const totalLine = Object.entries(run.result.totals)
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(" + ");
  println(`${c.bold(run.name)} ${c.dim(`· ${run.from} → ${run.to}`)}  ${c.bold(totalLine || "—")}`);
  if (report.description) println(c.dim(report.description));
  println();

  const { series } = run.result;
  if (series.length === 0) {
    println(c.dim("No cost data in this report's window yet."));
    return;
  }

  // Total trend across every series, on the report's own binning.
  const byBucket = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.amount);
  }
  const buckets = [...byBucket.keys()].sort();
  const totals = buckets.map((b) => byBucket.get(b)!);
  const sparkWidth = Math.min(60, Math.max(20, buckets.length));
  println(`${c.dim(report.config.binning)} ${seriesColor(0)(sparkline(totals, sparkWidth))}`);
  println();

  const items = series.map((s, idx) => {
    const total = s.points.reduce((sum, p) => sum + p.amount, 0);
    return {
      label: s.key === "__other__" ? c.dim("other") : s.label,
      value: total,
      display: formatMoney(total, s.currency),
      colorIndex: idx,
    };
  });
  for (const line of barChart(items, 32)) println(line);

  if (report.placements.length > 0) {
    println();
    println(
      c.dim(
        `Shown on ${report.placements.map((p) => p.dashboardName).join(", ")} — editing this report changes those cards too.`,
      ),
    );
  }
}
