// `infrawrench reports`: the org's saved cost reports, and running one.
//
// A report is a named cost graph the org already agreed on, which is exactly
// what makes it worth a CLI verb: `infrawrench reports "Monthly spend" --json`
// pipes the same numbers the dashboard card draws, without anyone having to
// restate the filters on the command line.
//
// The wire types come from `@infrawrench/client-core` (the same definitions
// the web, desktop and mobile cost views use) so a server-side change breaks
// this file's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CostReport,
  CostReportBulkRequest,
  CostReportBulkResult,
  CostReportFolder,
  CostReportRunOverrides,
  CostReportRunResult,
  ReportNotification,
  ReportNotificationSendResult,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { matchCostReport } from "../format";
import { c, printJson, println, printTable, seriesColor } from "../output";
import { barChart, sparkline } from "../charts";
import { exportPdf, wantsPdf, type PdfExportFlags } from "../pdf-export";
import type { RangeFlags } from "../args";
import { checkDisplayFlags, formatMeasureValue, parseDisplayFlags, seriesTotal } from "./costs";
import { confirm } from "../prompt";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Cost reports live in Infrawrench Cloud. There is no local report store or cost history.",
    );
  }
}

/**
 * `"Finance / Monthly"` for each folder id: the ancestry joined the way the
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
 * `"weekly Mon 08:00 UTC"`: one delivery schedule, compactly. A local
 * re-derivation of client-core's `describeReportSchedule` for the same reason
 * `folderPathsById` re-derives paths: the CLI keeps its client-core imports
 * type-only (zero runtime dependencies).
 */
export function describeSchedule(
  n: Pick<ReportNotification, "cadence" | "hour" | "sendDay" | "sendDayOfMonth" | "timezone">,
): string {
  const hour = `${String(n.hour).padStart(2, "0")}:00`;
  const when =
    n.cadence === "weekly"
      ? `${WEEKDAYS[n.sendDay - 1] ?? "Mon"} ${hour}`
      : n.cadence === "monthly"
        ? `day ${n.sendDayOfMonth} ${hour}`
        : hour;
  return `${n.cadence} ${when} ${n.timezone}`;
}

/**
 * The "delivery" column: schedule count, with failures called out. Shared
 * with `dashboards`, whose schedules are the same rows pointed elsewhere.
 */
export function deliverySummary(
  schedules: Array<Parameters<typeof describeSchedule>[0] & Pick<ReportNotification, "lastStatus">>,
): string {
  if (schedules.length === 0) return c.dim("—");
  const failing = schedules.filter(
    (n) => n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets",
  ).length;
  const base =
    schedules.length === 1 ? describeSchedule(schedules[0]!) : `${schedules.length} schedules`;
  return failing > 0 ? `${base} ${c.red(`(${failing} failing)`)}` : base;
}

/** `"stacked bar · by service · last 30 days"`: how a saved report reads. */
function describeReport(report: CostReport): string {
  const { config } = report;
  const range =
    config.dateRange.kind === "absolute"
      ? `${config.dateRange.from} → ${config.dateRange.to}`
      : config.dateRange.preset;
  const groupBy = config.groupBy === "none" ? "ungrouped" : `by ${config.groupBy}`;
  return `${config.chartType.replace("_", " ")} · ${groupBy} · ${range}`;
}

