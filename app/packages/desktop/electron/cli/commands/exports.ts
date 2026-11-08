// `infrawrench exports`: the org's scheduled cost exports, and running one;
// plus the cost-data halves of `infrawrench export` (`--format focus` and the
// background jobs of `--async` and `export jobs`), which `export.ts` routes to.
//
// A scheduled export is a nightly job whose failure is invisible until someone
// asks the warehouse why last week is missing, which makes it exactly the kind
// of thing a terminal should be able to check: `infrawrench exports` prints the
// last run's status and error for every export, and `infrawrench exports run
// <name|id>` forces one from a shell or a CI step.
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire` (the same definitions the API and the settings UI use), so a
// server-side change breaks this file's build instead of its output. The
// imports are type-only, so the CLI still ships zero new runtime dependencies.
import { writeFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostChargeType,
  CostDateRange,
  CostExport,
  CostExportInput,
  CostExportJob,
  CostExportRunResult,
  CostExportWarehouseSetup,
  CostExportWarehouseSink,
  CostFilter,
  CostReport,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliExit, CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { boundedInt, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, type Paired, spreadBody, Unrecognized, wire } from "../effect/wire";
import { matchCostReport } from "../format";
import { c, safe } from "../output";
import { parseWhere, resolveSavedFilterFlag } from "./costs";
import { REPORTS_PATH, resolveReport } from "./report-lookup";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const EXPORTS_PATH = "/cost-exports";
const SINKS_PATH = "/cost-exports/warehouse-sinks";
const JOBS_PATH = "/costs/exports/jobs";

const usage = (message: string) => new CliUsageError({ message });

export const refuseLocal = CliSession.use((session) =>
  session.local
    ? Effect.fail(
        new CliFailure({
          message:
            "Cost exports live in Infrawrench Cloud. There is no local cost history to export.",
        }),
      )
    : Effect.void,
);

// One struct for the three destination kinds, every kind's fields optional:
// `describeDestination` reads a kind it does not know as a warehouse, as the
// legacy rendering did.
const Destination = Schema.Struct({
  kind: Schema.String,
  bucket: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  urlHint: Schema.optional(Schema.String),
  pluginId: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  target: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type Destination = typeof Destination.Type;

const Export = wire<CostExport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    format: Schema.String,
    // Absent on a server older than FOCUS support, which only ever wrote native columns.
    schema: Schema.optional(Schema.String),
    cadence: Schema.String,
    hour: Schema.Finite,
    timezone: Schema.String,
    restatementDays: Schema.Finite,
    enabled: Schema.Boolean,
    destination: Destination,
    lastStatus: Schema.String,
    lastError: Schema.NullOr(Schema.String),
    lastObjectCount: Schema.NullOr(Schema.Finite),
    lastRowCount: Schema.NullOr(Schema.Finite),
  }),
);
type Export = typeof Export.Type;
const Exports = Schema.Array(Export);

const RunResult = wire<CostExportRunResult>()(
  Schema.Struct({
    status: Schema.String,
    objects: Schema.Array(
      Schema.Struct({
        periodStart: Schema.String,
        from: Schema.String,
        to: Schema.String,
        key: Schema.String,
        rowCount: Schema.Finite,
        byteCount: Schema.Finite,
      }),
    ),
    rowCount: Schema.Finite,
    collectionWatermark: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
  }),
);
type RunObject = (typeof RunResult.Type)["objects"][number];

const Sinks = wire<{ sinks: CostExportWarehouseSink[] }>()(
  Schema.Struct({
    sinks: Schema.Array(
      Schema.Struct({
        pluginId: Schema.String,
        displayName: Schema.String,
        label: Schema.String,
        targetFields: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            label: Schema.String,
            optional: Schema.Boolean,
            allowCustom: Schema.Boolean,
          }),
        ),
        accounts: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
      }),
    ),
  }),
);

const Setup = wire<CostExportWarehouseSetup>()(
  Schema.Struct({ sql: Schema.String, notes: Schema.Array(Schema.String) }),
);

/**
 * `s3://bucket/prefix`, `POST warehouse.acme.com/…a7f2` or `snowflake: DB.SCHEMA.TABLE`.
 * Restated from client-core's `describeCostExportDestination`, which takes the
 * whole destination union.
 */
function describeDestination(d: Destination): string {
  if (d.kind === "s3") return safe(`s3://${d.bucket ?? ""}/${d.prefix ?? ""}`);
  if (d.kind === "http") return safe(`${d.method ?? ""} ${d.urlHint ?? ""}`);
  const target = d.target ?? {};
  const table = ["database", "catalog", "schema", "table"]
    .map((k) => target[k])
    .filter(Boolean)
    .join(".");
  return safe(`${d.pluginId ?? ""}: ${table}`);
}

