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
  CostExportInput,
  CostExportRunResult,
  CostExportWarehouseSetup,
  CostExportWarehouseSink,
  FocusExportRequest,
  FocusVersion,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { ExportsFlags, RangeFlags } from "../args";
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

/**
 * `s3://bucket/prefix`, `POST warehouse.acme.com/…a7f2` or `snowflake: DB.SCHEMA.TABLE`.
 * Restated from client-core's `describeCostExportDestination` because this
 * file imports client-core for types only (zero runtime dependencies).
 */
function describeDestination(exp: CostExport): string {
  const d = exp.destination;
  if (d.kind === "s3") return `s3://${d.bucket}/${d.prefix}`;
  if (d.kind === "http") return `${d.method} ${d.urlHint}`;
  const table = ["database", "catalog", "schema", "table"]
    .map((k) => d.target[k])
    .filter(Boolean)
    .join(".");
  return `${d.pluginId}: ${table}`;
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
        "No cost exports. An export writes your raw cost rows to a bucket, an HTTPS endpoint, or a Snowflake/Databricks table on a schedule — create one in Settings → Cost Exports, or `infrawrench exports create` for a table.",
      ),
    );
    return;
  }

  printTable(exports, [
    { header: "name", value: (e) => c.bold(e.name) },
    {
      header: "format",
      // `schema` is absent on a server older than FOCUS support, which only
      // ever wrote native columns. A warehouse export is a table, not a file.
      value: (e) =>
        c.dim(
          e.destination.kind === "warehouse"
            ? "table"
            : e.schema && e.schema !== "native"
              ? `${e.format} · FOCUS ${e.schema.replace(/^focus-/, "")}`
              : e.format,
        ),
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
  // Same name-or-id matcher the reports command uses: a name is the point of
  // the object, and two objects should not disagree about how to find one.
  const exp = await findExport(org.id, query);

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
    ...(exp.destination.kind === "warehouse"
      ? []
      : [
          {
            header: "bytes",
            value: (o: CostExportRunResult["objects"][number]) => o.byteCount.toLocaleString(),
            align: "right" as const,
          },
        ]),
    {
      header: exp.destination.kind === "warehouse" ? "table" : "key",
      value: (o) => c.dim(o.key),
    },
  ]);
}

/**
 * `infrawrench export --format focus [<report name|id>]`: the rows a cost query
 * selects, as a FOCUS CSV (1.4 unless `--focus-version 1.3`), written to stdout
 * or `--out <file>`.
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
  focusVersion: string | undefined,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  // Dynamic, like the other client-core helpers the CLI uses, so the CLI
  // still takes no new runtime dependency.
  const { focusExportRequestForConfig, focusExportFilename, FOCUS_VERSIONS, FOCUS_LATEST_VERSION } =
    await import("@infrawrench/client-core");
  const version = (focusVersion ?? FOCUS_LATEST_VERSION) as FocusVersion;
  if (!FOCUS_VERSIONS.includes(version)) {
    throw new CliError(
      `--focus-version: "${focusVersion}" is not a FOCUS version this server writes. Use ${FOCUS_VERSIONS.join(" or ")}.`,
      2,
    );
  }

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
    version,
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

  const summary = `FOCUS ${version} · ${rowCount.toLocaleString()} rows · ${request.from} → ${request.to}`;
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

/** The org's export by name or id, or a CliError naming the candidates. */
async function findExport(orgId: string, query: string): Promise<CostExport> {
  const exports = await orgFetch<CostExport[]>(orgId, "/cost-exports");
  const found = matchCostReport(exports, query);
  if (found.match) return found.match;
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

async function fetchSinks(orgId: string): Promise<CostExportWarehouseSink[]> {
  return (
    await orgFetch<{ sinks: CostExportWarehouseSink[] }>(orgId, "/cost-exports/warehouse-sinks")
  ).sinks;
}

/** `infrawrench exports warehouses`: the warehouse destination types and your accounts of each. */
export async function cmdExportWarehouses(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const sinks = await fetchSinks(org.id);
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, sinks });
    return;
  }
  println(`${c.bold(org.displayName)} ${c.dim("· warehouse destinations for cost exports")}`);
  println();
  for (const sink of sinks) {
    println(`${c.bold(sink.label)} ${c.dim(`(--plugin ${sink.pluginId})`)}`);
    if (sink.accounts.length === 0) {
      println(c.dim(`  No ${sink.displayName} account connected. Add one first.`));
    } else {
      for (const a of sink.accounts) println(`  ${a.name} ${c.dim(a.id)}`);
    }
    for (const f of sink.targetFields) {
      const notes = [
        f.optional ? "optional" : "required",
        f.allowCustom ? "new names allowed" : null,
      ]
        .filter(Boolean)
        .join(", ");
      println(c.dim(`  --target ${f.key}=<${f.label.toLowerCase()}>  (${notes})`));
    }
    println();
  }
  println(
    c.dim(
      "Create one with `infrawrench exports create --name <n> --plugin <id> -a <account> --target key=value ...`.",
    ),
  );
}

