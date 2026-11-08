// Custom cost sources from the terminal: `infrawrench costs sources` lists them
// (and one source's upload history), and `infrawrench costs push --format
// csv|focus` uploads a file into one.
//
// The file is parsed here by the same `@infrawrench/client-core` module the
// Settings page uses (a runtime `await import`, bundled into the main process
// per `electron.vite.config.ts`), so a CSV maps identically from either place
// and the server only ever receives aggregated daily rows.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  CustomCostRow,
  CustomCostSource,
  CustomCostUpload,
  DateFormat,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { decodePaired, type Paired, wire } from "../effect/wire";
import { c, formatMoney, safe } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

export const LOCAL_REFUSAL =
  "Cost data lives in Infrawrench Cloud. There is no local cost history.";

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) return yield* new CliFailure({ message: LOCAL_REFUSAL });
});

const usage = (message: string) => new CliUsageError({ message });

export const SOURCES_PATH = "/custom-cost-sources";

export const Source = wire<CustomCostSource>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    defaultCurrency: Schema.NullOr(Schema.String),
    pluginId: Schema.String,
    uploadCount: Schema.Finite,
    lastUploadAt: Schema.NullOr(Schema.String),
  }),
);
export type Source = typeof Source.Type;
export const Sources = Schema.Array(Source);

const Upload = wire<CustomCostUpload>()(
  Schema.Struct({
    id: Schema.String,
    fileName: Schema.NullOr(Schema.String),
    format: Schema.String,
    status: Schema.String,
    fromDate: Schema.String,
    toDate: Schema.String,
    rowCount: Schema.Finite,
    totals: Schema.Record(Schema.String, Schema.Finite),
    uploadedBy: Schema.NullOr(
      Schema.Struct({ name: Schema.NullOr(Schema.String), email: Schema.NullOr(Schema.String) }),
    ),
    createdAt: Schema.String,
  }),
);
type Upload = typeof Upload.Type;

function formatTotals(totals: Readonly<Record<string, number>>): string {
  const parts = Object.entries(totals).map(([currency, amount]) => formatMoney(amount, currency));
  return parts.length > 0 ? parts.join(" + ") : "-";
}

/** Find a source by id or (case-insensitive) name. */
export function findCustomSource<S extends { readonly id: string; readonly name: string }>(
  sources: ReadonlyArray<S>,
  ref: string,
): S | undefined {
  const lower = ref.toLowerCase();
  return sources.find((s) => s.id === ref) ?? sources.find((s) => s.name.toLowerCase() === lower);
}

/** `infrawrench costs sources [<name|id>]` */
export const costSources = Command.make(
  "sources",
  {
    name: Argument.String("name|id").pipe(
      Argument.withDescription("One source, for its upload history (the words join into one name)"),
      Argument.variadic(),
    ),
  },
  Effect.fn("costs.sources")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, SOURCES_PATH);
    const sources = yield* decodePaired(Sources, SOURCES_PATH)(body);
    const ref = input.name.join(" ");

    if (!ref) {
      if (session.output === "json") return yield* Print.json({ org: org.id, sources: body });
      if (sources.length === 0) {
        return yield* Print.line(
          c.dim(
            "No custom cost sources. Create one under Settings → Custom Cost Sources, then " +
              "`infrawrench costs push --source <name> --format csv --file bill.csv`.",
          ),
        );
      }
      return yield* Print.table(
        sources.map((s) => s.row),
        [
          { header: "Name", value: (s) => safe(s.name) },
          { header: "Uploads", value: (s) => String(s.uploadCount), align: "right" },
          {
            header: "Last upload",
            value: (s) => (s.lastUploadAt ? safe(s.lastUploadAt.slice(0, 10)) : c.dim("never")),
          },
          {
            header: "Currency",
            value: (s) => (s.defaultCurrency ? safe(s.defaultCurrency) : c.dim("from file")),
          },
          { header: "Provider id", value: (s) => c.dim(safe(s.pluginId)) },
        ],
      );
    }

    const found = findCustomSource(
      sources.map((s) => ({ id: s.row.id, name: s.row.name, paired: s })),
      ref,
    );
    if (!found) return yield* usage(`No custom cost source "${ref}".`);
    const { row: source, raw } = found.paired;
    const uploadsPath = `${SOURCES_PATH}/${encodeURIComponent(source.id)}/uploads`;
    const uploadsBody = yield* api.json(org.id, uploadsPath);
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, source: raw, uploads: uploadsBody });
    }
    const uploads = yield* decodeBody(Schema.Array(Upload), uploadsPath)(uploadsBody);
    yield* Print.line(`${c.bold(safe(source.name))} ${c.dim(`· ${uploads.length} upload(s)`)}`);
    yield* Print.table(uploads, [
      {
        header: "Uploaded",
        value: (u) => safe(u.createdAt.slice(0, 16).replace("T", " ")),
      },
      {
        header: "By",
        value: (u) => {
          const who = u.uploadedBy?.name ?? u.uploadedBy?.email;
          return who ? safe(who) : c.dim("-");
        },
      },
      { header: "File", value: (u) => (u.fileName ? safe(u.fileName) : c.dim(safe(u.format))) },
      { header: "Dates", value: (u) => `${safe(u.fromDate)} → ${safe(u.toDate)}` },
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
  }),
).pipe(
  Command.withDescription(
    'Custom cost sources (uploaded spend); "costs sources <name>" for one\'s upload history',
  ),
);