/** `daily 04:00 Europe/Berlin`: how the schedule reads. */
function describeSchedule(exp: Export): string {
  return safe(`${exp.cadence} ${String(exp.hour).padStart(2, "0")}:00 ${exp.timezone}`);
}

/**
 * The status column, coloured. A failing export is the reason to run this
 * command at all, so the failure gets the row's colour and its message gets a
 * line of its own below the table rather than being truncated into a cell.
 */
function statusCell(exp: Export): string {
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
const listExports = Effect.fnUntraced(function* () {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, EXPORTS_PATH);

  if (session.output === "json") return yield* Print.json({ org: org.id, exports: body });
  const exports = yield* decodeBody(Exports, EXPORTS_PATH)(body);

  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· scheduled cost exports")}`);
  yield* Print.line();

  if (exports.length === 0) {
    return yield* Print.line(
      c.dim(
        "No cost exports. An export writes your raw cost rows to a bucket, an HTTPS endpoint, or a Snowflake/Databricks table on a schedule. Create one in Settings → Cost Exports, or `infrawrench exports create` for a table.",
      ),
    );
  }

  yield* Print.table(exports, [
    { header: "name", value: (e) => c.bold(safe(e.name)) },
    {
      header: "format",
      // A warehouse export is a table, not a file.
      value: (e) =>
        c.dim(
          safe(
            e.destination.kind === "warehouse"
              ? "table"
              : e.schema && e.schema !== "native"
                ? `${e.format} · FOCUS ${e.schema.replace(/^focus-/, "")}`
                : e.format,
          ),
        ),
    },
    { header: "schedule", value: (e) => c.dim(describeSchedule(e)) },
    { header: "destination", value: (e) => c.dim(describeDestination(e.destination)) },
    { header: "last run", value: (e) => statusCell(e) },
  ]);

  // Errors below the table, in full. A truncated cause is a cause nobody can
  // act on, and this is the whole reason the command exists.
  const failing = exports.filter((e) => e.lastStatus === "failed" && e.lastError);
  if (failing.length > 0) {
    yield* Print.line();
    for (const exp of failing) {
      yield* Print.line(`${c.red("✗")} ${c.bold(safe(exp.name))}: ${safe(exp.lastError)}`);
    }
  }

  const stale = exports.filter(
    (e) => e.enabled && e.lastStatus !== "failed" && e.restatementDays === 0,
  );
  if (stale.length > 0) {
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Note: exports with a 0-day restatement window never revisit a period. Provider spend is restated for days after the fact, so those objects will drift from the invoice.",
      ),
    );
  }

  yield* Print.line();
  yield* Print.line(c.dim("Run one now with `infrawrench exports run <name|id>`."));
});

/** The org's export by name or id, beside the element the server sent. */
const findExport = Effect.fnUntraced(function* (orgId: string, query: string) {
  const api = yield* CloudApi;
  const exports = yield* decodePaired(Exports, EXPORTS_PATH)(yield* api.json(orgId, EXPORTS_PATH));
  // Same name-or-id matcher the reports command uses: a name is the point of
  // the object, and two objects should not disagree about how to find one.
  const found = matchCostReport(
    exports.map((e) => ({ id: e.row.id, name: e.row.name, paired: e })),
    query,
  );
  if (found.match) return found.match.paired;
  return yield* new CliFailure({
    message:
      found.candidates.length === 0
        ? `No cost export matches "${query}". Run \`infrawrench exports\` to see them.`
        : `"${query}" matches ${found.candidates.length} exports: ${found.candidates
            .map((e) => e.name)
            .join(", ")}. Use the full name or the id.`,
  });
});

const exportName = Argument.String("name|id").pipe(
  Argument.withDescription("The export (the words join into one name)"),
  Argument.variadic(),
);

