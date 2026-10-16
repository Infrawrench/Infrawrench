// `infrawrench resource-reports`: saved inventory reports, and
// `infrawrench resource-reports <id|name>` to run one: a page of its rows with
// their tag and cost columns, or the whole thing as CSV with `--format csv`.
//
// Cloud-only: a report's rows are a server-side join of the synced inventory
// with the cost store. The CLI reads and runs; building a report (the column
// and filter pickers) lives on the web/desktop Resource reports tab.
//
// Types come from `@infrawrench/client-core` type-only; the pure helpers are
// loaded with a dynamic import, the main project's rule for client-core
// runtime code. Zero new runtime dependencies.
import { writeFileSync } from "node:fs";
import { CliError, orgFetch, orgFetchText, resolveOrg, type CliContext } from "../context";
import type {
  CostReportFolder,
  ResourceReport,
  ResourceReportRow,
  ResourceReportRowsResult,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

export interface ResourceReportFlags {
  limit?: number | undefined;
  offset?: number | undefined;
  sort?: string | undefined;
  desc?: boolean | undefined;
  /** `csv` exports every row; anything else is refused. */
  format?: string | undefined;
  /** Where `--format csv` writes; stdout when omitted. */
  out?: string | undefined;
}

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Resource reports live in Infrawrench Cloud: their rows join the synced inventory with the cost store. Drop --local.",
    );
  }
}

function matchReport(reports: ResourceReport[], query: string): ResourceReport {
  const needle = query.toLowerCase();
  const exact =
    reports.find((r) => r.id === query) ?? reports.find((r) => r.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = reports.filter((r) => r.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) {
    throw new CliError(
      `No resource report matches "${query}". Run \`infrawrench resource-reports\` to list them.`,
    );
  }
  throw new CliError(
    `"${query}" matches ${partial.length} reports: ${partial
      .map((r) => r.name)
      .join(", ")}. Use the full name or the id.`,
  );
}

export async function cmdResourceReports(
  ctx: CliContext,
  args: string[],
  flags: ResourceReportFlags,
): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const reports = await orgFetch<ResourceReport[]>(org.id, "/resource-reports");
  const query = args.join(" ").trim();

  if (!query) {
    await printList(ctx, org, reports);
    return;
  }
  const report = matchReport(reports, query);

  if (flags.format !== undefined) {
    if (flags.format !== "csv") {
      throw new CliError(`--format must be csv for resource reports, got "${flags.format}".`, 2);
    }
    const csv = await orgFetchText(
      org.id,
      `/resource-reports/${encodeURIComponent(report.id)}/csv`,
    );
    if (flags.out) {
      writeFileSync(flags.out, csv);
      println(c.dim(`Wrote ${flags.out}`));
    } else {
      process.stdout.write(csv);
    }
    return;
  }

  const params = new URLSearchParams();
  if (flags.offset !== undefined) params.set("offset", String(flags.offset));
  if (flags.limit !== undefined) params.set("limit", String(flags.limit));
  if (flags.sort) {
    params.set("sort", flags.sort);
    params.set("direction", flags.desc ? "desc" : "asc");
  }
  const qs = params.toString();
  const result = await orgFetch<ResourceReportRowsResult>(
    org.id,
    `/resource-reports/${encodeURIComponent(report.id)}/rows${qs ? `?${qs}` : ""}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, report, ...result });
    return;
  }
  const core: Core = await import("@infrawrench/client-core");
  printRows(core, report, result);
}

async function printList(
  ctx: CliContext,
  org: { id: string; displayName: string },
  reports: ResourceReport[],
): Promise<void> {
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, reports });
    return;
  }
  if (reports.length === 0) {
    println(c.dim("No resource reports yet. Create one from the Resource reports tab."));
    return;
  }
  // Folder names are a nicety: a caller who cannot list them still gets the list.
  const folders = await orgFetch<CostReportFolder[]>(org.id, "/resource-reports/folders").catch(
    () => [] as CostReportFolder[],
  );
  const core: Core = await import("@infrawrench/client-core");
  const paths = core.costReportFolderPaths(folders);
  println(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${reports.length} resource report${reports.length === 1 ? "" : "s"}`)}`,
  );
  println();
  const columns: Column<ResourceReport>[] = [
    { header: "report", value: (r) => safe(r.name) },
    {
      header: "folder",
      value: (r) => c.dim(safe(r.folderId ? (paths.get(r.folderId) ?? "") : "")),
    },
    { header: "columns", value: (r) => String(r.config.columns.length), align: "right" },
    {
      header: "filters",
      value: (r) => String(core.resourceReportFilterCount(r.config.filters)),
      align: "right",
    },
    { header: "id", value: (r) => c.dim(r.id) },
  ];
  printTable(reports, columns);
  println();
  println(
    c.dim(
      "`infrawrench resource-reports <id|name>` runs one (--limit, --offset, --sort <column> [--desc], --format csv [--out file]).",
    ),
  );
}

function printRows(core: Core, report: ResourceReport, result: ResourceReportRowsResult): void {
  println(c.bold(safe(report.name)));
  if (report.description) println(c.dim(safe(report.description)));
  if (result.cost) {
    if (!result.cost.available) {
      println(c.yellow(`Cost columns are empty: ${result.cost.reason ?? "no cost data"}`));
    } else {
      const range = result.cost.windows.find((w) => w.window === "range");
      if (range) {
        println(c.dim(`Accrued cost ${range.from} to ${range.to} (${result.cost.basis})`));
      }
    }
  }
  println();
  const columns: Column<ResourceReportRow>[] = result.columns.map((col) => ({
    header: `${col.label}${result.sort.column === col.id ? (result.sort.direction === "asc" ? " ↑" : " ↓") : ""}`,
    value: (row: ResourceReportRow) => {
      if (col.kind === "cost") {
        const cell = row.costs[col.id] ?? [];
        return cell.length === 0 ? c.dim("-") : core.resourceReportMoneyText(cell);
      }
      const text = row.values[col.id];
      if (!text) return c.dim("-");
      const shown = col.kind === "core" && col.key === "created" ? text.slice(0, 10) : text;
      return safe(shown.length > 60 ? `${shown.slice(0, 59)}…` : shown);
    },
    ...(col.kind === "cost" ? { align: "right" as const } : {}),
  }));
  printTable(result.rows, columns);
  println();
  const from = result.total === 0 ? 0 : result.offset + 1;
  const to = Math.min(result.offset + result.limit, result.total);
  println(
    c.dim(
      `${from}-${to} of ${result.truncated ? "at least " : ""}${result.total} resources` +
        (to < result.total ? `  (next page: --offset ${to})` : ""),
    ),
  );
}
