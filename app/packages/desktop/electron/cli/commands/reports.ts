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
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostBinningId,
  CostReport,
  CostReportAnomalyAlert,
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
import { attempt, bestEffort, CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { destination, destinationOf, pdfFormat } from "../effect/file-flags";
import * as Print from "../effect/print";
import { costDisplay } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, type Paired, spreadBody, Unrecognized, wire } from "../effect/wire";
import { matchCostReport } from "../format";
import { c, safe, seriesColor } from "../output";
import { barChart, sparkline } from "../charts";
import { exportPdf, requirePdfForDestination } from "../pdf-export";
import {
  asCostQuery,
  checkDisplayFlags,
  CostQuery,
  type DisplayFlagValues,
  formatMeasureValue,
  parseDisplayFlags,
  printDimensionAxis,
  seriesTotal,
  withPreviousTotal,
} from "./costs";
import { REPORTS_PATH, resolveReport } from "./report-lookup";
import { confirm } from "../effect/prompt";

// Restated for `knownOr`: the CLI's client-core imports are type-only at
// module scope, and `wire` fails the build when client-core adds a value.
const DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "tag",
  "charge_type",
  "commitment",
  "virtual_tag",
] as const;
const BINNINGS = ["hourly", "daily", "weekly", "monthly", "quarterly", "cumulative"] as const;
const MEASURES = ["cost", "usage", "count"] as const;

const FOLDERS_PATH = "/cost-report-folders";
const NOTIFICATIONS_PATH = "/cost-report-notifications";
const ANOMALY_ALERTS_PATH = "/cost-report-anomaly-alerts";

const Report = wire<CostReport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    folderId: Schema.NullOr(Schema.String),
    placements: Schema.Array(Schema.Struct({ dashboardName: Schema.String })),
    config: Schema.Struct({
      chartType: Schema.String,
      dateRange: Schema.Struct({
        kind: Schema.String,
        preset: Schema.optional(Schema.String),
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String),
      }),
      groupBy: knownOr(["none", ...DIMENSIONS]),
      groupByTagKey: Schema.optional(Schema.String),
      binning: knownOr(BINNINGS),
      cumulative: Schema.optional(Schema.Boolean),
      measure: Schema.optional(knownOr(MEASURES)),
      usageUnit: Schema.optional(Schema.String),
    }),
  }),
);
type Report = typeof Report.Type;
const Reports = Schema.Array(Report);

const Folder = wire<CostReportFolder>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    parentFolderId: Schema.NullOr(Schema.String),
  }),
);
type Folder = typeof Folder.Type;
const Folders = Schema.Array(Folder);

const Schedule = Schema.Struct({
  id: Schema.String,
  cadence: Schema.String,
  hour: Schema.Finite,
  sendDay: Schema.Finite,
  sendDayOfMonth: Schema.Finite,
  timezone: Schema.String,
  lastStatus: Schema.NullOr(Schema.String),
});
/** One delivery schedule, as `describeSchedule` and `deliverySummary` read it. */
export type ScheduleRow = typeof Schedule.Type;

const Notifications = wire<ReportNotification[]>()(
  Schema.Array(Schema.Struct({ ...Schedule.fields, costReportId: Schema.String })),
);
const Schedules = wire<ReportNotification[]>()(Schema.Array(Schedule));

const SendResult = wire<ReportNotificationSendResult>()(
  Schema.Struct({ attempted: Schema.Finite, succeeded: Schema.Finite }),
);

const BulkResult = wire<CostReportBulkResult>()(
  Schema.Struct({ reports: Schema.Finite, folders: Schema.Finite }),
);