/** `infrawrench exports run <name|id>`: force a run and print what it wrote. */
const runExport = Command.make(
  "run",
  { name: exportName },
  Effect.fn("exports.run")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.name.join(" ");
    if (!query.trim()) {
      return yield* new CliFailure({
        message: "Which export? `infrawrench exports run <name|id>`",
      });
    }
    const org = yield* currentOrg;
    const { row: exp, raw } = yield* findExport(org.id, query);

    const path = `${EXPORTS_PATH}/${encodeURIComponent(exp.id)}/run`;
    const body = yield* api.json(org.id, path, { method: "POST" });
    const run = yield* decodeBody(RunResult, path)(body);

    // A failed run is a failed command: a CI step that shells out to this has
    // to be able to notice. The JSON body is still printed first, on stdout, so
    // `--json` output stays parseable either way; the message goes to stderr.
    const failure = new CliFailure({
      message: `Export "${exp.name}" failed: ${run.error ?? "unknown error"}`,
    });

    if (session.output === "json") {
      yield* Print.json(yield* spreadBody({ org: org.id, export: raw }, body, path));
      if (run.status === "failed") return yield* failure;
      return;
    }
    if (run.status === "failed") return yield* failure;

    yield* Print.line(
      `${c.green("✓")} ${c.bold(safe(exp.name))} ${c.dim(
        `· ${run.objects.length} object(s) · ${run.rowCount.toLocaleString()} rows`,
      )}`,
    );
    if (run.collectionWatermark) {
      yield* Print.line(
        c.dim(
          `Collection watermark ${safe(run.collectionWatermark)}. Periods ending after it are still moving.`,
        ),
      );
    }
    yield* Print.line();

    const warehouse = exp.destination.kind === "warehouse";
    yield* Print.table(run.objects, [
      { header: "period", value: (o) => safe(o.periodStart) },
      { header: "days", value: (o) => c.dim(`${safe(o.from)} → ${safe(o.to)}`) },
      { header: "rows", value: (o) => o.rowCount.toLocaleString(), align: "right" },
      ...(warehouse
        ? []
        : [
            {
              header: "bytes",
              value: (o: RunObject) => o.byteCount.toLocaleString(),
              align: "right" as const,
            },
          ]),
      { header: warehouse ? "table" : "key", value: (o) => c.dim(safe(o.key)) },
    ]);
  }),
).pipe(Command.withDescription("Run one export now and list the objects it wrote"));

const fetchSinks = Effect.fnUntraced(function* (orgId: string) {
  const api = yield* CloudApi;
  const body = yield* api.json(orgId, SINKS_PATH);
  return { body, sinks: (yield* decodeBody(Sinks, SINKS_PATH)(body)).sinks };
});

