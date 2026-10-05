// `infrawrench exports`: the org's scheduled cost exports, and running one.
//
// A scheduled export is a nightly job whose failure is invisible until someone
// asks the warehouse why last week is missing, which makes it exactly the kind
// of thing a terminal should be able to check: `infrawrench exports` prints the
// last run's status and error for every export, and `infrawrench exports run
// <name|id>` forces one from a shell or a CI step.
//
// The wire types come from `@infrawrench/client-core` (the same definitions
// the API and the settings UI use) so a server-side change breaks this file's
// build instead of its output. The import is type-only, so the CLI still ships
// zero new runtime dependencies.
import { writeFileSync } from "node:fs";
import { CliError, orgFetch, orgFetchText, resolveOrg, type CliContext } from "../context";
import type {
  CostExport,
  CostExportRunResult,
  FocusExportRequest,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { resolveDateRange } from "../args";
import { matchCostReport } from "../format";
import { c, printErr, printJson, println, printTable } from "../output";
import { parseChargeTypes, parseWhere, resolveSavedFilterFlag } from "./costs";
import { resolveReport } from "./reports";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Cost exports live in Infrawrench Cloud — there is no local cost history to export.",
    );
  }
}

/** `s3://bucket/prefix` or `POST warehouse.acme.com/…a7f2`. */
function describeDestination(exp: CostExport): string {
  return exp.destination.kind === "s3"
    ? `s3://${exp.destination.bucket}/${exp.destination.prefix}`
    : `${exp.destination.method} ${exp.destination.urlHint}`;
}

/** `daily 04:00 Europe/Berlin`: how the schedule reads. */
function describeSchedule(exp: CostExport): string {
  return `${exp.cadence} ${String(exp.hour).padStart(2, "0")}:00 ${exp.timezone}`;
}

/**
 * The status column, coloured. A failing export is the reason to run this
 * command at all, so the failure gets the row's colour and its message gets a
 * line of its own below the table rather than being truncated into a cell.
 */
function statusCell(exp: CostExport): string {
  if (!exp.enabled) return c.dim("paused");
  switch (exp.lastStatus) {
    case "failed":
      return c.red("failed");
    case "succeeded":
      return c.green(
        `${exp.lastObjectCount ?? 0} obj · ${(exp.lastRowCount ?? 0).toLocaleString()} rows`,
      );
    default:
      return c.dim("never run");
  }
}

/** `infrawrench exports`: list the org's scheduled cost exports. */
export async function cmdExports(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const exports = await orgFetch<CostExport[]>(org.id, "/cost-exports");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, exports });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· scheduled cost exports")}`);
  println();

  if (exports.length === 0) {
    println(
      c.dim(
        "No cost exports. An export writes your raw cost rows to a bucket or HTTPS endpoint on a schedule — create one in Settings → Cost Exports.",
      ),
    );
    return;
  }

  printTable(exports, [
    { header: "name", value: (e) => c.bold(e.name) },
    {
      header: "format",
      // `schema` is absent on a server older than FOCUS support, which only
      // ever wrote native columns.
      value: (e) => c.dim(e.schema === "focus-1.3" ? `${e.format} · FOCUS 1.3` : e.format),
    },
    { header: "schedule", value: (e) => c.dim(describeSchedule(e)) },
    { header: "destination", value: (e) => c.dim(describeDestination(e)) },
    { header: "last run", value: (e) => statusCell(e) },
  ]);

  // Errors below the table, in full. A truncated cause is a cause nobody can
  // act on, and this is the whole reason the command exists.
  const failing = exports.filter((e) => e.lastStatus === "failed" && e.lastError);
  if (failing.length > 0) {
    println();
    for (const exp of failing) {
      println(`${c.red("✗")} ${c.bold(exp.name)}: ${exp.lastError}`);
    }
  }

  const stale = exports.filter(
    (e) => e.enabled && e.lastStatus !== "failed" && e.restatementDays === 0,
  );
  if (stale.length > 0) {
    println();
    println(
      c.dim(
        "Note: exports with a 0-day restatement window never revisit a period. Provider spend is restated for days after the fact, so those objects will drift from the invoice.",
      ),
    );
  }

  println();
  println(c.dim("Run one now with `infrawrench exports run <name|id>`."));
}