/** What `costs push` hands {@link pushToCustomSource}. */
export interface PushOptions {
  /** `--file`, whose base name becomes the upload's file name. */
  readonly file: Option.Option<string>;
  /** `--map field=Column`, repeatable: CSV column mapping overrides. */
  readonly map: ReadonlyArray<string>;
  /** `--currency`: currency for CSV rows with no currency column. */
  readonly currency: Option.Option<string>;
  /** `--replace` / `--append`: what to do when the upload overlaps earlier ones. */
  readonly mode: "append" | "replace" | undefined;
  /** `--date-format ymd|mdy|dmy`: order of slash-separated CSV dates. */
  readonly dateFormat: Option.Option<string>;
}

const DATE_FORMATS: readonly DateFormat[] = ["auto", "ymd", "mdy", "dmy"];

/** The fields of a JSON row the upload's range and totals are worked out from. */
const PushedRow = Schema.Struct({
  date: Schema.String,
  currency: Schema.String,
  amount: Schema.Finite,
});

/** Rows parsed from a CSV or FOCUS file by client-core's importer. */
const csvRows = Effect.fnUntraced(function* (
  core: Core,
  text: string,
  format: "csv" | "focus",
  source: Source,
  options: PushOptions,
) {
  const table = core.parseCsv(text);
  if (table.headers.length === 0) return yield* usage("The file has no header row.");
  let plan: Parameters<Core["buildCustomCostRows"]>[1];
  if (format === "focus") {
    if (!core.isFocusHeader(table.headers)) {
      return yield* usage(
        "That isn't a FOCUS file: it needs BilledCost, ChargePeriodStart and BillingCurrency " +
          "columns. Use --format csv to map its columns instead.",
      );
    }
    plan = { format: "focus" };
  } else {
    const mapping = yield* Effect.try({
      try: () =>
        core.applyCsvMappingOverrides(table.headers, core.detectCsvMapping(table.headers), [
          ...options.map,
        ]),
      catch: (e) => usage(e instanceof Error ? e.message : String(e)),
    });
    const wanted = Option.getOrElse(options.dateFormat, () => "auto");
    const dateFormat = DATE_FORMATS.find((f) => f === wanted);
    if (dateFormat === undefined) return yield* usage("--date-format must be ymd, mdy or dmy.");
    plan = { format: "csv", mapping, dateFormat };
    if (mapping.date === null || mapping.cost === null) {
      const missing = mapping.date === null ? "date" : "cost";
      return yield* usage(
        `Couldn't find the ${missing} column. Map it with ` +
          `--map ${missing}=<column> (columns: ${table.headers.join(", ")}).`,
      );
    }
  }
  const result = core.buildCustomCostRows(table, plan, {
    defaultCurrency: Option.getOrElse(options.currency, () => source.defaultCurrency),
  });
  if (result.ambiguousDates && Option.isNone(options.dateFormat)) {
    return yield* usage(
      "The dates could be month-first or day-first. Pass --date-format mdy or --date-format dmy.",
    );
  }
  if (result.errorCount > 0) {
    for (const err of result.errors.slice(0, 10)) {
      yield* Print.errLine(`line ${err.line}: ${safe(err.message)}`);
    }
    yield* Print.errLine(
      `${c.yellow("!")} ${result.errorCount} of ${result.lineCount} line(s) skipped` +
        (result.errorCount > 10 ? " (first 10 shown)" : ""),
    );
  }
  return result.rows;
});