/** `infrawrench exports warehouses`: the warehouse destination types and your accounts of each. */
const warehouses = Command.make(
  "warehouses",
  {},
  Effect.fn("exports.warehouses")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const org = yield* currentOrg;
    const { body, sinks } = yield* fetchSinks(org.id);
    if (session.output === "json") {
      const raw = yield* decodeBody(Schema.Struct({ sinks: Schema.Unknown }), SINKS_PATH)(body);
      return yield* Print.json({ org: org.id, sinks: raw.sinks });
    }
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim("· warehouse destinations for cost exports")}`,
    );
    yield* Print.line();
    for (const sink of sinks) {
      yield* Print.line(
        `${c.bold(safe(sink.label))} ${c.dim(`(--plugin ${safe(sink.pluginId)})`)}`,
      );
      if (sink.accounts.length === 0) {
        yield* Print.line(
          c.dim(`  No ${safe(sink.displayName)} account connected. Add one first.`),
        );
      } else {
        for (const a of sink.accounts) yield* Print.line(`  ${safe(a.name)} ${c.dim(safe(a.id))}`);
      }
      for (const f of sink.targetFields) {
        const notes = [
          f.optional ? "optional" : "required",
          f.allowCustom ? "new names allowed" : null,
        ]
          .filter(Boolean)
          .join(", ");
        yield* Print.line(
          c.dim(`  --target ${safe(f.key)}=<${safe(f.label.toLowerCase())}>  (${notes})`),
        );
      }
      yield* Print.line();
    }
    yield* Print.line(
      c.dim(
        "Create one with `infrawrench exports create --name <n> --plugin <id> -a <account> --target key=value ...`.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Snowflake/Databricks destinations, your accounts of each, and the --target keys they take",
  ),
);

const CADENCES = ["daily", "weekly", "monthly"] as const satisfies ReadonlyArray<
  CostExportInput["cadence"]
>;
const DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "charge_type",
  "commitment",
] as const satisfies ReadonlyArray<CostExportInput["query"]["dimensions"][number]>;

/**
 * `infrawrench exports create`: a warehouse export. S3 and HTTPS exports take
 * a secret, which belongs in the settings form rather than in shell history,
 * so only warehouse destinations (which borrow a connected account's
 * credentials) are created here.
 */
const create = Command.make(
  "create",
  {
    name: Flag.String("name").pipe(
      Flag.withMetavar("n"),
      Flag.withDescription("The export's name"),
      Flag.optional,
    ),
    plugin: Flag.String("plugin").pipe(
      Flag.withMetavar("snowflake|databricks"),
      Flag.withDescription("The warehouse (see exports warehouses)"),
      Flag.optional,
    ),
    target: Flag.String("target").pipe(
      Flag.withMetavar("key=value"),
      Flag.withDescription("One target field (database, schema, table, ...); repeatable"),
      Flag.atLeast(0),
    ),
    cadence: Flag.String("cadence").pipe(
      Flag.withMetavar(CADENCES.join("|")),
      Flag.withDescription("How often it runs (default daily)"),
      Flag.optional,
    ),
    hour: boundedInt("hour", 0, 23).pipe(
      Flag.withMetavar("0-23"),
      Flag.withDescription("The hour it runs at (default 4)"),
      Flag.optional,
    ),
    timezone: Flag.String("timezone").pipe(
      Flag.withMetavar("zone"),
      Flag.withDescription("The hour's time zone (default UTC)"),
      Flag.optional,
    ),
    restatementDays: boundedInt("restatement-days", 0, 90).pipe(
      Flag.withMetavar("0-90"),
      Flag.withDescription("Days each run revisits, for restated spend (default 7)"),
      Flag.optional,
    ),
    dimensions: Flag.String("dimensions").pipe(
      Flag.withMetavar("a,b"),
      Flag.withDescription(
        `Identity columns (default provider,account,service,region): ${DIMENSIONS.join(", ")}`,
      ),
      Flag.optional,
    ),
  },
  Effect.fn("exports.create")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const name = Option.getOrUndefined(input.name)?.trim();
    if (!name) return yield* usage("Name the export: `--name <name>`.");
    const { sinks } = yield* fetchSinks(org.id);
    const plugin = Option.getOrUndefined(input.plugin);
    const sink = sinks.find((s) => s.pluginId === plugin);
    if (!sink) {
      return yield* usage(
        `--plugin must be one of: ${sinks.map((s) => s.pluginId).join(", ") || "(none available)"}`,
      );
    }
    const accountQuery = session.account?.trim() ?? "";
    const [onlyAccount] = sink.accounts;
    const account =
      sink.accounts.find((a) => a.id === accountQuery) ??
      sink.accounts.find((a) => a.name.toLowerCase() === accountQuery.toLowerCase()) ??
      (accountQuery === "" && sink.accounts.length === 1 ? onlyAccount : undefined);
    if (!account) {
      return yield* usage(
        sink.accounts.length === 0
          ? `No ${sink.displayName} account is connected. Add one first.`
          : `Which ${sink.displayName} account? -a <name|id>, one of: ${sink.accounts.map((a) => a.name).join(", ")}`,
      );
    }
    const target: Record<string, string> = {};
    for (const pair of input.target) {
      const eq = pair.indexOf("=");
      if (eq <= 0) return yield* usage(`--target takes key=value, got "${pair}"`);
      target[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const known = new Set(sink.targetFields.map((f) => f.key));
    for (const key of Object.keys(target)) {
      if (!known.has(key)) {
        return yield* usage(
          `${sink.displayName} has no target field "${key}". Fields: ${[...known].join(", ")}`,
        );
      }
    }
    const missing = sink.targetFields.filter((f) => !f.optional && !target[f.key]);
    if (missing.length > 0) {
      return yield* usage(
        `Missing ${missing.map((f) => `--target ${f.key}=…`).join(", ")}. \`infrawrench exports warehouses\` lists them.`,
      );
    }
    const wantedCadence = Option.getOrElse(input.cadence, () => "daily");
    const cadence = CADENCES.find((c) => c === wantedCadence);
    if (cadence === undefined) {
      return yield* usage(`--cadence must be one of: ${CADENCES.join(", ")}`);
    }
    const dimensions: Array<(typeof DIMENSIONS)[number]> = [];
    for (const d of Option.getOrElse(input.dimensions, () => "provider,account,service,region")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)) {
      const known = DIMENSIONS.find((k) => k === d);
      if (known === undefined) {
        return yield* usage(`--dimensions: unknown column "${d}". Use ${DIMENSIONS.join(", ")}`);
      }
      dimensions.push(known);
    }

    const body: CostExportInput = {
      name,
      format: "csv",
      query: { version: 1, dimensions, tagKeys: [], filters: [] },
      cadence,
      hour: Option.getOrElse(input.hour, () => 4),
      timezone: Option.getOrElse(input.timezone, () => "UTC"),
      restatementDays: Option.getOrElse(input.restatementDays, () => 7),
      enabled: true,
      destination: { kind: "warehouse", pluginId: sink.pluginId, accountId: account.id, target },
    };
    const createdBody = yield* api.json(org.id, EXPORTS_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (session.output === "json") {
      return yield* Print.json({ org: org.id, export: createdBody });
    }
    const created = yield* decodeBody(Export, EXPORTS_PATH)(createdBody);
    yield* Print.line(
      `${c.green("✓")} ${c.bold(safe(created.name))} ${c.dim(`· ${describeDestination(created.destination)}`)}`,
    );
    yield* Print.line(
      c.dim(`${describeSchedule(created)} · ${created.restatementDays}-day restatement window`),
    );
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Grant the account access with `infrawrench exports setup " +
          safe(JSON.stringify(created.name)) +
          "`, then test it with `infrawrench exports run`.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "A warehouse export: load cost rows into a Snowflake or Databricks table on a schedule",
  ),
);

