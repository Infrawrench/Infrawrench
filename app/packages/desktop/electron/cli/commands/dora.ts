// `infrawrench dora`: the four DORA metrics for production, with their bands,
// the previous period, a sparkline trend per metric and a breakdown by any
// scope dimension. `dora changes` is the drill-down (with `--failed`),
// `dora restores` the recoveries, `dora settings` what counts as production.
//
// Cloud-only: deploy events and incidents live in the cloud. Types come from
// `@infrawrench/client-core` type-only; formatting and bands are loaded with a
// dynamic import, the main project's rule for client-core runtime code. Zero
// new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  DoraChangesResponse,
  DoraMetric,
  DoraQuery,
  DoraReport,
  DoraRestoresResponse,
  DoraSettingsView,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { days, from, groupBy, lastDays, to } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { sparkline } from "../charts";
import { formatChangeTime } from "../format";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const DAY_MS = 86_400_000;

/** The window flags, as parsed. */
export interface DoraWindowInput {
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly days: Option.Option<number>;
  readonly last: Option.Option<number>;
}

/** `--from`/`--to` (dates or timestamps) win; `--last`/`--days` size the window ending now. */
export const doraWindow = (
  input: DoraWindowInput,
  now = Date.now(),
): Effect.Effect<{ from: string; to: string }, CliUsageError> =>
  Effect.gen(function* () {
    const parse = (v: string, flag: string) => {
      const t = Date.parse(v);
      return Number.isFinite(t)
        ? Effect.succeed(t)
        : Effect.fail(
            new CliUsageError({
              message: `Invalid --${flag} "${v}": use YYYY-MM-DD or an ISO timestamp`,
            }),
          );
    };
    const toMs = Option.isSome(input.to) ? yield* parse(input.to.value, "to") : now;
    const span = Option.getOrElse(
      Option.orElse(input.days, () =>
        Option.map(input.last, (last) => Math.max(1, Math.round(last))),
      ),
      () => 30,
    );
    const fromMs = Option.isSome(input.from)
      ? yield* parse(input.from.value, "from")
      : toMs - span * DAY_MS;
    if (fromMs >= toMs) {
      return yield* new CliUsageError({ message: "--from must be before --to" });
    }
    if (toMs - fromMs > 366 * DAY_MS) {
      return yield* new CliUsageError({ message: "The range is at most 366 days" });
    }
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  });

/** `--scope owner=user:abc` filters to one value; `--scope owner` to "not known". */
export const parseDoraScope = (
  scope: string | undefined,
): Effect.Effect<Pick<DoraQuery, "dimension" | "value">, CliUsageError> => {
  if (!scope) return Effect.succeed({});
  const eq = scope.indexOf("=");
  if (eq < 0) return Effect.succeed({ dimension: scope.trim(), value: null });
  const dimension = scope.slice(0, eq).trim();
  const value = scope.slice(eq + 1).trim();
  if (!dimension) {
    return Effect.fail(
      new CliUsageError({ message: `Invalid --scope "${scope}": use <dimension>=<value>` }),
    );
  }
  return Effect.succeed({ dimension, value: value || null });
};

const BANDS = ["elite", "high", "medium", "low"] as const;
type Band = (typeof BANDS)[number];

export function bandCell(band: Band | Unrecognized | null): string {
  // A band a newer server added prints under its own name, uncoloured.
  if (band instanceof Unrecognized) return c.dim(safe(band.raw));
  switch (band) {
    case "elite":
      return c.green("elite");
    case "high":
      return c.cyan("high");
    case "medium":
      return c.yellow("medium");
    case "low":
      return c.red("low");
    case null:
      return c.dim("-");
  }
}

const MetricValue = {
  value: Schema.NullOr(Schema.Finite),
  band: Schema.NullOr(knownOr(BANDS)),
  sample: Schema.Finite,
};

const Summary = Schema.Struct({
  deploymentFrequency: Schema.Struct({ ...MetricValue, deploys: Schema.Finite }),
  leadTime: Schema.Struct({ ...MetricValue, p90Hours: Schema.NullOr(Schema.Finite) }),
  changeFailureRate: Schema.Struct({
    ...MetricValue,
    changes: Schema.Finite,
    failures: Schema.Finite,
  }),
  timeToRestore: Schema.Struct({ ...MetricValue, restores: Schema.Finite }),
});
type Summary = typeof Summary.Type;