/**
 * Upload rows (parsed from a CSV/FOCUS file, or a JSON array) into a custom
 * source, refusing an overlapping range unless `--replace` or `--append` says
 * which is meant.
 *
 * The create, rows and complete calls are client-core's `uploadCustomCostRows`
 * sequence over `CloudApi`: its Promise transport would carry a failed request
 * out as a rejection, where this keeps the cloud error typed and decodes each
 * answer. A `replace` still takes effect only at the complete call, so an
 * upload that dies halfway never deletes the spend it was replacing.
 */
export const pushToCustomSource = Effect.fnUntraced(function* (
  orgId: string,
  found: Paired<Source>,
  input:
    | { readonly text: string; readonly format: "csv" | "focus" }
    | { readonly format: "rows"; readonly rows: ReadonlyArray<unknown> },
  options: PushOptions,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const core = yield* loadCore;
  const source = found.row;
  let rows: ReadonlyArray<unknown>;
  let summaryRows: CustomCostRow[];
  if (input.format === "rows") {
    rows = input.rows;
    summaryRows = yield* Schema.decodeUnknownEffect(Schema.Array(PushedRow))(rows).pipe(
      Effect.map((decoded) => decoded.map((r) => ({ ...r }))),
      Effect.mapError((e) => usage(`Rows need a date, a currency and an amount: ${e.message}`)),
    );
  } else {
    summaryRows = yield* csvRows(core, input.text, input.format, source, options);
    rows = summaryRows;
  }
  if (rows.length === 0) return yield* usage("Nothing to upload: no valid rows.");

  const base = `${SOURCES_PATH}/${encodeURIComponent(source.id)}`;
  const { fromDate, toDate } = core.summarizeCustomCostRows(summaryRows);
  if (!fromDate || !toDate) return yield* usage("Nothing to upload: no valid rows.");
  if (!options.mode) {
    // client-core's `overlappingCustomCostUploads`, over the decoded rows.
    const uploads = yield* api.decode(Schema.Array(Upload), orgId, `${base}/uploads`);
    const overlapping = uploads.filter(
      (u) =>
        u.status !== "replaced" && u.rowCount > 0 && u.fromDate <= toDate && u.toDate >= fromDate,
    );
    if (overlapping.length > 0) {
      for (const u of overlapping) {
        yield* Print.errLine(
          `  ${safe(u.fileName ?? u.format)}  ${safe(u.fromDate)} → ${safe(u.toDate)}  ${formatTotals(u.totals)}`,
        );
      }
      return yield* usage(
        `${fromDate} → ${toDate} overlaps ${overlapping.length} earlier upload(s) ` +
          `of "${source.name}". Pass --replace to supersede that spend or --append to add to it.`,
      );
    }
  }

  const limits = core.CUSTOM_COST_LIMITS;
  if (rows.length > limits.maxRowsPerUpload) {
    return yield* usage(
      `An upload holds at most ${limits.maxRowsPerUpload} daily rows (this file aggregates to ${rows.length}). Split it by date range.`,
    );
  }
  const post = (path: string, body: unknown) =>
    api.json(orgId, path, { method: "POST", body: JSON.stringify(body) });
  const created = yield* post(`${base}/uploads`, {
    fileName: Option.getOrUndefined(options.file)?.split(/[\\/]/).pop() ?? null,
    format: input.format,
    mode: options.mode ?? "append",
    via: "cli",
    fromDate,
    toDate,
  }).pipe(Effect.flatMap(decodeBody(Upload, `${base}/uploads`)));
  const uploadPath = `${base}/uploads/${created.id}`;
  for (let i = 0; i < rows.length; i += limits.maxRowsPerChunk) {
    yield* post(`${uploadPath}/rows`, { rows: rows.slice(i, i + limits.maxRowsPerChunk) });
  }
  const completeBody = yield* post(`${uploadPath}/complete`, {});

  if (session.output === "json") return yield* Print.json(completeBody);
  const upload = yield* decodeBody(Upload, `${uploadPath}/complete`)(completeBody);
  yield* Print.line(
    `${c.green("✓")} uploaded ${upload.rowCount} daily row${upload.rowCount === 1 ? "" : "s"} ` +
      `to ${c.bold(safe(source.name))} ${c.dim(`(${safe(upload.fromDate)} → ${safe(upload.toDate)}, ${formatTotals(upload.totals)})`)}`,
  );
});