/** `infrawrench reports`: list the org's saved reports. */
export async function cmdReports(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const [reports, folders, notifications] = await Promise.all([
    orgFetch<CostReport[]>(org.id, "/cost-reports"),
    orgFetch<CostReportFolder[]>(org.id, "/cost-report-folders"),
    // One org-wide call rather than one per report: the endpoint exists for
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
        "No saved reports. A report is a cost graph with a name. Save one from the Reports page, then run it here by name.",
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
      // change this": a report on five dashboards is not a private draft.
      value: (r) => (r.placements.length === 0 ? c.dim("—") : String(r.placements.length)),
      align: "right",
    },
    {
      header: "delivery",
      // Scheduled sends to Slack/Teams/email, with failures called out:
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
export async function resolveReport(orgId: string, query: string): Promise<CostReport> {
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

/** A positional on `reports move|delete`, resolved to one report or folder. */
type BulkItem =
  { kind: "report"; id: string; label: string } | { kind: "folder"; id: string; label: string };

/**
 * Resolve each positional to exactly one report or folder. `folder:<path>`
 * forces a folder; otherwise a report match wins, then a folder by id, full
 * path ("Finance / Monthly") or unique name. Anything ambiguous or unknown is
 * an error naming it, before anything is sent: a bulk command that guesses is
 * a bulk command that files the wrong forty reports.
 */
function resolveBulkItems(
  queries: string[],
  reports: CostReport[],
  folders: CostReportFolder[],
): BulkItem[] {
  const paths = folderPathsById(folders);
  const out: BulkItem[] = [];
  for (const raw of queries) {
    const forceFolder = raw.startsWith("folder:");
    const query = forceFolder ? raw.slice("folder:".length).trim() : raw.trim();
    if (!forceFolder) {
      const found = matchCostReport(reports, query);
      if (found.match) {
        out.push({ kind: "report", id: found.match.id, label: found.match.name });
        continue;
      }
      if (found.candidates.length > 1) {
        throw new CliError(
          `"${query}" matches ${found.candidates.length} reports: ${found.candidates
            .map((r) => r.name)
            .join(", ")}. Use the full name or the id.`,
        );
      }
    }
    const folder = resolveFolderQuery(folders, paths, query);
    if (folder) {
      out.push({ kind: "folder", id: folder.id, label: paths.get(folder.id) ?? folder.name });
      continue;
    }
    throw new CliError(
      `Nothing matches "${query}". Run \`infrawrench reports\` to see reports and folder paths.`,
    );
  }
  return out;
}

/** A folder by id, full path or unique name; null when none, error when several. */
function resolveFolderQuery(
  folders: CostReportFolder[],
  paths: Map<string, string>,
  query: string,
): CostReportFolder | null {
  const q = query.trim().toLowerCase();
  const byId = folders.find((f) => f.id === query.trim());
  if (byId) return byId;
  const byPath = folders.filter((f) => (paths.get(f.id) ?? "").toLowerCase() === q);
  if (byPath.length === 1) return byPath[0]!;
  const byName = folders.filter((f) => f.name.trim().toLowerCase() === q);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new CliError(
      `"${query}" matches ${byName.length} folders: ${byName
        .map((f) => paths.get(f.id) ?? f.name)
        .join(", ")}. Use the full path or the id.`,
    );
  }
  return null;
}

/** Send one bulk request; the server's 400 already names every blocking item. */
async function sendBulk(orgId: string, request: CostReportBulkRequest) {
  return orgFetch<CostReportBulkResult>(orgId, "/cost-reports/bulk", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

/**
 * `infrawrench reports move <item>... --folder <path|id|top>`: file reports
 * and folders into one folder, all or nothing. Moved folders keep their
 * contents and become children of the destination.
 */
export async function cmdMoveReports(
  ctx: CliContext,
  queries: string[],
  destination: string | undefined,
): Promise<void> {
  requireCloud(ctx);
  if (queries.length === 0) {
    throw new CliError(
      'What should move? `infrawrench reports move "<report>" folder:"<folder>" --folder <path|top>`.',
      2,
    );
  }
  if (destination === undefined) {
    throw new CliError(
      "Where to? Add `--folder <path|id>`, or `--folder top` for the top level.",
      2,
    );
  }
  const org = await resolveOrg(ctx);
  const [reports, folders] = await Promise.all([
    orgFetch<CostReport[]>(org.id, "/cost-reports"),
    orgFetch<CostReportFolder[]>(org.id, "/cost-report-folders"),
  ]);
  const items = resolveBulkItems(queries, reports, folders);
  const paths = folderPathsById(folders);
  const top = ["top", "/", "root", "none"].includes(destination.trim().toLowerCase());
  const target = top ? null : resolveFolderQuery(folders, paths, destination);
  if (!top && !target) {
    throw new CliError(
      `No folder matches "${destination}". Use \`--folder top\` for the top level.`,
    );
  }

  const result = await sendBulk(org.id, {
    action: "move",
    reportIds: items.filter((i) => i.kind === "report").map((i) => i.id),
    folderIds: items.filter((i) => i.kind === "folder").map((i) => i.id),
    targetFolderId: target?.id ?? null,
  });

  const where = target ? (paths.get(target.id) ?? target.name) : "the top level";
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result, targetFolderId: target?.id ?? null, items });
    return;
  }
  for (const item of items) {
    println(`  ${c.green("✓")} ${item.kind === "folder" ? c.dim("folder ") : ""}${item.label}`);
  }
  println();
  println(`Moved ${result.reports} report(s) and ${result.folders} folder(s) to ${c.bold(where)}.`);
}

/**
 * `infrawrench reports delete <item>... [-y]`: delete reports and folders,
 * all or nothing. Asks first unless `-y`, and refuses to run unattended
 * without it: this removes dashboard cards and stops delivery schedules.
 */
export async function cmdDeleteReports(
  ctx: CliContext,
  queries: string[],
  yes: boolean,
): Promise<void> {
  requireCloud(ctx);
  if (queries.length === 0) {
    throw new CliError('What should be deleted? `infrawrench reports delete "<report>" -y`.', 2);
  }
  const org = await resolveOrg(ctx);
  const [reports, folders] = await Promise.all([
    orgFetch<CostReport[]>(org.id, "/cost-reports"),
    orgFetch<CostReportFolder[]>(org.id, "/cost-report-folders"),
  ]);
  const items = resolveBulkItems(queries, reports, folders);

  if (!yes) {
    if (!process.stdin.isTTY || ctx.flags.output === "json") {
      throw new CliError(
        "Refusing to delete without confirmation on a non-interactive run. Re-run with -y.",
        2,
      );
    }
    for (const item of items) {
      println(`  ${c.red("✗")} ${item.kind === "folder" ? c.dim("folder ") : ""}${item.label}`);
    }
    println(
      c.dim(
        "Deleted reports lose their dashboard cards and delivery schedules; a deleted folder's other contents move to the top level.",
      ),
    );
    if (!(await confirm(`Delete these ${items.length} item(s) from ${org.displayName}?`))) {
      println(c.dim("Cancelled; nothing was changed."));
      return;
    }
  }

  const result = await sendBulk(org.id, {
    action: "delete",
    reportIds: items.filter((i) => i.kind === "report").map((i) => i.id),
    folderIds: items.filter((i) => i.kind === "folder").map((i) => i.id),
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...result, items });
    return;
  }
  println(`Deleted ${result.reports} report(s) and ${result.folders} folder(s).`);
}

/**
 * `infrawrench reports send <name|id>`: run the report and deliver it to
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
        `delivered to ${result.succeeded}/${result.attempted} destination(s)`,
      )}`,
    );
  }
  for (const { notification, error } of failures) {
    println(`  ${c.red("✗")} ${describeSchedule(notification)} ${c.dim(`(${error})`)}`);
  }
  if (failures.length > 0 && results.length === 0) {
    throw new CliError("Every send failed. See the errors above.");
  }
}

/**
 * `infrawrench reports <name|id>`: run a saved report and chart it. With
 * `--format pdf`, download the server-rendered PDF instead (the same document
 * the web "Export PDF" button produces) and write it to `--out`, or to the
 * report's slugged name in the current directory.
 */
export async function cmdRunReport(
  ctx: CliContext,
  query: string,
  pdfFlags: PdfExportFlags = {},
  range: RangeFlags = {},
): Promise<void> {
  requireCloud(ctx);
  const pdf = wantsPdf(pdfFlags, "reports");
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

  if (pdf) {
    await exportPdf(ctx, {
      orgId: org.id,
      path: `/cost-reports/${encodeURIComponent(report.id)}/pdf`,
      flags: pdfFlags,
      subject: { kind: "report", id: report.id, name: report.name },
    });
    return;
  }

  // One-off display overrides (`--measure`, `--bin`, `--unit`,
  // `--cumulative`): sent as the run's body and applied server-side to this
  // run only. The saved report is never edited from here.
  const display = parseDisplayFlags(range);
  const overrides: CostReportRunOverrides = { ...display };
  const hasOverrides = Object.keys(overrides).length > 0;
  if (hasOverrides) {
    // Checked against the config the server will run: the override wins and,
    // for usage/count, the money-only overlays are dropped the same way.
    const measure = display.measure ?? report.config.measure ?? "cost";
    await checkDisplayFlags(org.id, {
      measure,
      usageUnit: display.usageUnit ?? (measure === "usage" ? report.config.usageUnit : undefined),
      groupBy: report.config.groupBy,
      binning: display.binning ?? report.config.binning,
      cumulative: display.cumulative ?? report.config.cumulative,
    });
  }

  // Run server-side by id: the report is the query, so the CLI never
  // reassembles its config and can never drift from what the dashboard draws.
  const run = await orgFetch<CostReportRunResult>(
    org.id,
    `/cost-reports/${encodeURIComponent(report.id)}/run`,
    { method: "POST", ...(hasOverrides ? { body: JSON.stringify(overrides) } : {}) },
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, report, ...(hasOverrides ? { overrides } : {}), ...run });
    return;
  }

  const binning = display.binning ?? report.config.binning;
  const cumulative =
    binning === "cumulative" || (display.cumulative ?? report.config.cumulative) === true;
  const totalLine = Object.entries(run.result.totals)
    .map(([currency, amount]) => formatMeasureValue(amount, currency, run.result))
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
  const measureNote =
    run.result.measure === "usage"
      ? ` · usage in ${run.result.usageUnit ?? "?"}`
      : run.result.measure === "count"
        ? ` · distinct ${report.config.groupBy} count`
        : "";
  println(
    `${c.dim(`${binning}${cumulative && binning !== "cumulative" ? " cumulative" : ""}${measureNote}`)} ${seriesColor(0)(sparkline(totals, sparkWidth))}`,
  );
  println();

  const items = series.map((s, idx) => {
    const total = seriesTotal(s.points, cumulative);
    return {
      label: s.key === "__other__" ? c.dim("other") : s.label,
      value: total,
      display: formatMeasureValue(total, s.currency, run.result),
      colorIndex: idx,
    };
  });
  for (const line of barChart(items, 32)) println(line);

  if (report.placements.length > 0) {
    println();
    println(
      c.dim(
        `Shown on ${report.placements.map((p) => p.dashboardName).join(", ")}. Editing this report changes those cards too.`,
      ),
    );
  }
}