/** `infrawrench exports setup <name|id>`: the GRANT statements a warehouse export needs. */
const setup = Command.make(
  "setup",
  { name: exportName },
  Effect.fn("exports.setup")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const query = input.name.join(" ");
    if (!query.trim()) {
      return yield* new CliFailure({
        message: "Which export? `infrawrench exports setup <name|id>`",
      });
    }
    const org = yield* currentOrg;
    const { row: exp } = yield* findExport(org.id, query);
    if (exp.destination.kind !== "warehouse") {
      return yield* new CliFailure({
        message: `"${exp.name}" writes to ${describeDestination(exp.destination)}, not a warehouse table.`,
      });
    }
    const path = "/cost-exports/warehouse-setup";
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({
        accountId: exp.destination.accountId,
        target: exp.destination.target,
      }),
    });
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, export: exp.id }, body, path));
    }
    const result = yield* decodeBody(Setup, path)(body);
    yield* Print.line(result.sql);
    if (result.notes.length > 0) {
      yield* Print.line();
      for (const note of result.notes) yield* Print.line(c.dim(`• ${safe(note)}`));
    }
  }),
).pipe(Command.withDescription("The least-privilege GRANT statements a warehouse export needs"));

/**
 * `infrawrench exports`: scheduled cost exports with the last run's status.
 * Unlike `reports`, running is behind an explicit verb: this one writes to
 * somebody's bucket.
 */
export const exportsCommand = Command.make("exports", {}, listExports).pipe(
  Command.withDescription(
    "Scheduled cost exports (raw rows to a warehouse or object store) with the last run's status and error",
  ),
  Command.withSubcommands([runExport, warehouses, create, setup]),
);

/* ------------------------------------------------------------------ *
 * `export --format focus` and background jobs
 * ------------------------------------------------------------------ */

/** The cost scope `export --format focus` and `export --async` read off the command line. */
export interface ExportScope {
  readonly last: Option.Option<number>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly where: Option.Option<string>;
  readonly filter: Option.Option<string>;
  readonly chargeType: ReadonlyArray<CostChargeType>;
}

/** The range flags when any was given: they override a report's own range. */
const explicitRangeOf = (scope: ExportScope) =>
  Option.isSome(scope.last) || Option.isSome(scope.from) || Option.isSome(scope.to)
    ? resolveDateRange(scope)
    : null;

// Restated for `knownOr`: `wire` fails the build when client-core adds one.
const PRESETS = ["7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"] as const;

/** What `export --format focus` reads off a saved report. */
const ReportScope = wire<CostReport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    config: Schema.Struct({
      dateRange: Schema.Struct({
        kind: Schema.String,
        preset: Schema.optional(knownOr(PRESETS)),
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String),
      }),
      filters: Schema.Array(Schema.Unknown),
      savedFilterId: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);
type ReportScope = typeof ReportScope.Type;

/** A report's range as client-core resolves it, or null for one this build cannot read. */
function reportRange(range: ReportScope["config"]["dateRange"]): CostDateRange | null {
  if (range.kind === "absolute" && range.from !== undefined && range.to !== undefined) {
    return { kind: "absolute", from: range.from, to: range.to };
  }
  if (range.kind === "relative" && range.preset && !(range.preset instanceof Unrecognized)) {
    return { kind: "relative", preset: range.preset };
  }
  return null;
}

