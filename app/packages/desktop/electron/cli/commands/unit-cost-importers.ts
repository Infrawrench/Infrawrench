/**
 * `infrawrench unit-costs sources` and `infrawrench unit-costs importer <key>`:
 * scheduled importers that pull a business metric from a connected account.
 *
 * The importer itself runs in the cloud (the poller claims it on schedule);
 * this command configures it, runs it now, and shows its history. Every
 * provider-specific field (a CloudWatch namespace, a SQL statement) is a
 * plugin-defined param, so the CLI takes them generically as `--set key=value`
 * and lists what each source accepts under `sources`.
 */
import { readFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  BusinessMetricImporter,
  BusinessMetricImporterInput,
  BusinessMetricImportRun,
  BusinessMetricSourceAccount,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { file as fileFlag } from "../effect/file-flags";
import * as Print from "../effect/print";
import { from as fromFlag, to as toFlag } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe } from "../output";

const HOST_KEYS = new Set(["schedule", "backfillDays", "timezone", "aggregation", "enabled"]);
const SOURCES_PATH = "/business-metrics/importer-sources";

const usage = (message: string) => new CliUsageError({ message });

const refuseLocal = CliSession.use((session) =>
  session.local
    ? Effect.fail(
        new CliFailure({
          message:
            "Business metric importers run in Infrawrench Cloud, next to the spend they divide.",
        }),
      )
    : Effect.void,
);

const Importer = wire<BusinessMetricImporter>()(
  Schema.Struct({
    accountId: Schema.String,
    accountName: Schema.NullOr(Schema.String),
    sourceLabel: Schema.NullOr(Schema.String),
    params: Schema.Record(Schema.String, Schema.String),
    schedule: Schema.String,
    backfillDays: Schema.Finite,
    timezone: Schema.String,
    aggregation: Schema.String,
    enabled: Schema.Boolean,
    nextRunAt: Schema.NullOr(Schema.String),
    lastRunAt: Schema.NullOr(Schema.String),
    lastStatus: Schema.NullOr(Schema.String),
    lastError: Schema.NullOr(Schema.String),
    consecutiveFailures: Schema.Finite,
  }),
);
type Importer = typeof Importer.Type;

const Run = wire<BusinessMetricImportRun>()(
  Schema.Struct({
    trigger: Schema.String,
    status: Schema.String,
    from: Schema.String,
    to: Schema.String,
    pointsRead: Schema.Finite,
    daysWritten: Schema.Finite,
    error: Schema.NullOr(Schema.String),
    notes: Schema.Array(Schema.String),
    startedAt: Schema.String,
    durationMs: Schema.NullOr(Schema.Finite),
  }),
);
type Run = typeof Run.Type;

const Sources = wire<{ sources: BusinessMetricSourceAccount[] }>()(
  Schema.Struct({
    sources: Schema.optional(
      Schema.Array(
        Schema.Struct({
          accountId: Schema.String,
          accountName: Schema.String,
          source: Schema.Struct({
            label: Schema.String,
            readOnly: Schema.optional(Schema.String),
            fields: Schema.Array(
              Schema.Struct({
                key: Schema.String,
                label: Schema.String,
                type: Schema.String,
                required: Schema.optional(Schema.Boolean),
                dependsOn: Schema.optional(Schema.Array(Schema.String)),
              }),
            ),
          }),
        }),
      ),
    ),
  }),
);

/** `key=value`, with `@path` reading the value from a file (a SQL statement, usually). */
const parseSet = (entry: string): Effect.Effect<[string, string], CliUsageError> => {
  const eq = entry.indexOf("=");
  if (eq <= 0) return Effect.fail(usage(`--set expects key=value, got "${entry}".`));
  const key = entry.slice(0, eq).trim();
  const value = entry.slice(eq + 1);
  if (!value.startsWith("@")) return Effect.succeed([key, value]);
  const path = value.slice(1);
  return Effect.try({
    try: (): [string, string] => [key, readFileSync(path, "utf8")],
    catch: (e) => usage(`Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`),
  });
};

/**
 * The PUT body: `BusinessMetricImporterInput`, whose schedule and aggregation
 * the server validates (a `--set schedule=…` is sent as typed, and a bad one
 * answers a 400 naming the values). Keys from a `--file` the CLI does not
 * read are sent through as written.
 */