const AnomalyAlert = wire<CostReportAnomalyAlert>()(
  Schema.Struct({
    reportId: Schema.String,
    reportName: Schema.String,
    enabled: Schema.Boolean,
    sigmas: Schema.Finite,
    minDeltaCents: Schema.Finite,
    destinations: Schema.Array(Schema.Struct({ kind: Schema.String })),
    lastError: Schema.NullOr(Schema.String),
    recent: Schema.Array(
      Schema.Struct({
        day: Schema.String,
        currency: Schema.String,
        actual: Schema.Finite,
        baseline: Schema.Finite,
        notifiedAt: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const AnomalyAlerts = Schema.Struct({ alerts: Schema.Unknown });

const RunResult = wire<CostReportRunResult>()(
  Schema.Struct({ name: Schema.String, from: Schema.String, to: Schema.String, result: CostQuery }),
);

const raw = <A extends string>(value: A | Unrecognized): string =>
  value instanceof Unrecognized ? value.raw : value;

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Cost reports live in Infrawrench Cloud. There is no local report store or cost history.",
    });
  }
});

/**
 * `"Finance / Monthly"` for each folder id: the ancestry joined the way the
 * Reports page shows it. A tiny local re-derivation of client-core's
 * `costReportFolderPaths` rather than an import, because the CLI keeps its
 * client-core imports type-only (zero runtime dependencies). Defensive on the
 * same points: a missing parent truncates the walk, a cycle can't loop.
 */
function folderPathsById(folders: ReadonlyArray<Folder>): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (
      let cursor: Folder | undefined = folder;
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
  n: Pick<ScheduleRow, "cadence" | "hour" | "sendDay" | "sendDayOfMonth" | "timezone">,
): string {
  const hour = `${String(n.hour).padStart(2, "0")}:00`;
  const when =
    n.cadence === "weekly"
      ? `${WEEKDAYS[n.sendDay - 1] ?? "Mon"} ${hour}`
      : n.cadence === "monthly"
        ? `day ${n.sendDayOfMonth} ${hour}`
        : hour;
  return `${safe(n.cadence)} ${when} ${safe(n.timezone)}`;
}

/**
 * The "delivery" column: schedule count, with failures called out. Shared
 * with `dashboards`, whose schedules are the same rows pointed elsewhere.
 */
export function deliverySummary(
  schedules: ReadonlyArray<
    Parameters<typeof describeSchedule>[0] & Pick<ScheduleRow, "lastStatus">
  >,
): string {
  const [first] = schedules;
  if (!first) return c.dim("—");
  const failing = schedules.filter(
    (n) => n.lastStatus === "failed" || n.lastStatus === "partial" || n.lastStatus === "no_targets",
  ).length;
  const base = schedules.length === 1 ? describeSchedule(first) : `${schedules.length} schedules`;
  return failing > 0 ? `${base} ${c.red(`(${failing} failing)`)}` : base;
}

/** `"stacked bar · by service · last 30 days"`: how a saved report reads. */
function describeReport(report: Report): string {
  const { config } = report;
  const range =
    config.dateRange.kind === "absolute"
      ? `${config.dateRange.from ?? ""} → ${config.dateRange.to ?? ""}`
      : (config.dateRange.preset ?? config.dateRange.kind);
  const groupBy = config.groupBy === "none" ? "ungrouped" : `by ${raw(config.groupBy)}`;
  return safe(`${config.chartType.replace("_", " ")} · ${groupBy} · ${range}`);
}

/** A name/id query to exactly one report, beside the element the server sent. */
const findReport = Effect.fnUntraced(function* (orgId: string, query: string) {
  const found = yield* resolveReport(orgId, query);
  return { row: yield* decodeBody(Report, REPORTS_PATH)(found.raw), raw: found.raw };
});

/** `infrawrench reports`: list the org's saved reports. */
const listReports = Effect.fnUntraced(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const [reportsBody, foldersBody, notificationsBody] = yield* Effect.all(
    [
      api.json(org.id, REPORTS_PATH),
      api.json(org.id, FOLDERS_PATH),
      // One org-wide call rather than one per report: the endpoint exists for
      // exactly this column. Defensive: a failure costs the column, not the list.
      api.json(org.id, NOTIFICATIONS_PATH).pipe(bestEffort((): unknown => [])),
    ],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    return yield* Print.json({
      org: org.id,
      reports: reportsBody,
      folders: foldersBody,
      notifications: notificationsBody,
    });
  }
  const reports = yield* decodeBody(Reports, REPORTS_PATH)(reportsBody);
  const folderPaths = folderPathsById(yield* decodeBody(Folders, FOLDERS_PATH)(foldersBody));
  const notifications = yield* decodeBody(
    Notifications,
    NOTIFICATIONS_PATH,
  )(notificationsBody).pipe(bestEffort((): typeof Notifications.Type => []));
  const schedulesByReport = new Map<string, ScheduleRow[]>();
  for (const n of notifications) {
    const list = schedulesByReport.get(n.costReportId) ?? [];
    list.push(n);
    schedulesByReport.set(n.costReportId, list);
  }

  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· saved cost reports")}`);
  yield* Print.line();

  if (reports.length === 0) {
    return yield* Print.line(
      c.dim(
        "No saved reports. A report is a cost graph with a name. Save one from the Reports page, then run it here by name.",
      ),
    );
  }

  yield* Print.table(reports, [
    { header: "name", value: (r) => c.bold(safe(r.name)) },
    {
      header: "folder",
      // The full path, so two "Monthly" folders under different parents stay
      // distinguishable; a dash is the top level of the Reports list.
      value: (r) => {
        const path = r.folderId ? folderPaths.get(r.folderId) : undefined;
        return c.dim(path === undefined ? "—" : safe(path));
      },
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

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Run one with `infrawrench reports <name|id>`; `infrawrench reports send <name|id>` delivers it to its schedules now.",
    ),
  );
});

/**
 * `infrawrench reports <name|id>`: run a saved report and chart it. With
 * `--format pdf`, download the server-rendered PDF instead (the same document
 * the web "Export PDF" button produces) and write it to `--out`, or to the
 * report's slugged name in the current directory.
 */
const runReport = Effect.fnUntraced(function* (
  query: string,
  pdf: boolean,
  target: Option.Option<string>,
  flags: DisplayFlagValues,
) {
  yield* requirePdfForDestination(pdf, target, "reports");
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const { row: report, raw: rawReport } = yield* findReport(org.id, query);

  if (pdf) {
    return yield* exportPdf({
      orgId: org.id,
      path: `/cost-reports/${encodeURIComponent(report.id)}/pdf`,
      target,
      subject: { kind: "report", id: report.id, name: report.name },
    });
  }

  // One-off display overrides (`--measure`, `--bin`, `--unit`,
  // `--cumulative`): sent as the run's body and applied server-side to this
  // run only. The saved report is never edited from here.
  const display = yield* parseDisplayFlags(flags);
  const overrides: CostReportRunOverrides = { ...display };
  const hasOverrides = Object.keys(overrides).length > 0;
  const { groupBy, binning: savedBinning, measure: savedMeasure } = report.config;
  // A grouping, bin or measure this build does not know is the server's to
  // judge: the local check would be guessing.
  if (
    hasOverrides &&
    !(groupBy instanceof Unrecognized) &&
    !(savedBinning instanceof Unrecognized) &&
    !(savedMeasure instanceof Unrecognized)
  ) {
    // Checked against the config the server will run: the override wins and,
    // for usage/count, the money-only overlays are dropped the same way.
    const measure = display.measure ?? savedMeasure ?? "cost";
    yield* checkDisplayFlags(org.id, {
      measure,
      usageUnit: display.usageUnit ?? (measure === "usage" ? report.config.usageUnit : undefined),
      groupBy,
      binning: display.binning ?? savedBinning,
      cumulative: display.cumulative ?? report.config.cumulative,
      ...(display.xAxis && display.xAxis !== "date"
        ? {
            xAxis: display.xAxis,
            ...(display.xAxisTagKey ? { xAxisTagKey: display.xAxisTagKey } : {}),
            // The run override makes the axis's own segment one bar per value.
            groupBy: groupBy === display.xAxis ? "none" : groupBy,
            ...(report.config.groupByTagKey ? { groupByTagKey: report.config.groupByTagKey } : {}),
          }
        : {}),
    });
  }

  // Run server-side by id: the report is the query, so the CLI never
  // reassembles its config and can never drift from what the dashboard draws.
  const runPath = `/cost-reports/${encodeURIComponent(report.id)}/run`;
  const runBody = yield* api.json(org.id, runPath, {
    method: "POST",
    ...(hasOverrides ? { body: JSON.stringify(overrides) } : {}),
  });

  if (session.output === "json") {
    return yield* Print.json(
      yield* spreadBody(
        { org: org.id, report: rawReport, ...(hasOverrides ? { overrides } : {}) },
        runBody,
        runPath,
      ),
    );
  }
  const run = yield* decodeBody(RunResult, runPath)(runBody);
  const result = asCostQuery(run.result);

  const binning = display.binning ?? raw(savedBinning);
  const cumulative =
    binning === "cumulative" || (display.cumulative ?? report.config.cumulative) === true;
  const totalLine = Object.entries(result.totals)
    .map(([currency, amount]) => formatMeasureValue(amount, currency, result))
    .join(" + ");
  yield* Print.line(
    `${c.bold(safe(run.name))} ${c.dim(`· ${run.from} → ${run.to}`)}  ${c.bold(withPreviousTotal(totalLine, result) || "—")}`,
  );
  if (report.description) yield* Print.line(c.dim(safe(report.description)));
  yield* Print.line();

  const { series } = run.result;
  if (series.length === 0) {
    return yield* Print.line(c.dim("No cost data in this report's window yet."));
  }

  // Saved (or run) with a dimension on X: one bar per value, not a trend.
  if (run.result.xAxis) {
    const axisBinning: CostBinningId =
      binning === "cumulative"
        ? "daily"
        : (display.binning ?? (savedBinning instanceof Unrecognized ? "daily" : savedBinning));
    yield* printDimensionAxis(result, axisBinning);
  } else {
    // Total trend across every series, on the report's own binning.
    const byBucket = new Map<string, number>();
    for (const s of series) {
      for (const p of s.points) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.amount);
    }
    const buckets = [...byBucket.keys()].sort();
    const totals = buckets.map((b) => byBucket.get(b) ?? 0);
    const sparkWidth = Math.min(60, Math.max(20, buckets.length));
    const measure = run.result.measure;
    const measureNote =
      measure === "usage"
        ? ` · usage in ${safe(run.result.usageUnit ?? "?")}`
        : measure === "count"
          ? ` · distinct ${raw(groupBy)} count`
          : "";
    yield* Print.line(
      `${c.dim(`${safe(binning)}${cumulative && binning !== "cumulative" ? " cumulative" : ""}${measureNote}`)} ${seriesColor(0)(sparkline(totals, sparkWidth))}`,
    );
    yield* Print.line();

    const items = series.map((s, idx) => {
      const total = seriesTotal([...s.points], cumulative);
      return {
        label: s.key === "__other__" ? c.dim("other") : safe(s.label),
        value: total,
        display: formatMeasureValue(total, s.currency, result),
        colorIndex: idx,
      };
    });
    for (const line of barChart(items, 32)) yield* Print.line(line);
  }

  if (report.placements.length > 0) {
    yield* Print.line();
    yield* Print.line(
      c.dim(
        `Shown on ${report.placements.map((p) => safe(p.dashboardName)).join(", ")}. Editing this report changes those cards too.`,
      ),
    );
  }
});