/** A name/id query to one saved report, with the scope `export` reads. */
const findReportScope = Effect.fnUntraced(function* (orgId: string, query: string) {
  const found = yield* resolveReport(orgId, query);
  return yield* decodeBody(ReportScope, REPORTS_PATH)(found.raw);
});

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
export const exportFocus = Effect.fnUntraced(function* (
  scope: ExportScope,
  reportQuery: string,
  out: Option.Option<string>,
  focusVersion: Option.Option<string>,
) {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const { focusExportFilename, resolveCostDateRange, FOCUS_VERSIONS, FOCUS_LATEST_VERSION } =
    yield* loadCore;
  const wantedVersion = Option.getOrElse(focusVersion, () => FOCUS_LATEST_VERSION);
  const version = FOCUS_VERSIONS.find((v) => v === wantedVersion);
  if (version === undefined) {
    return yield* usage(
      `--focus-version: "${Option.getOrUndefined(focusVersion)}" is not a FOCUS version this server writes. Use ${FOCUS_VERSIONS.join(" or ")}.`,
    );
  }

  const report = reportQuery.trim() ? yield* findReportScope(org.id, reportQuery.trim()) : null;
  // Explicit range flags win over a report's own range: "this report, but for
  // last quarter" is the reason to name a report and a range together.
  const explicitRange = explicitRangeOf(scope);
  let base: {
    from: string;
    to: string;
    version?: string;
    filters: ReadonlyArray<unknown>;
    savedFilterId?: string;
  };
  if (report) {
    // client-core's `focusExportRequestForConfig`, over the fields it reads.
    const range = reportRange(report.config.dateRange);
    if (!range && !explicitRange) {
      return yield* new CliFailure({
        message: `"${report.name}" has a date range this version cannot read. Pass --from and --to (or --last).`,
      });
    }
    const resolved = range
      ? resolveCostDateRange(range)
      : (explicitRange ?? resolveDateRange(scope));
    base = {
      ...resolved,
      version: FOCUS_LATEST_VERSION,
      filters: report.config.filters,
      ...(report.config.savedFilterId ? { savedFilterId: report.config.savedFilterId } : {}),
    };
  } else {
    base = { ...resolveDateRange(scope), filters: [] };
  }

  const where = yield* parseWhere(scope.where);
  const savedFilter = yield* resolveSavedFilterFlag(org.id, scope.filter);
  if (savedFilter && base.savedFilterId && savedFilter.row.id !== base.savedFilterId) {
    return yield* usage(
      `--filter: "${report?.name ?? ""}" already applies a saved filter, and a request carries one. ` +
        "Use --where to narrow it further.",
    );
  }
  const chargeTypes = scope.chargeType;

  const request = {
    ...base,
    ...(explicitRange ?? {}),
    filters: [...base.filters, ...where],
    ...(savedFilter ? { savedFilterId: savedFilter.row.id } : {}),
    ...(chargeTypes.length > 0 ? { chargeTypes } : {}),
    version,
  };

  const csv = yield* api.text(org.id, "/costs/focus-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  // Header line excluded. Counts lines, so a tag value with an embedded
  // newline would overcount; it only feeds the summary below.
  const rowCount = Math.max(0, csv.split("\n").filter((line) => line !== "").length - 1);

  if (session.output === "json") {
    return yield* Print.json({
      org: org.id,
      report: report ? { id: report.id, name: report.name } : null,
      request,
      rowCount,
      csv,
    });
  }

  const summary = `FOCUS ${version} · ${rowCount.toLocaleString()} rows · ${request.from} → ${request.to}`;
  if (Option.isSome(out)) {
    const path = out.value;
    yield* Effect.sync(() => writeFileSync(path, csv, "utf8"));
    return yield* Print.errLine(`${c.green("✓")} ${c.bold(path)} ${c.dim(`· ${summary}`)}`);
  }

  yield* Print.write(csv);
  yield* Print.errLine(
    c.dim(
      process.stdout.isTTY
        ? `${summary}. Redirect to a file, or pass --out ${focusExportFilename(request, report?.name ?? "")}.`
        : summary,
    ),
  );
});

const JOB_FORMATS = ["csv", "ndjson", "focus"] as const;
const POLL = "2 seconds";

const Job = wire<CostExportJob>()(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    format: Schema.String,
    focusVersion: Schema.NullOr(Schema.String),
    from: Schema.String,
    to: Schema.String,
    source: Schema.Struct({ reportName: Schema.NullOr(Schema.String) }),
    progress: Schema.Finite,
    rowCount: Schema.Finite,
    error: Schema.NullOr(Schema.String),
    fileName: Schema.String,
  }),
);
type Job = typeof Job.Type;

/** One status line for a job, for stderr while waiting and for `export jobs`. */
function jobLine(job: Job): string {
  const what = job.source.reportName ?? "query";
  const format = job.format === "focus" ? `FOCUS ${job.focusVersion ?? ""}`.trim() : job.format;
  const progress = job.status === "running" ? ` ${Math.round(job.progress * 100)}%` : "";
  const rows = job.rowCount > 0 ? ` · ${job.rowCount.toLocaleString()} rows` : "";
  return safe(
    `${job.id.slice(0, 8)} ${job.status}${progress} · ${what} · ${format} · ${job.from} → ${job.to}${rows}`,
  );
}

const jobPath = (id: string) => `${JOBS_PATH}/${encodeURIComponent(id)}`;