/** Split `key=value` pairs, refusing anything else by name. */
function parseTargets(pairs: string[]): Record<string, string> {
  const target: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`--target takes key=value, got "${pair}"`, 2);
    target[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return target;
}

const CADENCES = ["daily", "weekly", "monthly"] as const;
const DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "charge_type",
  "commitment",
] as const;

/**
 * `infrawrench exports create`: a warehouse export. S3 and HTTPS exports take
 * a secret, which belongs in the settings form rather than in shell history,
 * so only warehouse destinations (which borrow a connected account's
 * credentials) are created here.
 */
export async function cmdCreateWarehouseExport(
  ctx: CliContext,
  flags: ExportsFlags,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const name = flags.name?.trim();
  if (!name) throw new CliError("Name the export: `--name <name>`.", 2);
  const sinks = await fetchSinks(org.id);
  const sink = sinks.find((s) => s.pluginId === flags.plugin);
  if (!sink) {
    throw new CliError(
      `--plugin must be one of: ${sinks.map((s) => s.pluginId).join(", ") || "(none available)"}`,
      2,
    );
  }
  const accountQuery = ctx.flags.account?.trim() ?? "";
  const account =
    sink.accounts.find((a) => a.id === accountQuery) ??
    sink.accounts.find((a) => a.name.toLowerCase() === accountQuery.toLowerCase()) ??
    (accountQuery === "" && sink.accounts.length === 1 ? sink.accounts[0] : undefined);
  if (!account) {
    throw new CliError(
      sink.accounts.length === 0
        ? `No ${sink.displayName} account is connected. Add one first.`
        : `Which ${sink.displayName} account? -a <name|id>, one of: ${sink.accounts.map((a) => a.name).join(", ")}`,
      2,
    );
  }
  const target = parseTargets(flags.target);
  const known = new Set(sink.targetFields.map((f) => f.key));
  for (const key of Object.keys(target)) {
    if (!known.has(key)) {
      throw new CliError(
        `${sink.displayName} has no target field "${key}". Fields: ${[...known].join(", ")}`,
        2,
      );
    }
  }
  const missing = sink.targetFields.filter((f) => !f.optional && !target[f.key]);
  if (missing.length > 0) {
    throw new CliError(
      `Missing ${missing.map((f) => `--target ${f.key}=…`).join(", ")}. \`infrawrench exports warehouses\` lists them.`,
      2,
    );
  }
  const cadence = flags.cadence ?? "daily";
  if (!(CADENCES as readonly string[]).includes(cadence)) {
    throw new CliError(`--cadence must be one of: ${CADENCES.join(", ")}`, 2);
  }
  const dimensions = (flags.dimensions ?? "provider,account,service,region")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  for (const d of dimensions) {
    if (!(DIMENSIONS as readonly string[]).includes(d)) {
      throw new CliError(`--dimensions: unknown column "${d}". Use ${DIMENSIONS.join(", ")}`, 2);
    }
  }

  const input: CostExportInput = {
    name,
    format: "csv",
    query: {
      version: 1,
      dimensions: dimensions as CostExportInput["query"]["dimensions"],
      tagKeys: [],
      filters: [],
    },
    cadence: cadence as CostExportInput["cadence"],
    hour: flags.hour ?? 4,
    timezone: flags.timezone ?? "UTC",
    restatementDays: flags.restatementDays ?? 7,
    enabled: true,
    destination: { kind: "warehouse", pluginId: sink.pluginId, accountId: account.id, target },
  };
  const created = await orgFetch<CostExport>(org.id, "/cost-exports", {
    method: "POST",
    body: JSON.stringify(input),
  });

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, export: created });
    return;
  }
  println(`${c.green("✓")} ${c.bold(created.name)} ${c.dim(`· ${describeDestination(created)}`)}`);
  println(
    c.dim(`${describeSchedule(created)} · ${created.restatementDays}-day restatement window`),
  );
  println();
  println(
    c.dim(
      "Grant the account access with `infrawrench exports setup " +
        JSON.stringify(created.name) +
        "`, then test it with `infrawrench exports run`.",
    ),
  );
}

/** `infrawrench exports setup <name|id>`: the GRANT statements a warehouse export needs. */
export async function cmdExportSetup(ctx: CliContext, query: string): Promise<void> {
  requireCloud(ctx);
  if (!query.trim()) throw new CliError("Which export? `infrawrench exports setup <name|id>`");
  const org = await resolveOrg(ctx);
  const exp = await findExport(org.id, query);
  if (exp.destination.kind !== "warehouse") {
    throw new CliError(
      `"${exp.name}" writes to ${describeDestination(exp)}, not a warehouse table.`,
    );
  }
  const setup = await orgFetch<CostExportWarehouseSetup>(org.id, "/cost-exports/warehouse-setup", {
    method: "POST",
    body: JSON.stringify({ accountId: exp.destination.accountId, target: exp.destination.target }),
  });
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, export: exp.id, ...setup });
    return;
  }
  println(setup.sql);
  if (setup.notes.length > 0) {
    println();
    for (const note of setup.notes) println(c.dim(`• ${note}`));
  }
}
