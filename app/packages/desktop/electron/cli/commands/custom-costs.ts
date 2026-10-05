// Custom cost sources from the terminal: `infrawrench costs sources` lists them
// (and one source's upload history), and `infrawrench costs push --format
// csv|focus` uploads a file into one.
//
// The file is parsed here by the same `@infrawrench/client-core` module the
// Settings page uses (a runtime `await import`, bundled into the main process
// per `electron.vite.config.ts`), so a CSV maps identically from either place
// and the server only ever receives aggregated daily rows.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CustomCostRow,
  CustomCostSource,
  CustomCostUpload,
  DateFormat,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { PushFlags } from "../args";
import { c, formatMoney, printErr, printJson, println, printTable } from "../output";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError("Cost data lives in Infrawrench Cloud. There is no local cost history.");
  }
}

function formatTotals(totals: Record<string, number>): string {
  const parts = Object.entries(totals).map(([currency, amount]) => formatMoney(amount, currency));
  return parts.length > 0 ? parts.join(" + ") : "-";
}

/** Find a source by id or (case-insensitive) name. */
export function findCustomSource(
  sources: CustomCostSource[],
  ref: string,
): CustomCostSource | undefined {
  const lower = ref.toLowerCase();
  return sources.find((s) => s.id === ref) ?? sources.find((s) => s.name.toLowerCase() === lower);
}

/** `infrawrench costs sources [<name|id>]` */
export async function cmdCostSources(ctx: CliContext, ref: string): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const sources = await orgFetch<CustomCostSource[]>(org.id, "/custom-cost-sources");

  if (!ref) {
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, sources });
      return;
    }
    if (sources.length === 0) {
      println(
        c.dim(
          "No custom cost sources. Create one under Settings → Custom Cost Sources, then " +
            "`infrawrench costs push --source <name> --format csv --file bill.csv`.",
        ),
      );
      return;
    }
    printTable(sources, [
      { header: "Name", value: (s) => s.name },
      { header: "Uploads", value: (s) => String(s.uploadCount), align: "right" },
      {
        header: "Last upload",
        value: (s) => (s.lastUploadAt ? s.lastUploadAt.slice(0, 10) : c.dim("never")),
      },
      { header: "Currency", value: (s) => s.defaultCurrency ?? c.dim("from file") },
      { header: "Provider id", value: (s) => c.dim(s.pluginId) },
    ]);
    return;
  }

  const source = findCustomSource(sources, ref);
  if (!source) throw new CliError(`No custom cost source "${ref}".`, 2);
  const uploads = await orgFetch<CustomCostUpload[]>(
    org.id,
    `/custom-cost-sources/${encodeURIComponent(source.id)}/uploads`,
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, source, uploads });
    return;
  }
  println(`${c.bold(source.name)} ${c.dim(`· ${uploads.length} upload(s)`)}`);
  printTable(uploads, [
    { header: "Uploaded", value: (u) => u.createdAt.slice(0, 16).replace("T", " ") },
    { header: "By", value: (u) => u.uploadedBy?.name ?? u.uploadedBy?.email ?? c.dim("-") },
    { header: "File", value: (u) => u.fileName ?? c.dim(u.format) },
    { header: "Dates", value: (u) => `${u.fromDate} → ${u.toDate}` },
    { header: "Rows", value: (u) => String(u.rowCount), align: "right" },
    { header: "Total", value: (u) => formatTotals(u.totals), align: "right" },
    {
      header: "Status",
      value: (u) =>
        u.status === "complete"
          ? c.green("complete")
          : u.status === "replaced"
            ? c.dim("replaced")
            : c.yellow("incomplete"),
    },
  ]);
}

/**
 * Upload rows (parsed from a CSV/FOCUS file, or a JSON array) into a custom
 * source, refusing an overlapping range unless `--replace` or `--append` says
 * which is meant.
 */