/** Poll until the job leaves queued/running, reporting progress on stderr. */
const waitForJob = Effect.fnUntraced(function* (orgId: string, job: Paired<Job>) {
  const api = yield* CloudApi;
  let current = job;
  let last = "";
  while (current.row.status === "queued" || current.row.status === "running") {
    const line = jobLine(current.row);
    if (line !== last && process.stderr.isTTY) yield* Print.errLine(c.dim(line));
    last = line;
    yield* Effect.sleep(POLL);
    const path = jobPath(current.row.id);
    const raw = yield* api.json(orgId, path);
    current = { row: yield* decodeBody(Job, path)(raw), raw };
  }
  return current;
});

/** Save a finished job's file to `out`, or write it to stdout. */
const deliverJobFile = Effect.fnUntraced(function* (
  orgId: string,
  job: Job,
  out: Option.Option<string>,
) {
  const api = yield* CloudApi;
  const { bytes } = yield* api.download(orgId, `${jobPath(job.id)}/download`);
  if (Option.isSome(out)) {
    const path = out.value;
    yield* Effect.sync(() => writeFileSync(path, bytes));
    return yield* Print.errLine(
      `${c.green("✓")} ${c.bold(path)} ${c.dim(`· ${job.rowCount.toLocaleString()} rows · ${safe(job.from)} → ${safe(job.to)}`)}`,
    );
  }
  yield* Print.write(bytes);
  if (process.stdout.isTTY) {
    yield* Print.errLine(c.dim(`Redirect to a file, or pass --out ${safe(job.fileName)}.`));
  }
});

/**
 * A finished (or failed) job: the file with `--wait`, or what to do next. A
 * job that failed ends the command with exit 1 once it has said so.
 */
const settleJob = Effect.fnUntraced(function* (
  orgId: string,
  job: Paired<Job>,
  flags: { readonly wait: boolean; readonly out: Option.Option<string> },
) {
  const session = yield* CliSession;
  const json = session.output === "json";
  const done = flags.wait ? yield* waitForJob(orgId, job) : job;
  const out = Option.getOrUndefined(flags.out);
  if (done.row.status === "succeeded" && flags.wait && (!json || out !== undefined)) {
    yield* deliverJobFile(orgId, done.row, flags.out);
    if (json) yield* Print.json({ org: orgId, job: done.raw, out });
    return;
  }
  if (json) {
    yield* Print.json({ org: orgId, job: done.raw });
    if (done.row.status === "failed") return yield* new CliExit({ exitCode: 1 });
    return;
  }
  if (done.row.status === "failed") {
    yield* Print.errLine(c.red(`Export failed: ${safe(done.row.error ?? "unknown error")}`));
    return yield* new CliExit({ exitCode: 1 });
  }
  yield* Print.line(jobLine(done.row));
  const id = safe(done.row.id);
  if (done.row.status === "queued" || done.row.status === "running") {
    yield* Print.line(
      c.dim(
        `Running in the background. \`infrawrench export jobs ${id} --wait\` waits and downloads it.`,
      ),
    );
  } else if (done.row.status === "succeeded") {
    yield* Print.line(
      c.dim(
        `Ready. \`infrawrench export jobs ${id} --wait --out ${safe(done.row.fileName)}\` downloads it.`,
      ),
    );
  }
});

/** A job request's `query` without a report: the `costs` scope flags and `--dimensions`. */
interface JobRequest {
  reportId?: string;
  format: (typeof JOB_FORMATS)[number];
  from?: string;
  to?: string;
  query?: {
    filters: ReadonlyArray<CostFilter>;
    savedFilterId?: string;
    chargeTypes?: ReadonlyArray<CostChargeType>;
    dimensions?: ReadonlyArray<string>;
  };
  /** Sent as typed: the server names the versions it writes when it refuses one. */
  focusVersion?: string;
}

/**
 * `infrawrench export --async --format csv|ndjson|focus [<report name|id>]`:
 * queue a background export job on the server, and with `--wait` follow it to
 * the end and write the file (stdout, or `--out <file>`).
 *
 * Takes the same range and filter flags as `export --format focus`. Naming a
 * report exports that report's scope (its filters, group-by, cost basis and,
 * for csv/ndjson, its per-day unit cost); explicit range flags override its
 * range. Without a report, `--where`, `--filter`, `--charge-type` and
 * `--dimensions service,account` describe the scope.
 */