/** A positional on `reports move|delete`, resolved to one report or folder. */
type BulkItem =
  { kind: "report"; id: string; label: string } | { kind: "folder"; id: string; label: string };

/** A folder by id, full path or unique name; null when none, a failure when several. */
function resolveFolderQuery(
  folders: ReadonlyArray<Folder>,
  paths: Map<string, string>,
  query: string,
): Folder | null | CliFailure {
  const q = query.trim().toLowerCase();
  const byId = folders.find((f) => f.id === query.trim());
  if (byId) return byId;
  const byPath = folders.filter((f) => (paths.get(f.id) ?? "").toLowerCase() === q);
  const [onePath] = byPath;
  if (onePath && byPath.length === 1) return onePath;
  const byName = folders.filter((f) => f.name.trim().toLowerCase() === q);
  const [oneName] = byName;
  if (oneName && byName.length === 1) return oneName;
  if (byName.length > 1) {
    return new CliFailure({
      message: `"${query}" matches ${byName.length} folders: ${byName
        .map((f) => paths.get(f.id) ?? f.name)
        .join(", ")}. Use the full path or the id.`,
    });
  }
  return null;
}

/**
 * Resolve each positional to exactly one report or folder. `folder:<path>`
 * forces a folder; otherwise a report match wins, then a folder by id, full
 * path ("Finance / Monthly") or unique name. Anything ambiguous or unknown is
 * an error naming it, before anything is sent: a bulk command that guesses is
 * a bulk command that files the wrong forty reports.
 */