/** `infrawrench exports run <name|id>`: force a run and print what it wrote. */
export async function cmdRunExport(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  if (!query.trim()) {
    throw new CliError("Which export? `infrawrench exports run <name|id>`");
  }
  const org = await resolveOrg(ctx);
  const exports = await orgFetch<CostExport[]>(org.id, "/cost-exports");

  // Same name-or-id matcher the reports command uses: a name is the point of
  // the object, and two objects should not disagree about how to find one.
  const found = matchCostReport(exports, query);
  if (!found.match) {
    if (found.candidates.length === 0) {
      throw new CliError(
        `No cost export matches "${query}". Run \`infrawrench exports\` to see them.`,
      );
    }
    throw new CliError(
      `"${query}" matches ${found.candidates.length} exports: ${found.candidates
        .map((e) => e.name)
        .join(", ")}. Use the full name or the id.`,
    );
  }
  const exp = found.match;

  const run = await orgFetch<CostExportRunResult>(
    org.id,
    `/cost-exports/${encodeURIComponent(exp.id)}/run`,
    { method: "POST" },
  );

  // A failed run is a failed command: a CI step that shells out to this has
  // to be able to notice. The JSON body is still printed first, on stdout, so
  // `--json` output stays parseable either way; the message goes to stderr.
  const failure = new CliError(`Export "${exp.name}" failed: ${run.error ?? "unknown error"}`);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, export: exp, ...run });
    if (run.status === "failed") throw failure;
    return;
  }

  if (run.status === "failed") throw failure;

  println(
    `${c.green("✓")} ${c.bold(exp.name)} ${c.dim(
      `· ${run.objects.length} object(s) · ${run.rowCount.toLocaleString()} rows`,
    )}`,
  );
  if (run.collectionWatermark) {
    println(
      c.dim(
        `Collection watermark ${run.collectionWatermark} — periods ending after it are still moving.`,
      ),
    );
  }
  println();

  printTable(run.objects, [
    { header: "period", value: (o) => o.periodStart },
    { header: "days", value: (o) => c.dim(`${o.from} → ${o.to}`) },
    { header: "rows", value: (o) => o.rowCount.toLocaleString(), align: "right" },
    { header: "bytes", value: (o) => o.byteCount.toLocaleString(), align: "right" },
    { header: "key", value: (o) => c.dim(o.key) },
  ]);
}

/**
 * `infrawrench export --format focus [<report name|id>]`: the rows a cost query
 * selects, as a FOCUS 1.3 CSV, written to stdout or `--out <file>`.
 *
 * The range and filter flags are the `costs` command's (`--last`, `--from`,
 * `--to`, `--where`, `--filter`, `--charge-type`) so a file and the chart it
 * explains select the same rows. Naming a saved report starts from that
 * report's range and filters; explicit range flags then override its range,
 * and `--where` adds to its filters.
 *
 * The CSV is the only thing on stdout, so `> focus.csv` captures a clean file;
 * the summary goes to stderr. `--json` wraps the body with the request that
 * produced it, for scripts that want both.
 */
export async function cmdExportFocus(
  ctx: CliContext,
  range: RangeFlags,
  reportQuery: string,
  out: string | undefined,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  // Dynamic, like the other client-core helpers the CLI uses, so the CLI
  // still takes no new runtime dependency.
  const { focusExportRequestForConfig, focusExportFilename } =
    await import("@infrawrench/client-core");

  const report = reportQuery.trim() ? await resolveReport(org.id, reportQuery.trim()) : null;
  const base: FocusExportRequest = report
    ? focusExportRequestForConfig(report.config)
    : { ...resolveDateRange(range), filters: [] };
  // Explicit range flags win over a report's own range: "this report, but for
  // last quarter" is the reason to name a report and a range together.
  const explicitRange = range.last || range.from || range.to ? resolveDateRange(range) : null;

  const where = await parseWhere(range.where);
  const savedFilter = await resolveSavedFilterFlag(org.id, range.filter);
  if (savedFilter && base.savedFilterId && savedFilter.id !== base.savedFilterId) {
    throw new CliError(
      `--filter: "${report?.name ?? ""}" already applies a saved filter, and a request carries one. ` +
        "Use --where to narrow it further.",
      2,
    );
  }
  const chargeTypes = parseChargeTypes(range.chargeTypes);

  const request: FocusExportRequest = {
    ...base,
    ...(explicitRange ?? {}),
    filters: [...(base.filters ?? []), ...where],
    ...(savedFilter ? { savedFilterId: savedFilter.id } : {}),
    ...(chargeTypes.length > 0 ? { chargeTypes } : {}),
  };

  const csv = await orgFetchText(org.id, "/costs/focus-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  // Header line excluded. Counts lines, so a tag value with an embedded
  // newline would overcount; it only feeds the summary below.
  const rowCount = Math.max(0, csv.split("\n").filter((line) => line !== "").length - 1);

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      report: report ? { id: report.id, name: report.name } : null,
      request,
      rowCount,
      csv,
    });
    return;
  }

  const summary = `FOCUS 1.3 · ${rowCount.toLocaleString()} rows · ${request.from} → ${request.to}`;
  if (out) {
    writeFileSync(out, csv, "utf8");
    printErr(`${c.green("✓")} ${c.bold(out)} ${c.dim(`· ${summary}`)}`);
    return;
  }

  process.stdout.write(csv);
  printErr(
    c.dim(
      process.stdout.isTTY
        ? `${summary}. Redirect to a file, or pass --out ${focusExportFilename(request, report?.name ?? "")}.`
        : summary,
    ),
  );
}