export async function pushToCustomSource(
  ctx: CliContext,
  orgId: string,
  source: CustomCostSource,
  input: { text: string; format: "csv" | "focus" | "rows"; rows?: unknown[] },
  flags: PushFlags,
): Promise<void> {
  const core = await import("@infrawrench/client-core");
  let rows: CustomCostRow[];
  if (input.format === "rows") {
    rows = (input.rows ?? []) as CustomCostRow[];
  } else {
    const table = core.parseCsv(input.text);
    if (table.headers.length === 0) throw new CliError("The file has no header row.", 2);
    let plan: Parameters<typeof core.buildCustomCostRows>[1];
    if (input.format === "focus") {
      if (!core.isFocusHeader(table.headers)) {
        throw new CliError(
          "That isn't a FOCUS file: it needs BilledCost, ChargePeriodStart and BillingCurrency " +
            "columns. Use --format csv to map its columns instead.",
          2,
        );
      }
      plan = { format: "focus" };
    } else {
      let mapping;
      try {
        mapping = core.applyCsvMappingOverrides(
          table.headers,
          core.detectCsvMapping(table.headers),
          flags.map,
        );
      } catch (e) {
        throw new CliError(e instanceof Error ? e.message : String(e), 2);
      }
      const dateFormat = flags.dateFormat ?? "auto";
      if (!["auto", "ymd", "mdy", "dmy"].includes(dateFormat)) {
        throw new CliError("--date-format must be ymd, mdy or dmy.", 2);
      }
      plan = { format: "csv", mapping, dateFormat: dateFormat as DateFormat };
      if (mapping.date === null || mapping.cost === null) {
        throw new CliError(
          `Couldn't find the ${mapping.date === null ? "date" : "cost"} column. Map it with ` +
            `--map ${mapping.date === null ? "date" : "cost"}=<column> (columns: ${table.headers.join(", ")}).`,
          2,
        );
      }
    }
    const result = core.buildCustomCostRows(table, plan, {
      defaultCurrency: flags.currency ?? source.defaultCurrency,
    });
    if (result.ambiguousDates && !flags.dateFormat) {
      throw new CliError(
        "The dates could be month-first or day-first. Pass --date-format mdy or --date-format dmy.",
        2,
      );
    }
    if (result.errorCount > 0) {
      for (const err of result.errors.slice(0, 10)) printErr(`line ${err.line}: ${err.message}`);
      printErr(
        `${c.yellow("!")} ${result.errorCount} of ${result.lineCount} line(s) skipped` +
          (result.errorCount > 10 ? " (first 10 shown)" : ""),
      );
    }
    rows = result.rows;
  }
  if (rows.length === 0) throw new CliError("Nothing to upload: no valid rows.", 2);

  const base = `/custom-cost-sources/${encodeURIComponent(source.id)}`;
  const summary = core.summarizeCustomCostRows(rows);
  if (!flags.mode && summary.fromDate && summary.toDate) {
    const uploads = await orgFetch<CustomCostUpload[]>(orgId, `${base}/uploads`);
    const overlapping = core.overlappingCustomCostUploads(
      uploads,
      summary.fromDate,
      summary.toDate,
    );
    if (overlapping.length > 0) {
      for (const u of overlapping) {
        printErr(
          `  ${u.fileName ?? u.format}  ${u.fromDate} → ${u.toDate}  ${formatTotals(u.totals)}`,
        );
      }
      throw new CliError(
        `${summary.fromDate} → ${summary.toDate} overlaps ${overlapping.length} earlier upload(s) ` +
          `of "${source.name}". Pass --replace to supersede that spend or --append to add to it.`,
        2,
      );
    }
  }

  const upload = await core.uploadCustomCostRows({
    transport: {
      post: (path, body) => orgFetch(orgId, path, { method: "POST", body: JSON.stringify(body) }),
    },
    basePath: base,
    rows,
    format: input.format,
    fileName: flags.file ? flags.file.split(/[\\/]/).pop() : null,
    mode: flags.mode ?? "append",
    via: "cli",
  });

  if (ctx.flags.output === "json") {
    printJson(upload);
    return;
  }
  println(
    `${c.green("✓")} uploaded ${upload.rowCount} daily row${upload.rowCount === 1 ? "" : "s"} ` +
      `to ${c.bold(source.name)} ${c.dim(`(${upload.fromDate} → ${upload.toDate}, ${formatTotals(upload.totals)})`)}`,
  );
}