const resolveBulkItems = Effect.fnUntraced(function* (
  queries: ReadonlyArray<string>,
  reports: ReadonlyArray<Report>,
  folders: ReadonlyArray<Folder>,
) {
  const paths = folderPathsById(folders);
  const out: BulkItem[] = [];
  for (const rawQuery of queries) {
    const forceFolder = rawQuery.startsWith("folder:");
    const query = forceFolder ? rawQuery.slice("folder:".length).trim() : rawQuery.trim();
    if (!forceFolder) {
      const found = matchCostReport(reports, query);
      if (found.match) {
        out.push({ kind: "report", id: found.match.id, label: found.match.name });
        continue;
      }
      if (found.candidates.length > 1) {
        return yield* new CliFailure({
          message: `"${query}" matches ${found.candidates.length} reports: ${found.candidates
            .map((r) => r.name)
            .join(", ")}. Use the full name or the id.`,
        });
      }
    }
    const folder = resolveFolderQuery(folders, paths, query);
    if (folder instanceof CliFailure) return yield* folder;
    if (folder) {
      out.push({ kind: "folder", id: folder.id, label: paths.get(folder.id) ?? folder.name });
      continue;
    }
    return yield* new CliFailure({
      message: `Nothing matches "${query}". Run \`infrawrench reports\` to see reports and folder paths.`,
    });
  }
  return out;
});