const Report = wire<DoraReport>()(
  Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    bucket: Schema.String,
    filter: Schema.NullOr(
      Schema.Struct({ dimension: Schema.String, value: Schema.NullOr(Schema.String) }),
    ),
    groupBy: Schema.String,
    summary: Summary,
    previous: Summary,
    trend: Schema.Array(
      Schema.Struct({
        deploys: Schema.Finite,
        leadTimeMedianHours: Schema.NullOr(Schema.Finite),
        changeFailureRate: Schema.NullOr(Schema.Finite),
        restoreMedianHours: Schema.NullOr(Schema.Finite),
      }),
    ),
    breakdown: Schema.Array(
      Schema.Struct({ key: Schema.NullOr(Schema.String), label: Schema.String, summary: Summary }),
    ),
    dimensions: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    eventCount: Schema.Finite,
    scopeValues: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })),
    ),
  }),
);
type Report = typeof Report.Type;

const Change = Schema.Struct({
  at: Schema.String,
  name: Schema.String,
  isRollback: Schema.Boolean,
  environment: Schema.NullOr(Schema.String),
  commitSha: Schema.NullOr(Schema.String),
  leadTimeHours: Schema.NullOr(Schema.Finite),
  pluginId: Schema.NullOr(Schema.String),
  source: Schema.String,
  failure: Schema.NullOr(
    Schema.Struct({
      kind: knownOr(["incident", "rollback", "failed_deploy", "reverted"]),
      title: Schema.String,
    }),
  ),
});
type Change = typeof Change.Type;

const Changes = wire<DoraChangesResponse>()(
  Schema.Struct({ changes: Schema.Array(Change), truncated: Schema.Boolean }),
);

const Restores = wire<DoraRestoresResponse>()(
  Schema.Struct({
    restores: Schema.Array(
      Schema.Struct({
        restoredAt: Schema.String,
        kind: Schema.String,
        title: Schema.String,
        hours: Schema.Finite,
      }),
    ),
  }),
);

const Settings = wire<DoraSettingsView>()(
  Schema.Struct({
    productionEnvironments: Schema.Array(Schema.String),
    pipelinePatterns: Schema.Array(Schema.String),
    failureWindowHours: Schema.Finite,
    countFailedDeploys: Schema.Boolean,
    includeResourceChanges: Schema.Boolean,
    digestEnabled: Schema.Boolean,
  }),
);

function arrow(core: Core, metric: DoraMetric, cur: number | null, prev: number | null): string {
  const dir = core.doraTrendDirection(metric, cur, prev);
  if (dir === "better") return c.green("▲ better");
  if (dir === "worse") return c.red("▼ worse");
  if (dir === "flat") return c.dim("= same");
  return "";
}

function metricRows(core: Core, report: Report) {
  const s = report.summary;
  const p = report.previous;
  const trend = (pick: (b: Report["trend"][number]) => number | null) => {
    const values = report.trend.map((b) => pick(b) ?? 0);
    return values.length > 1 ? sparkline(values, Math.min(values.length, 40)) : "";
  };
  return [
    {
      name: "deployment frequency",
      value:
        s.deploymentFrequency.deploys > 0
          ? core.formatDeployFrequency(s.deploymentFrequency.value)
          : "none",
      detail: `${s.deploymentFrequency.deploys} deploys`,
      band: s.deploymentFrequency.band,
      prev: core.formatDeployFrequency(p.deploymentFrequency.value),
      delta: arrow(
        core,
        "deployment_frequency",
        s.deploymentFrequency.value,
        p.deploymentFrequency.value,
      ),
      spark: trend((b) => b.deploys),
    },
    {
      name: "lead time",
      value: core.formatDoraHours(s.leadTime.value),
      detail:
        s.leadTime.sample > 0
          ? `median of ${s.leadTime.sample}, p90 ${core.formatDoraHours(s.leadTime.p90Hours)}`
          : "no commit times",
      band: s.leadTime.band,
      prev: core.formatDoraHours(p.leadTime.value),
      delta: arrow(core, "lead_time", s.leadTime.value, p.leadTime.value),
      spark: trend((b) => b.leadTimeMedianHours),
    },
    {
      name: "change failure rate",
      value: core.formatDoraRate(s.changeFailureRate.value),
      detail: `${s.changeFailureRate.failures} of ${s.changeFailureRate.changes} changes`,
      band: s.changeFailureRate.band,
      prev: core.formatDoraRate(p.changeFailureRate.value),
      delta: arrow(
        core,
        "change_failure_rate",
        s.changeFailureRate.value,
        p.changeFailureRate.value,
      ),
      spark: trend((b) => b.changeFailureRate),
    },
    {
      name: "time to restore",
      value: core.formatDoraHours(s.timeToRestore.value),
      detail: `${s.timeToRestore.restores} recoveries`,
      band: s.timeToRestore.band,
      prev: core.formatDoraHours(p.timeToRestore.value),
      delta: arrow(core, "time_to_restore", s.timeToRestore.value, p.timeToRestore.value),
      spark: trend((b) => b.restoreMedianHours),
    },
  ];
}

