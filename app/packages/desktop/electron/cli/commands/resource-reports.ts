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
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostReportFolder,
  ResourceReport,
  ResourceReportFilters,
  ResourceReportRowsResult,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { bestEffort, CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { destination, destinationOf, formatOf, writeOrPrint } from "../effect/file-flags";
import * as Print from "../effect/print";
import { limit, offset } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, type Paired, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, type Column, safe } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const LIST_PATH = "/resource-reports";
const FOLDERS_PATH = "/resource-reports/folders";

const TagFilter = Schema.Struct({
  source: knownOr(["tag", "virtual_tag"]),
  key: Schema.String,
  op: knownOr(["in", "not_in", "exists", "missing"]),
  values: Schema.Array(Schema.String),
});

// Whole: `resourceReportFilterCount` takes all of it.
const Filters = Schema.Struct({
  pluginIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
  resourceTypes: Schema.Array(
    Schema.Struct({ pluginId: Schema.String, resourceTypeId: Schema.String }),
  ),
  regions: Schema.Array(Schema.String),
  statuses: Schema.Array(Schema.String),
  tags: Schema.Array(TagFilter),
  nameContains: Schema.NullOr(Schema.String),
  createdFrom: Schema.NullOr(Schema.String),
  createdTo: Schema.NullOr(Schema.String),
});

const Report = wire<ResourceReport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    folderId: Schema.NullOr(Schema.String),
    config: Schema.Struct({ columns: Schema.Array(Schema.String), filters: Filters }),
  }),
);
type Report = typeof Report.Type;
const Reports = Schema.Array(Report);

// Whole: `costReportFolderPaths` takes all of it.
const Folders = wire<CostReportFolder[]>()(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      parentFolderId: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
);

const Money = Schema.Struct({ currency: Schema.String, amount: Schema.Finite });

const Rows = wire<ResourceReportRowsResult>()(
  Schema.Struct({
    columns: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: Schema.String,
        key: Schema.String,
        label: Schema.String,
      }),
    ),
    rows: Schema.Array(
      Schema.Struct({
        values: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
        costs: Schema.Record(Schema.String, Schema.Array(Money)),
      }),
    ),
    total: Schema.Finite,
    offset: Schema.Finite,
    limit: Schema.Finite,
    truncated: Schema.Boolean,
    sort: Schema.Struct({ column: Schema.String, direction: Schema.String }),
    cost: Schema.NullOr(
      Schema.Struct({
        available: Schema.Boolean,
        reason: Schema.NullOr(Schema.String),
        basis: Schema.String,
        windows: Schema.Array(
          Schema.Struct({ window: Schema.String, from: Schema.String, to: Schema.String }),
        ),
      }),
    ),
  }),
);
type Rows = typeof Rows.Type;

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Resource reports live in Infrawrench Cloud: their rows join the synced inventory with the cost store. Drop --local.",
    });
  }
});

function matchReport(
  reports: ReadonlyArray<Paired<Report>>,
  query: string,
): Paired<Report> | CliFailure {
  const needle = query.toLowerCase();
  const exact =
    reports.find((r) => r.row.id === query) ??
    reports.find((r) => r.row.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = reports.filter((r) => r.row.name.toLowerCase().includes(needle));
  const [only] = partial;
  if (only && partial.length === 1) return only;
  if (partial.length === 0) {
    return new CliFailure({
      message: `No resource report matches "${query}". Run \`infrawrench resource-reports\` to list them.`,
    });
  }
  return new CliFailure({
    message: `"${query}" matches ${partial.length} reports: ${partial
      .map((r) => r.row.name)
      .join(", ")}. Use the full name or the id.`,
  });
}

/** The filters as `resourceReportFilterCount` takes them; it reads only how many tags there are. */
const countableFilters = (f: Report["config"]["filters"]): ResourceReportFilters => ({
  pluginIds: [...f.pluginIds],
  accountIds: [...f.accountIds],
  resourceTypes: f.resourceTypes.map((t) => ({ ...t })),
  regions: [...f.regions],
  statuses: [...f.statuses],
  tags: f.tags.map((t) => ({
    key: t.key,
    values: [...t.values],
    source: t.source instanceof Unrecognized ? "tag" : t.source,
    op: t.op instanceof Unrecognized ? "in" : t.op,
  })),
  nameContains: f.nameContains,
  createdFrom: f.createdFrom,
  createdTo: f.createdTo,
});

const printList = Effect.fnUntraced(function* (
  org: { id: string; displayName: string },
  body: unknown,
  reports: ReadonlyArray<Report>,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  if (session.output === "json") return yield* Print.json({ org: org.id, reports: body });
  if (reports.length === 0) {
    return yield* Print.line(
      c.dim("No resource reports yet. Create one from the Resource reports tab."),
    );
  }
  // Folder names are a nicety: a caller who cannot list them still gets the list.
  const folders = yield* api
    .decode(Folders, org.id, FOLDERS_PATH)
    .pipe(bestEffort((): typeof Folders.Type => []));
  const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
  const paths = core.costReportFolderPaths(folders.map((f) => ({ ...f })));
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${reports.length} resource report${reports.length === 1 ? "" : "s"}`)}`,
  );
  yield* Print.line();
  const columns: Column<Report>[] = [
    { header: "report", value: (r) => safe(r.name) },
    {
      header: "folder",
      value: (r) => c.dim(safe(r.folderId ? (paths.get(r.folderId) ?? "") : "")),
    },
    { header: "columns", value: (r) => String(r.config.columns.length), align: "right" },
    {
      header: "filters",
      value: (r) => String(core.resourceReportFilterCount(countableFilters(r.config.filters))),
      align: "right",
    },
    { header: "id", value: (r) => c.dim(r.id) },
  ];
  yield* Print.table(reports, columns);
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "`infrawrench resource-reports <id|name>` runs one (--limit, --offset, --sort <column> [--desc], --format csv [--out file]).",
    ),
  );
});