const loadTree = Effect.fnUntraced(function* (orgId: string) {
  const api = yield* CloudApi;
  return yield* Effect.all(
    [api.decode(Reports, orgId, REPORTS_PATH), api.decode(Folders, orgId, FOLDERS_PATH)],
    { concurrency: "unbounded" },
  );
});

/** Send one bulk request; the server's 400 already names every blocking item. */
const sendBulk = Effect.fnUntraced(function* (orgId: string, request: CostReportBulkRequest) {
  const api = yield* CloudApi;
  const path = "/cost-reports/bulk";
  const body = yield* api.json(orgId, path, { method: "POST", body: JSON.stringify(request) });
  return { body, result: yield* decodeBody(BulkResult, path)(body), path };
});

const items = Argument.String("item").pipe(
  Argument.withDescription(
    'A report (name or id) or folder:"<path>"; one per argument, quote names with spaces',
  ),
  Argument.variadic(),
);

/**
 * `infrawrench reports move <item>... --folder <path|id|top>`: file reports
 * and folders into one folder, all or nothing. Moved folders keep their
 * contents and become children of the destination.
 */
const move = Command.make(
  "move",
  {
    items,
    folder: Flag.String("folder").pipe(
      Flag.withMetavar("path|id|top"),
      Flag.withDescription("The destination; top for the top level"),
      Flag.optional,
    ),
  },
  Effect.fn("reports.move")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    if (input.items.length === 0) {
      return yield* new CliUsageError({
        message:
          'What should move? `infrawrench reports move "<report>" folder:"<folder>" --folder <path|top>`.',
      });
    }
    if (Option.isNone(input.folder)) {
      return yield* new CliUsageError({
        message: "Where to? Add `--folder <path|id>`, or `--folder top` for the top level.",
      });
    }
    const destinationQuery = input.folder.value;
    const org = yield* currentOrg;
    const [reports, folders] = yield* loadTree(org.id);
    const resolved = yield* resolveBulkItems(input.items, reports, folders);
    const paths = folderPathsById(folders);
    const top = ["top", "/", "root", "none"].includes(destinationQuery.trim().toLowerCase());
    const target = top ? null : resolveFolderQuery(folders, paths, destinationQuery);
    if (target instanceof CliFailure) return yield* target;
    if (!top && !target) {
      return yield* new CliFailure({
        message: `No folder matches "${destinationQuery}". Use \`--folder top\` for the top level.`,
      });
    }

    const sent = yield* sendBulk(org.id, {
      action: "move",
      reportIds: resolved.filter((i) => i.kind === "report").map((i) => i.id),
      folderIds: resolved.filter((i) => i.kind === "folder").map((i) => i.id),
      targetFolderId: target?.id ?? null,
    });

    const where = target ? (paths.get(target.id) ?? target.name) : "the top level";
    if (session.output === "json") {
      return yield* Print.json({
        ...(yield* spreadBody({ org: org.id }, sent.body, sent.path)),
        targetFolderId: target?.id ?? null,
        items: resolved,
      });
    }
    for (const item of resolved) {
      yield* Print.line(
        `  ${c.green("✓")} ${item.kind === "folder" ? c.dim("folder ") : ""}${safe(item.label)}`,
      );
    }
    yield* Print.line();
    yield* Print.line(
      `Moved ${sent.result.reports} report(s) and ${sent.result.folders} folder(s) to ${c.bold(safe(where))}.`,
    );
  }),
).pipe(
  Command.withDescription(
    "File reports (and folder:<path> folders) into one folder, all or nothing",
  ),
);