function scopeLabel(report: Report): string {
  const filter = report.filter;
  if (!filter) return "all production";
  const dim = report.dimensions.find((d) => d.id === filter.dimension)?.label ?? filter.dimension;
  if (filter.value === null) return `${dim.toLowerCase()} not known`;
  const v = report.scopeValues[filter.dimension]?.find((x) => x.key === filter.value);
  return `${dim.toLowerCase()} ${v?.label ?? filter.value}`;
}

function failureCell(change: Change): string {
  const f = change.failure;
  if (!f) return "";
  // A failure kind a newer server added prints under its own name.
  if (f.kind instanceof Unrecognized) return c.red(safe(f.kind.raw));
  switch (f.kind) {
    case "incident":
      return c.red(`incident: ${safe(f.title)}`);
    case "rollback":
      return c.red("rolled back");
    case "failed_deploy":
      return c.red("deploy failed");
    case "reverted":
      return c.red("reverted");
  }
}

function bandSummary(s: Summary): string {
  return [
    s.deploymentFrequency.band,
    s.leadTime.band,
    s.changeFailureRate.band,
    s.timeToRestore.band,
  ]
    .map((b) => bandCell(b))
    .join(c.dim(" "));
}

/** The window and scope flags every view reads. */
const windowFlags = {
  last: lastDays,
  days,
  from,
  to,
  scope: Flag.String("scope").pipe(
    Flag.withMetavar("dimension[=value]"),
    Flag.withDescription("Only this scope value (no value: where it is not known)"),
    Flag.optional,
  ),
};

/** Cloud only, client-core loaded, the org resolved, and the query the flags ask for. */
const prepare = Effect.fnUntraced(function* (
  input: DoraWindowInput & { readonly scope: Option.Option<string> },
) {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Delivery metrics live in Infrawrench Cloud, beside the deploys and incidents. Drop --local.",
    });
  }
  const core: Core = yield* Effect.promise(() => import("@infrawrench/client-core"));
  const org = yield* currentOrg;
  const window = yield* doraWindow(input);
  const query: DoraQuery = {
    ...window,
    ...(yield* parseDoraScope(Option.getOrUndefined(input.scope))),
  };
  return { core, org, window, query };
});

const settings = Command.make(
  "settings",
  windowFlags,
  Effect.fn("dora.settings")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { org } = yield* prepare(input);
    const path = "/dora/settings";
    const body = yield* api.json(org.id, path);
    if (session.output === "json") return yield* Print.json({ org: org.id, settings: body });
    const s = yield* decodeBody(Settings, path)(body);
    yield* Print.line(c.bold("Delivery settings"));
    yield* Print.line(`production environments  ${safe(s.productionEnvironments.join(", "))}`);
    yield* Print.line(
      `deploy pipelines         ${s.pipelinePatterns.length > 0 ? safe(s.pipelinePatterns.join(", ")) : c.dim("none")}`,
    );
    yield* Print.line(`failure window           ${s.failureWindowHours}h`);
    yield* Print.line(`failed deploys count     ${s.countFailedDeploys ? "yes" : "no"}`);
    yield* Print.line(`resource changes count   ${s.includeResourceChanges ? "yes" : "no"}`);
    yield* Print.line(`weekly digest line       ${s.digestEnabled ? "on" : "off"}`);
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Edit them on the Delivery tab (Settings), or with the infrawrench_dora_settings Terraform resource.",
      ),
    );
  }),
).pipe(Command.withDescription("What counts as production, a deploy and a failure"));