const printRows = Effect.fnUntraced(function* (core: Core, report: Report, result: Rows) {
  yield* Print.line(c.bold(safe(report.name)));
  if (report.description) yield* Print.line(c.dim(safe(report.description)));
  if (result.cost) {
    if (!result.cost.available) {
      yield* Print.line(
        c.yellow(`Cost columns are empty: ${safe(result.cost.reason ?? "no cost data")}`),
      );
    } else {
      const range = result.cost.windows.find((w) => w.window === "range");
      if (range) {
        yield* Print.line(
          c.dim(`Accrued cost ${range.from} to ${range.to} (${safe(result.cost.basis)})`),
        );
      }
    }
  }
  yield* Print.line();
  type Row = Rows["rows"][number];
  const columns: Column<Row>[] = result.columns.map((col) => ({
    header: `${safe(col.label)}${result.sort.column === col.id ? (result.sort.direction === "asc" ? " ↑" : " ↓") : ""}`,
    value: (row: Row) => {
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
  yield* Print.table(result.rows, columns);
  yield* Print.line();
  const from = result.total === 0 ? 0 : result.offset + 1;
  const to = Math.min(result.offset + result.limit, result.total);
  yield* Print.line(
    c.dim(
      `${from}-${to} of ${result.truncated ? "at least " : ""}${result.total} resources` +
        (to < result.total ? `  (next page: --offset ${to})` : ""),
    ),
  );
});

export const resourceReports = Command.make(
  "resource-reports",
  {
    query: Argument.String("name|id").pipe(
      Argument.withDescription("A report to run (the words join into one name)"),
      Argument.variadic(),
    ),
    limit: limit.pipe(Flag.withDescription("Rows on the page")),
    offset: offset.pipe(Flag.withDescription("Rows to skip (the next page's offset)")),
    sort: Flag.String("sort").pipe(
      Flag.withMetavar("column"),
      Flag.withDescription("Sort by this column id"),
      Flag.optional,
    ),
    desc: Flag.Boolean("desc").pipe(
      Flag.withDescription("With --sort: descending"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    format: formatOf(["csv"], (got) => `--format must be csv for resource reports, got "${got}".`),
    ...destination,
  },
  Effect.fn("resource-reports")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, LIST_PATH);
    const reports = yield* decodePaired(Reports, LIST_PATH)(body);
    const query = input.query.join(" ").trim();

    if (!query) {
      return yield* printList(
        org,
        body,
        reports.map((r) => r.row),
      );
    }
    const matched = matchReport(reports, query);
    if (matched instanceof CliFailure) return yield* matched;
    const report = matched.row;
    const id = encodeURIComponent(report.id);

    if (Option.isSome(input.format)) {
      const csv = yield* api.text(org.id, `/resource-reports/${id}/csv`);
      return yield* writeOrPrint(destinationOf(input), csv);
    }

    const params = new URLSearchParams();
    if (Option.isSome(input.offset)) params.set("offset", String(input.offset.value));
    if (Option.isSome(input.limit)) params.set("limit", String(input.limit.value));
    if (Option.isSome(input.sort) && input.sort.value) {
      params.set("sort", input.sort.value);
      params.set("direction", input.desc ? "desc" : "asc");
    }
    const qs = params.toString();
    const path = `/resource-reports/${id}/rows${qs ? `?${qs}` : ""}`;
    const rowsBody = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(
        yield* spreadBody({ org: org.id, report: matched.raw }, rowsBody, path),
      );
    }
    const result = yield* decodeBody(Rows, path)(rowsBody);
    const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
    yield* printRows(core, report, result);
  }),
).pipe(
  Command.withDescription(
    "Saved inventory reports: synced resources with picked columns and cost (cloud only)",
  ),
);