/**
 * `infrawrench reports delete <item>... [-y]`: delete reports and folders,
 * all or nothing. Asks first unless `-y`, and refuses to run unattended
 * without it: this removes dashboard cards and stops delivery schedules.
 */
const remove = Command.make(
  "delete",
  {
    items,
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Delete without asking"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("reports.delete")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    if (input.items.length === 0) {
      return yield* new CliUsageError({
        message: 'What should be deleted? `infrawrench reports delete "<report>" -y`.',
      });
    }
    const org = yield* currentOrg;
    const [reports, folders] = yield* loadTree(org.id);
    const resolved = yield* resolveBulkItems(input.items, reports, folders);

    if (!input.yes) {
      if (!process.stdin.isTTY || session.output === "json") {
        return yield* new CliUsageError({
          message:
            "Refusing to delete without confirmation on a non-interactive run. Re-run with -y.",
        });
      }
      for (const item of resolved) {
        yield* Print.line(
          `  ${c.red("✗")} ${item.kind === "folder" ? c.dim("folder ") : ""}${safe(item.label)}`,
        );
      }
      yield* Print.line(
        c.dim(
          "Deleted reports lose their dashboard cards and delivery schedules; a deleted folder's other contents move to the top level.",
        ),
      );
      const ok = yield* confirm(
        `Delete these ${resolved.length} item(s) from ${safe(org.displayName)}?`,
      );
      if (!ok) return yield* Print.line(c.dim("Cancelled; nothing was changed."));
    }

    const sent = yield* sendBulk(org.id, {
      action: "delete",
      reportIds: resolved.filter((i) => i.kind === "report").map((i) => i.id),
      folderIds: resolved.filter((i) => i.kind === "folder").map((i) => i.id),
    });
    if (session.output === "json") {
      return yield* Print.json({
        ...(yield* spreadBody({ org: org.id }, sent.body, sent.path)),
        items: resolved,
      });
    }
    yield* Print.line(
      `Deleted ${sent.result.reports} report(s) and ${sent.result.folders} folder(s).`,
    );
  }),
).pipe(
  Command.withDescription("Delete reports and folders, all or nothing (asks first without -y)"),
);

const name = Argument.String("name|id").pipe(
  Argument.withDescription("The report (the words join into one name)"),
  Argument.variadic(),
);

/**
 * `infrawrench reports send <name|id>`: run the report and deliver it to
 * every one of its schedules right now. Behind an explicit verb like
 * `exports run`: this posts into somebody's channel and inbox, so it should
 * never happen because a positional was mistyped.
 */
const send = Command.make(
  "send",
  { name },
  Effect.fn("reports.send")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.name.join(" ").trim();
    if (!query) {
      return yield* new CliFailure({
        message: "Which report? `infrawrench reports send <name|id>`.",
      });
    }
    const org = yield* currentOrg;
    const { row: report } = yield* findReport(org.id, query);
    const id = encodeURIComponent(report.id);
    const schedules = yield* api.decode(Schedules, org.id, `/cost-reports/${id}/notifications`);
    if (schedules.length === 0) {
      return yield* new CliFailure({
        message: `"${report.name}" has no delivery schedules. Add one on the report's page (web or desktop) first.`,
      });
    }

    // Sequential, not parallel: each send re-runs the report server-side, and a
    // schedule-by-schedule transcript reads better than an interleaved one.
    const results: Array<{
      notification: ScheduleRow;
      result: typeof SendResult.Type;
      raw: Record<string, unknown>;
    }> = [];
    const failures: Array<{ notification: ScheduleRow; error: string }> = [];
    for (const notification of schedules) {
      const path = `/cost-reports/${id}/notifications/${encodeURIComponent(notification.id)}/send`;
      const sent = yield* attempt(
        api
          .json(org.id, path, { method: "POST" })
          .pipe(
            Effect.flatMap((body) =>
              Effect.all([decodeBody(SendResult, path)(body), spreadBody({}, body, path)]),
            ),
          ),
      );
      if (sent.ok) {
        results.push({ notification, result: sent.value[0], raw: sent.value[1] });
      } else {
        failures.push({ notification, error: sent.error });
      }
    }

    if (session.output === "json") {
      yield* Print.json({
        org: org.id,
        report: { id: report.id, name: report.name },
        sent: results.map((r) => ({ notificationId: r.notification.id, ...r.raw })),
        failed: failures.map((f) => ({ notificationId: f.notification.id, error: f.error })),
      });
      if (failures.length > 0 && results.length === 0) {
        return yield* new CliFailure({ message: "Every send failed." });
      }
      return;
    }

    yield* Print.line(`${c.bold(safe(report.name))} ${c.dim("· send now")}`);
    yield* Print.line();
    for (const { notification, result } of results) {
      yield* Print.line(
        `  ${c.green("✓")} ${describeSchedule(notification)} ${c.dim(
          `delivered to ${result.succeeded}/${result.attempted} destination(s)`,
        )}`,
      );
    }
    for (const { notification, error } of failures) {
      yield* Print.line(`  ${c.red("✗")} ${describeSchedule(notification)} ${c.dim(`(${error})`)}`);
    }
    if (failures.length > 0 && results.length === 0) {
      return yield* new CliFailure({ message: "Every send failed. See the errors above." });
    }
  }),
).pipe(Command.withDescription("Deliver a report to its schedules (Slack/Teams/email) right now"));