const changes = Command.make(
  "changes",
  {
    ...windowFlags,
    failed: Flag.Boolean("failed").pipe(
      Flag.withDescription("Only the changes that failed"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("dora.changes")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { core, org, window, query } = yield* prepare(input);
    const path = `/dora/changes?${core.doraQueryString({ ...query, failedOnly: input.failed })}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, ...window }, body, path));
    }
    const res = yield* decodeBody(Changes, path)(body);
    if (res.changes.length === 0) {
      return yield* Print.line(
        c.dim(
          input.failed
            ? "No failed production changes in the range."
            : "No production changes in the range.",
        ),
      );
    }
    const columns: Column<Change>[] = [
      { header: "when", value: (x) => c.dim(formatChangeTime(x.at)) },
      {
        header: "change",
        value: (x) => `${safe(x.name)}${x.isRollback ? c.yellow(" (rollback)") : ""}`,
      },
      { header: "env", value: (x) => safe(x.environment ?? "-") },
      { header: "commit", value: (x) => c.dim(x.commitSha ? safe(x.commitSha.slice(0, 7)) : "-") },
      { header: "lead time", value: (x) => core.formatDoraHours(x.leadTimeHours), align: "right" },
      { header: "source", value: (x) => c.dim(safe(x.pluginId ?? x.source)) },
      { header: "failure", value: failureCell },
    ];
    yield* Print.table(res.changes, columns);
    if (res.truncated) {
      yield* Print.line(
        c.dim(`Showing the newest ${res.changes.length}. Narrow --last or --scope for the rest.`),
      );
    }
  }),
).pipe(Command.withDescription("The production changes behind the numbers (--failed: failures)"));

const restores = Command.make(
  "restores",
  windowFlags,
  Effect.fn("dora.restores")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { core, org, window, query } = yield* prepare(input);
    const path = `/dora/restores?${core.doraQueryString(query)}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, ...window }, body, path));
    }
    const res = yield* decodeBody(Restores, path)(body);
    if (res.restores.length === 0) {
      return yield* Print.line(c.dim("No incidents resolved or deploys rolled back in the range."));
    }
    yield* Print.table(res.restores, [
      { header: "restored", value: (r) => c.dim(formatChangeTime(r.restoredAt)) },
      { header: "kind", value: (r) => (r.kind === "incident" ? "incident" : c.yellow("rollback")) },
      { header: "what", value: (r) => safe(r.title) },
      { header: "took", value: (r) => core.formatDoraHours(r.hours), align: "right" },
    ]);
  }),
).pipe(Command.withDescription("Incidents resolved and deploys rolled back: time to restore"));

export const dora = Command.make(
  "dora",
  {
    ...windowFlags,
    groupBy: groupBy.pipe(Flag.withDescription("Break the metrics down by a scope dimension")),
  },
  Effect.fn("dora")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { core, org, query } = yield* prepare(input);
    const group = Option.getOrUndefined(input.groupBy);
    const path = `/dora?${core.doraQueryString({ ...query, ...(group ? { groupBy: group } : {}) })}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const report = yield* decodeBody(Report, path)(body);

    const span = Math.round((Date.parse(report.to) - Date.parse(report.from)) / DAY_MS);
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· delivery · last ${span} days · ${safe(scopeLabel(report))}`)}`,
    );
    yield* Print.line();
    if (report.eventCount === 0 && report.summary.changeFailureRate.changes === 0) {
      yield* Print.line(
        c.dim(
          "No deploys in the range. Metrics come from Infrawrench deploys, synced provider deploys,",
        ),
      );
      return yield* Print.line(
        c.dim("CI pipelines named in the settings, GitHub deployments and POST /dora/deployments."),
      );
    }
    yield* Print.table(metricRows(core, report), [
      { header: "metric", value: (r) => r.name },
      { header: "value", value: (r) => c.bold(r.value), align: "right" },
      { header: "band", value: (r) => bandCell(r.band) },
      { header: "previous", value: (r) => c.dim(r.prev), align: "right" },
      { header: "", value: (r) => r.delta },
      { header: `trend (per ${safe(report.bucket)})`, value: (r) => c.cyan(r.spark) },
      { header: "", value: (r) => c.dim(r.detail) },
    ]);

    if (report.breakdown.length > 0) {
      const dim = safe(
        report.dimensions.find((d) => d.id === report.groupBy)?.label ?? report.groupBy,
      );
      yield* Print.line();
      yield* Print.line(c.bold(`by ${dim.toLowerCase()}`));
      yield* Print.table(report.breakdown, [
        {
          header: dim.toLowerCase(),
          value: (r) => (r.key === null ? c.dim("not known") : safe(r.label)),
        },
        {
          header: "deploys",
          value: (r) => String(r.summary.deploymentFrequency.deploys),
          align: "right",
        },
        {
          header: "frequency",
          value: (r) => core.formatDeployFrequency(r.summary.deploymentFrequency.value),
          align: "right",
        },
        {
          header: "lead time",
          value: (r) => core.formatDoraHours(r.summary.leadTime.value),
          align: "right",
        },
        {
          header: "failure",
          value: (r) => core.formatDoraRate(r.summary.changeFailureRate.value),
          align: "right",
        },
        {
          header: "restore",
          value: (r) => core.formatDoraHours(r.summary.timeToRestore.value),
          align: "right",
        },
        { header: "", value: (r) => bandSummary(r.summary) },
      ]);
    }
    yield* Print.line();
    yield* Print.line(
      c.dim("`dora changes [--failed]` and `dora restores` list what is behind the numbers."),
    );
    yield* Print.line(
      c.dim(
        `Scope with --scope <${report.dimensions.map((d) => safe(d.id)).join("|")}>=<value>; group with --group-by.`,
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "DORA metrics for production: deploy frequency, lead time, change failure rate, time to restore",
  ),
  Command.withSubcommands([changes, restores, settings]),
);
