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
import type {
  CostReport,
  CostReportFolder,
  CostReportRunResult,
  ReportNotification,
  ReportNotificationSendResult,
} from "@infrawrench/client-core" with {
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

/**
 * `"Finance / Monthly"` for each folder id — the ancestry joined the way the
 * Reports page shows it. A tiny local re-derivation of client-core's
 * `costReportFolderPaths` rather than an import, because the CLI keeps its
 * client-core imports type-only (zero runtime dependencies). Defensive on the
 * same points: a missing parent truncates the walk, a cycle can't loop.
 */
function folderPathsById(folders: CostReportFolder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (
      let cursor: CostReportFolder | undefined = folder;
      cursor && !seen.has(cursor.id);
      cursor = cursor.parentFolderId ? byId.get(cursor.parentFolderId) : undefined
    ) {
      seen.add(cursor.id);
      parts.unshift(cursor.name);
    }
    paths.set(folder.id, parts.join(" / "));
  }
  return paths;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * `"weekly Mon 08:00 UTC"` — one delivery schedule, compactly. A local
 * re-derivation of client-core's `describeReportSchedule` for the same reason
 * `folderPathsById` re-derives paths: the CLI keeps its client-core imports
 * type-only (zero runtime dependencies).
 */
function describeSchedule(n: ReportNotification): string {
  const hour = `${String(n.hour).padStart(2, "0")}:00`;
  const when =
    n.cadence === "weekly"
      ? `${WEEKDAYS[n.sendDay - 1] ?? "Mon"} ${hour}`
      : n.cadence === "monthly"
        ? `day ${n.sendDayOfMonth} ${hour}`
        : hour;
  return `${n.cadence} ${when} ${n.timezone}`;
}

/** The "delivery" column: schedule count, with failures called out. */
function deliverySummary(schedules: ReportNotification[]): string {
  if (schedules.length === 0) return c.dim("—");
  const failing = schedules.filter(
    (n) => n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets",
  ).length;
  const base =
    schedules.length === 1 ? describeSchedule(schedules[0]!) : `${schedules.length} schedules`;
  return failing > 0 ? `${base} ${c.red(`(${failing} failing)`)}` : base;
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
  const [reports, folders, notifications] = await Promise.all([
    orgFetch<CostReport[]>(org.id, "/cost-reports"),
    orgFetch<CostReportFolder[]>(org.id, "/cost-report-folders"),
    // One org-wide call rather than one per report — the endpoint exists for
    // exactly this column. Defensive: a failure costs the column, not the list.
    orgFetch<ReportNotification[]>(org.id, "/cost-report-notifications").catch(
      () => [] as ReportNotification[],
    ),
  ]);
  const folderPaths = folderPathsById(folders);
  const schedulesByReport = new Map<string, ReportNotification[]>();
  for (const n of notifications) {
    const list = schedulesByReport.get(n.costReportId) ?? [];
    list.push(n);
    schedulesByReport.set(n.costReportId, list);
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, reports, folders, notifications });
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
    {
      header: "folder",
      // The full path, so two "Monthly" folders under different parents stay
      // distinguishable; a dash is the top level of the Reports list.
      value: (r) =>
        r.folderId && folderPaths.has(r.folderId)
          ? c.dim(folderPaths.get(r.folderId)!)
          : c.dim("—"),
    },
    { header: "shape", value: (r) => c.dim(describeReport(r)) },
    {
      header: "dashboards",
      // The placement count is the honest answer to "who will notice if I
      // change this" — a report on five dashboards is not a private draft.
      value: (r) => (r.placements.length === 0 ? c.dim("—") : String(r.placements.length)),
      align: "right",
    },
    {
      header: "delivery",
      // Scheduled sends to Slack/Teams/email, with failures called out —
      // a schedule that quietly stopped delivering is the failure mode this
      // column exists to surface.
      value: (r) => deliverySummary(schedulesByReport.get(r.id) ?? []),
    },
    { header: "id", value: (r) => c.dim(r.id) },
  ]);

  println();
  println(
    c.dim(
      "Run one with `infrawrench reports <name|id>`; `infrawrench reports send <name|id>` delivers it to its schedules now.",
    ),
  );
}

/** Resolve a name/id query to exactly one report, or throw a helpful error. */
async function resolveReport(orgId: string, query: string): Promise<CostReport> {
  const reports = await orgFetch<CostReport[]>(orgId, "/cost-reports");
  const found = matchCostReport(reports, query);
  if (found.match) return found.match;
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

/**
 * `infrawrench reports send <name|id>` — run the report and deliver it to
 * every one of its schedules right now. Behind an explicit verb like
 * `exports run`: this posts into somebody's channel and inbox, so it should
 * never happen because a positional was mistyped.
 */
export async function cmdSendReport(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  if (!query.trim()) {
    throw new CliError("Which report? `infrawrench reports send <name|id>`.");
  }
  const org = await resolveOrg(ctx);
  const report = await resolveReport(org.id, query.trim());

  const schedules = await orgFetch<ReportNotification[]>(
    org.id,
    `/cost-reports/${encodeURIComponent(report.id)}/notifications`,
  );
  if (schedules.length === 0) {
    throw new CliError(
      `"${report.name}" has no delivery schedules. Add one on the report's page (web or desktop) first.`,
    );
  }

  // Sequential, not parallel: each send re-runs the report server-side, and a
  // schedule-by-schedule transcript reads better than an interleaved one.
  const results: Array<{ notification: ReportNotification; result: ReportNotificationSendResult }> =
    [];
  const failures: Array<{ notification: ReportNotification; error: string }> = [];
  for (const notification of schedules) {
    try {
      const result = await orgFetch<ReportNotificationSendResult>(
        org.id,
        `/cost-reports/${encodeURIComponent(report.id)}/notifications/${encodeURIComponent(notification.id)}/send`,
        { method: "POST" },
      );
      results.push({ notification, result });
    } catch (e) {
      failures.push({ notification, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      report: { id: report.id, name: report.name },
      sent: results.map((r) => ({ notificationId: r.notification.id, ...r.result })),
      failed: failures.map((f) => ({ notificationId: f.notification.id, error: f.error })),
    });
    if (failures.length > 0 && results.length === 0) throw new CliError("Every send failed.");
    return;
  }

  println(`${c.bold(report.name)} ${c.dim("· send now")}`);
  println();
  for (const { notification, result } of results) {
    println(
      `  ${c.green("✓")} ${describeSchedule(notification)} ${c.dim(
        `— delivered to ${result.succeeded}/${result.attempted} destination(s)`,
      )}`,
    );
  }
  for (const { notification, error } of failures) {
    println(`  ${c.red("✗")} ${describeSchedule(notification)} ${c.dim(`— ${error}`)}`);
  }
  if (failures.length > 0 && results.length === 0) {
    throw new CliError("Every send failed. See the errors above.");
  }
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