/**
 * `infrawrench reports anomalies [<name|id>]`: the reports that watch their
 * own scope for anomalies, with sensitivity, destinations and the latest
 * findings. Read-only: an alert names channels and inboxes, so it is set up
 * on the report page (or with Terraform), next to the destination picker.
 */
const anomalies = Command.make(
  "anomalies",
  { name },
  Effect.fn("reports.anomalies")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.decode(AnomalyAlerts, org.id, ANOMALY_ALERTS_PATH);
    const alerts = yield* decodePaired(
      Schema.Array(AnomalyAlert),
      ANOMALY_ALERTS_PATH,
    )(body.alerts);
    const query = input.name.join(" ").trim();
    let shown: ReadonlyArray<Paired<typeof AnomalyAlert.Type>> = alerts;
    if (query) {
      const { row: report } = yield* findReport(org.id, query);
      shown = alerts.filter((a) => a.row.reportId === report.id);
    }
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, alerts: shown.map((a) => a.raw) });
    }
    if (shown.length === 0) {
      return yield* Print.line(
        c.dim(
          query
            ? "This report has no anomaly alert. Set one up on the report's page."
            : "No report has an anomaly alert. Set one up on a report's page.",
        ),
      );
    }
    for (const { row: alert } of shown) {
      const kinds = [...new Set(alert.destinations.map((d) => safe(d.kind)))].join(", ") || "none";
      yield* Print.line(
        `${c.bold(safe(alert.reportName))} ${alert.enabled ? c.green("on") : c.dim("off")} ${c.dim(
          `· ${alert.sigmas}σ · floor ${(alert.minDeltaCents / 100).toLocaleString()}/day · to ${kinds}`,
        )}`,
      );
      if (alert.lastError) yield* Print.line(`  ${c.yellow("!")} ${c.dim(safe(alert.lastError))}`);
      if (alert.recent.length === 0) {
        yield* Print.line(c.dim("  no anomalies found"));
      } else {
        yield* Print.table(alert.recent.slice(0, 10), [
          { header: "day", value: (f) => f.day },
          {
            header: "spend",
            value: (f) => `${f.actual.toFixed(2)} ${safe(f.currency)}`,
            align: "right",
          },
          {
            header: "baseline/day",
            value: (f) => `${f.baseline.toFixed(2)} ${safe(f.currency)}`,
            align: "right",
          },
          { header: "sent", value: (f) => (f.notifiedAt ? "yes" : c.dim("no")) },
        ]);
      }
      yield* Print.line();
    }
  }),
).pipe(
  Command.withDescription(
    "Reports that watch their own scope for anomalies: sensitivity, floor, destinations, findings",
  ),
);

export const reports = Command.make(
  "reports",
  { name, format: pdfFormat("reports"), ...destination, ...costDisplay },
  Effect.fn("reports")(function* (input) {
    yield* requireCloud;
    // `infrawrench reports <name|id>` runs one and bare `reports` lists them:
    // a name is the point of the object, so the positional accepts either.
    const query = input.name.join(" ");
    if (query) return yield* runReport(query, input.format, destinationOf(input), input);
    if (input.format) {
      return yield* new CliFailure({
        message: "Which report? `infrawrench reports <name|id> --format pdf`.",
      });
    }
    yield* listReports();
  }),
).pipe(
  Command.withDescription(
    "The org's saved cost reports; give a name or id to run one and chart it (--format pdf saves it)",
  ),
  Command.withSubcommands([send, move, anomalies, remove]),
);