interface ImporterBody {
  accountId: string;
  params: Record<string, string>;
  [key: string]: unknown;
}

const FileBody = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** `--file <path>` (`-` for stdin): an importer document, as JSON. */
const readBody = Effect.fnUntraced(function* (file: string) {
  const text = yield* Effect.try({
    try: () => (file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8")),
    catch: (e) => usage(`Couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}`),
  });
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (e) => usage(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`),
  });
  const whole = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
    parsed,
  ).pipe(Effect.mapError(() => usage(`${file} is not an importer document (a JSON object).`)));
  const typed = yield* Schema.decodeEffect(FileBody)(whole).pipe(
    Effect.mapError((e) => usage(`${file}: ${e.message}`)),
  );
  const body: ImporterBody = {
    ...whole,
    accountId: typed.accountId ?? "",
    params: { ...typed.params },
  };
  return body;
});

/** The saved importer as the PUT body that would save it again. */
const asInput = (importer: Importer): ImporterBody => ({
  accountId: importer.accountId,
  params: { ...importer.params },
  schedule: importer.schedule,
  backfillDays: importer.backfillDays,
  timezone: importer.timezone,
  aggregation: importer.aggregation,
  enabled: importer.enabled,
});

function statusLabel(importer: Importer): string {
  if (!importer.enabled) return c.dim("paused");
  if (importer.lastStatus === "error") return c.red(`failing (${importer.consecutiveFailures}×)`);
  if (!importer.lastRunAt) return c.yellow("first run pending");
  return c.green("ok");
}

/** `infrawrench unit-costs sources`: accounts that can feed a metric, and their fields. */
export const sources = Command.make(
  "sources",
  {},
  Effect.fn("unit-costs.sources")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.decode(
      Schema.Struct({ sources: Schema.optional(Schema.Unknown) }),
      org.id,
      SOURCES_PATH,
    );
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, sources: body.sources ?? [] });
    }
    const list =
      (yield* decodeBody(Sources, SOURCES_PATH)({ sources: body.sources ?? [] })).sources ?? [];
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim("· business metric importer sources")}`,
    );
    yield* Print.line();
    if (list.length === 0) {
      return yield* Print.line(
        c.dim(
          "No connected account can feed a business metric yet. Connect AWS, GCP, Snowflake, " +
            "ClickHouse, PostgreSQL, MySQL or Metronome.",
        ),
      );
    }
    for (const s of list) {
      const readOnly =
        s.source.readOnly === "enforced"
          ? "read-only enforced"
          : s.source.readOnly === "validated"
            ? "SELECT/WITH only"
            : "";
      yield* Print.line(
        `${c.bold(safe(s.accountName))} ${c.dim(`(${safe(s.accountId)})`)}  ${safe(s.source.label)}  ${c.dim(readOnly)}`,
      );
      for (const f of s.source.fields) {
        const extra = [
          safe(f.type),
          f.required ? "required" : "optional",
          f.dependsOn?.length ? `after ${f.dependsOn.map(safe).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        yield* Print.line(`  ${safe(f.key).padEnd(16)} ${safe(f.label)} ${c.dim(`[${extra}]`)}`);
      }
      yield* Print.line();
    }
    yield* Print.line(
      c.dim(
        "Configure one with `infrawrench unit-costs importer <metric> set --account <id> " +
          "--set <field>=<value>` (`--set sql=@query.sql` reads a file).",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Accounts that can feed a business metric on a schedule, and the fields each importer takes",
  ),
);

const printImporter = Effect.fnUntraced(function* (importer: Importer) {
  const rows: Array<[string, string]> = [
    [
      "source",
      `${safe(importer.sourceLabel ?? "?")} · ${importer.accountName !== null ? safe(importer.accountName) : c.yellow("removed account")}`,
    ],
    ["status", statusLabel(importer)],
    ["schedule", `${safe(importer.schedule)}, restating ${importer.backfillDays} day(s)`],
    ["timezone", safe(importer.timezone)],
    ["aggregation", safe(importer.aggregation)],
    ["last run", importer.lastRunAt !== null ? safe(importer.lastRunAt) : c.dim("never")],
    ["next run", importer.nextRunAt !== null ? safe(importer.nextRunAt) : c.dim("—")],
  ];
  for (const [k, v] of rows) yield* Print.line(`${c.dim(k.padEnd(12))} ${v}`);
  if (importer.lastError) {
    yield* Print.line(`${c.dim("last error".padEnd(12))} ${c.red(safe(importer.lastError))}`);
  }
  for (const [k, v] of Object.entries(importer.params)) {
    const shown = v.includes("\n") ? `\n${v.replace(/^/gm, "    ")}` : v;
    yield* Print.line(`${c.dim(`param ${k}`.padEnd(12))} ${shown}`);
  }
});

const printRuns = (runs: ReadonlyArray<Run>) =>
  runs.length === 0
    ? Print.line(c.dim("No runs yet."))
    : Print.table(runs, [
        { header: "started", value: (r) => safe(r.startedAt.replace("T", " ").slice(0, 19)) },
        { header: "trigger", value: (r) => safe(r.trigger) },
        {
          header: "status",
          value: (r) =>
            r.status === "error"
              ? c.red("error")
              : r.status === "running"
                ? c.dim("running")
                : c.green("ok"),
        },
        { header: "window", value: (r) => `${safe(r.from)} → ${safe(r.to)}` },
        { header: "days", align: "right", value: (r) => String(r.daysWritten) },
        { header: "points", align: "right", value: (r) => String(r.pointsRead) },
        { header: "error", value: (r) => (r.error ? c.red(safe(r.error.slice(0, 80))) : "") },
      ]);

const IMPORTER_VERBS = ["show", "runs", "run", "set", "enable", "disable", "delete"] as const;

/**
 * `infrawrench unit-costs importer <metric> [show|runs|run|set|enable|disable|delete]`.
 */
export const importer = Command.make(
  "importer",
  {
    metric: Argument.String("metric").pipe(
      Argument.withDescription("The business metric's key"),
      Argument.optional,
    ),
    action: Argument.String(IMPORTER_VERBS.join("|")).pipe(
      Argument.withDescription("What to do (default show)"),
      Argument.optional,
    ),
    file: fileFlag.pipe(
      Flag.withDescription("set: the whole importer as a JSON document (- for stdin)"),
    ),
    set: Flag.String("set").pipe(
      Flag.withMetavar("field=value"),
      Flag.withDescription(
        "set: one field (schedule, backfillDays, timezone, aggregation, enabled, or a source param); @file reads a value; repeatable",
      ),
      Flag.atLeast(0),
    ),
    from: fromFlag.pipe(Flag.withDescription("run: backfill from this day")),
    to: toFlag.pipe(Flag.withDescription("run: backfill to this day")),
  },
  Effect.fn("unit-costs.importer")(function* (input) {
    if (Option.isNone(input.metric)) {
      return yield* usage("Usage: infrawrench unit-costs importer <metric> [action]");
    }
    const metric = input.metric.value;
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const base = `/business-metrics/${encodeURIComponent(metric)}/importer`;
    const json = session.output === "json";
    const verb = Option.getOrElse(input.action, () => "show");
    const shownMetric = safe(metric);

    const current = Effect.gen(function* () {
      const body = yield* api.decode(Schema.Struct({ importer: Schema.Unknown }), org.id, base);
      return {
        raw: body.importer,
        importer: body.importer === null ? null : yield* decodeBody(Importer, base)(body.importer),
      };
    });
    const runs = Effect.fnUntraced(function* (limit: number) {
      const path = `${base}/runs?limit=${limit}`;
      const body = yield* api.decode(
        Schema.Struct({ runs: Schema.optional(Schema.Unknown) }),
        org.id,
        path,
      );
      const raw = body.runs ?? [];
      return { raw, runs: yield* decodeBody(Schema.Array(Run), path)(raw) };
    });

    switch (verb) {
      case "show": {
        const { raw, importer: saved } = yield* current;
        const recent = saved ? yield* runs(10) : { raw: [], runs: [] };
        if (json) {
          return yield* Print.json({ org: org.id, metric, importer: raw, runs: recent.raw });
        }
        if (!saved) {
          return yield* Print.line(
            c.dim(
              `${shownMetric} has no importer; its values are only pushed. See \`infrawrench unit-costs sources\`.`,
            ),
          );
        }
        yield* Print.line(`${c.bold(shownMetric)} ${c.dim("· importer")}`);
        yield* Print.line();
        yield* printImporter(saved);
        yield* Print.line();
        return yield* printRuns(recent.runs);
      }
      case "runs": {
        const recent = yield* runs(50);
        if (json) return yield* Print.json({ org: org.id, metric, runs: recent.raw });
        return yield* printRuns(recent.runs);
      }
      case "run": {
        const body: Record<string, string> = {};
        if (Option.isSome(input.from) && input.from.value) body["from"] = input.from.value;
        if (Option.isSome(input.to) && input.to.value) body["to"] = input.to.value;
        const path = `${base}/run`;
        const runBody = yield* api.json(org.id, path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const run = yield* decodeBody(Run, path)(runBody);
        if (json) {
          yield* Print.json({ org: org.id, metric, run: runBody });
        } else if (run.status === "success") {
          yield* Print.line(
            `${c.green("✓")} ${run.daysWritten} day(s) written, ${safe(run.from)} → ${safe(run.to)} ${c.dim(`(${run.pointsRead} points, ${run.durationMs ?? 0} ms)`)}`,
          );
          for (const note of run.notes) yield* Print.line(c.dim(`  ${safe(note)}`));
        } else {
          yield* Print.line(`${c.red("✗")} ${safe(run.error ?? "the run failed")}`);
        }
        if (run.status === "error") {
          return yield* new CliFailure({ message: "The import run failed." });
        }
        return;
      }
      case "enable":
      case "disable": {
        const { importer: saved } = yield* current;
        if (!saved) {
          return yield* new CliFailure({ message: `${metric} has no importer to ${verb}.` });
        }
        const next: BusinessMetricImporterInput["enabled"] = verb === "enable";
        const savedBody = yield* api.json(org.id, base, {
          method: "PUT",
          body: JSON.stringify({ ...asInput(saved), enabled: next }),
        });
        if (json) return yield* Print.json({ org: org.id, metric, importer: savedBody });
        return yield* Print.line(
          `${shownMetric}: importer ${verb === "enable" ? "enabled" : "paused"}.`,
        );
      }
      case "set": {
        // Edit in place: start from what is saved, so `--set schedule=weekly`
        // changes one thing rather than resetting the rest to defaults.
        let body: ImporterBody;
        if (Option.isSome(input.file)) {
          body = yield* readBody(input.file.value);
        } else {
          const { importer: saved } = yield* current;
          body = saved ? asInput(saved) : { accountId: "", params: {} };
        }
        if (session.account) {
          const wanted = session.account;
          const list = (yield* api.decode(Sources, org.id, SOURCES_PATH)).sources ?? [];
          const needle = wanted.toLowerCase();
          const match = list.find(
            (s) => s.accountId === wanted || s.accountName.toLowerCase() === needle,
          );
          if (!match) {
            return yield* new CliFailure({
              message: `No importer source called "${wanted}". Run \`infrawrench unit-costs sources\`.`,
            });
          }
          if (match.accountId !== body.accountId) body.params = {};
          body.accountId = match.accountId;
        }
        for (const entry of input.set) {
          const [key, value] = yield* parseSet(entry);
          if (!HOST_KEYS.has(key)) {
            body.params[key] = value;
            continue;
          }
          if (key === "backfillDays") body[key] = Number(value);
          else if (key === "enabled") body[key] = value === "true" || value === "1";
          else body[key] = value;
        }
        if (!body.accountId) {
          return yield* usage("Pick a source account with --account (see `unit-costs sources`).");
        }
        const savedBody = yield* api.json(org.id, base, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        if (json) return yield* Print.json({ org: org.id, metric, importer: savedBody });
        yield* Print.line(
          `${c.green("✓")} importer saved for ${shownMetric}. The first run is due now.`,
        );
        yield* Print.line();
        return yield* printImporter(yield* decodeBody(Importer, base)(savedBody));
      }
      case "delete": {
        yield* api.json(org.id, base, { method: "DELETE" });
        if (json) return yield* Print.json({ org: org.id, metric, deleted: true });
        return yield* Print.line(`${shownMetric}: importer removed. Imported values stay.`);
      }
      default:
        return yield* usage(
          `Unknown importer action "${verb}". Use show, runs, run, set, enable, disable or delete.`,
        );
    }
  }),
).pipe(
  Command.withDescription(
    "A metric's scheduled importer: config and recent runs, run now (--from/--to backfill), set, enable, disable, delete",
  ),
);