export const exportJob = Effect.fnUntraced(function* (
  scope: ExportScope,
  reportQuery: string,
  flags: {
    readonly format: Option.Option<string>;
    readonly focusVersion: Option.Option<string>;
    readonly wait: boolean;
    readonly out: Option.Option<string>;
    readonly dimensions: Option.Option<string>;
  },
) {
  yield* refuseLocal;
  const api = yield* CloudApi;
  const wantedFormat = Option.getOrElse(flags.format, () => "csv");
  const format = JOB_FORMATS.find((f) => f === wantedFormat);
  if (format === undefined) {
    return yield* usage(`--format must be one of ${JOB_FORMATS.join(", ")} with --async.`);
  }
  const focusVersion = Option.getOrUndefined(flags.focusVersion);
  if (focusVersion && format !== "focus") {
    return yield* usage("--focus-version only applies to --format focus.");
  }
  const org = yield* currentOrg;
  const report = reportQuery.trim() ? yield* resolveReport(org.id, reportQuery.trim()) : null;
  if (report && (Option.isSome(scope.where) || Option.isSome(scope.filter))) {
    return yield* usage(
      "A report export uses the report's own filters. Drop --where/--filter, or export without naming the report.",
    );
  }
  const explicitRange = explicitRangeOf(scope);

  let request: JobRequest;
  if (report) {
    request = { reportId: report.row.id, format, ...(explicitRange ?? {}) };
  } else {
    const savedFilter = yield* resolveSavedFilterFlag(org.id, scope.filter);
    const chargeTypes = scope.chargeType;
    const dimensions = Option.getOrElse(flags.dimensions, () => "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    request = {
      format,
      ...(explicitRange ?? resolveDateRange(scope)),
      query: {
        filters: yield* parseWhere(scope.where),
        ...(savedFilter ? { savedFilterId: savedFilter.row.id } : {}),
        ...(chargeTypes.length > 0 ? { chargeTypes } : {}),
        ...(dimensions.length > 0 ? { dimensions } : {}),
      },
    };
  }
  if (format === "focus" && focusVersion) request.focusVersion = focusVersion;

  const raw = yield* api.json(org.id, JOBS_PATH, { method: "POST", body: JSON.stringify(request) });
  const job = yield* decodeBody(Job, JOBS_PATH)(raw);
  yield* settleJob(org.id, { row: job, raw }, { wait: flags.wait, out: flags.out });
});

/**
 * `infrawrench export jobs [<id> [cancel]] [--wait] [--out <file>]`: your
 * recent export jobs; one job's status (waiting for it and downloading the
 * file with `--wait`); or cancelling one. An id prefix from the list works.
 */
export const exportJobs = Effect.fnUntraced(function* (
  idArg: Option.Option<string>,
  action: Option.Option<string>,
  flags: { readonly wait: boolean; readonly out: Option.Option<string> },
) {
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.decode(Schema.Struct({ jobs: Schema.Unknown }), org.id, JOBS_PATH);
  const jobs = yield* decodePaired(Schema.Array(Job), JOBS_PATH)(body.jobs);
  if (Option.isNone(idArg)) {
    if (session.output === "json") return yield* Print.json({ org: org.id, jobs: body.jobs });
    if (jobs.length === 0) {
      return yield* Print.line(
        c.dim("No recent export jobs. Start one with `infrawrench export --async`."),
      );
    }
    for (const job of jobs) yield* Print.line(jobLine(job.row));
    return;
  }
  const id = idArg.value;
  const matches = jobs.filter((j) => j.row.id === id || j.row.id.startsWith(id));
  const [job] = matches;
  if (!job || matches.length !== 1) {
    return yield* usage(
      matches.length === 0
        ? `No export job "${id}". Run \`infrawrench export jobs\` to list yours.`
        : `"${id}" matches ${matches.length} jobs; use more of the id.`,
    );
  }
  if (Option.isSome(action) && action.value === "cancel") {
    const path = jobPath(job.row.id);
    const raw = yield* api.json(org.id, path, { method: "DELETE" });
    if (session.output === "json") return yield* Print.json({ org: org.id, job: raw });
    return yield* Print.line(jobLine(yield* decodeBody(Job, path)(raw)));
  }
  if (Option.isSome(action)) {
    return yield* usage(`Unknown action "${action.value}". Try cancel.`);
  }
  yield* settleJob(org.id, job, flags);
});

/** `--focus-version` and the background-job flags `export` takes. */
export const exportJobFlags = {
  focusVersion: Flag.String("focus-version").pipe(
    Flag.withMetavar("1.4|1.3"),
    Flag.withDescription("--format focus: which FOCUS version to write (default the latest)"),
    Flag.optional,
  ),
  async: Flag.Boolean("async").pipe(
    Flag.withDescription(
      "Queue a background export job (csv, ndjson or focus) instead of streaming the file",
    ),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("--async: poll until the file is ready, then write it"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  dimensions: Flag.String("dimensions").pipe(
    Flag.withMetavar("a,b"),
    Flag.withDescription("--async without a report: rows per these dimensions"),
    Flag.optional,
  ),
};
