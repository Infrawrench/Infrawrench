// `infrawrench commitments reports [name|id]` and `infrawrench commitments
// report`: saved commitment reports (coverage, utilization, savings and
// commitment cost over time) and an unsaved run of the same query. Text
// output is hand-rolled (a headline per currency, a sparkline, a table of the
// key metrics); `--json` prints the server's result as is; `--format csv`
// writes the CSV the web and desktop export buttons save.
//
// Cloud-only: the reports read server-side cost rows and the commitment
// inventory. The metric definitions, labels and the CSV writer are
// client-core's; the request schema the ad-hoc config is checked with is the
// contract's, the same one the API decodes it with.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CommitmentKind,
  CommitmentReport,
  CommitmentReportConfig,
  CommitmentReportFilters,
  CommitmentReportGranularity,
  CommitmentReportGroupBy,
  CommitmentReportMetric,
  CommitmentReportNotice,
  CommitmentReportOptions,
  CommitmentReportResult,
  CommitmentReportRunResult,
  CommitmentReportSeries,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { destination, destinationOf, formatOf, writeOrPrint } from "../effect/file-flags";
import * as Print from "../effect/print";
import { dateRange, resolveDateRange } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { rangedSparkline, sparkline } from "../charts";
import { matchCostReport } from "../format";
import { c, type Column, formatMoney, safe } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const LIST_PATH = "/commitments/reports";
const QUERY_PATH = "/commitments/report-query";
const OPTIONS_PATH = "/commitments/report-options";

// The vocabularies, restated: the CLI's client-core imports are type-only at
// module scope, and the flags below need the values when the module loads.
// Each `satisfies` fails the build when client-core drops a value, and each
// tuple check below it when client-core adds one.
const METRICS = [
  "coverage",
  "eligibleCoverage",
  "utilization",
  "effectiveSavingsRate",
  "netSavings",
  "onDemandRemainder",
  "commitmentCost",
  "usedCommitmentCost",
  "unusedCommitmentCost",
] as const satisfies readonly CommitmentReportMetric[];
[true] satisfies [CommitmentReportMetric extends (typeof METRICS)[number] ? true : never];

const GRANULARITIES = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
] as const satisfies readonly CommitmentReportGranularity[];
[true] satisfies [
  CommitmentReportGranularity extends (typeof GRANULARITIES)[number] ? true : never,
];

const GROUP_BYS = [
  "none",
  "provider",
  "commitment_type",
  "commitment",
  "service",
  "account",
  "region",
] as const satisfies readonly CommitmentReportGroupBy[];
[true] satisfies [CommitmentReportGroupBy extends (typeof GROUP_BYS)[number] ? true : never];

const KINDS = [
  "reservation",
  "savings_plan",
  "committed_use",
] as const satisfies readonly CommitmentKind[];
[true] satisfies [CommitmentKind extends (typeof KINDS)[number] ? true : never];

/** Whether a metric is a ratio (0 to 1, printed as %); client-core's set, restated. */
const RATIO_METRICS: ReadonlySet<CommitmentReportMetric> = new Set([
  "coverage",
  "eligibleCoverage",
  "utilization",
  "effectiveSavingsRate",
]);

/**
 * The columns the text table carries, under headers short enough to fit a
 * terminal; `--json` and the CSV carry every metric under its full name.
 */
const TABLE_METRICS: ReadonlyArray<readonly [CommitmentReportMetric, string]> = [
  ["coverage", "coverage"],
  ["utilization", "utilization"],
  ["effectiveSavingsRate", "ESR"],
  ["netSavings", "net savings"],
  ["onDemandRemainder", "on-demand"],
  ["usedCommitmentCost", "used"],
  ["unusedCommitmentCost", "unused"],
];

const NOTICE_TEXT: Partial<Record<string, string>> = {
  unused_lumped_monthly:
    "A provider in scope books a month's unused commitment on one day (the 1st, or the purchase day): use monthly granularity for its utilization.",
  unattributed_commitment_usage:
    "Some covered usage is not tied to a commitment: the provider's billing data does not say which one covered it.",
  partial_savings_measurement:
    "Some covered usage has no reported on-demand price and counts as saving nothing: savings are a lower bound.",
  no_measurable_accounts:
    "No account in scope reports covered usage separately: coverage, utilization and savings cannot be measured.",
} satisfies Record<CommitmentReportNotice, string>;

// ─── Response schemas ──────────────────────────────────────────────────────

const Report = wire<CommitmentReport>()(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    config: Schema.Struct({
      metric: knownOr(METRICS),
      granularity: Schema.String,
      groupBy: Schema.String,
    }),
  }),
);
const Reports = Schema.Array(Report);
type ReportRow = typeof Report.Type;

const Totals = Schema.Struct({
  covered: Schema.Finite,
  coveredAll: Schema.Finite,
  unused: Schema.Finite,
  uncovered: Schema.Finite,
  uncoveredEligible: Schema.Finite,
  coveredOnDemand: Schema.Finite,
  coveredMeasured: Schema.Finite,
});

const Ratio = Schema.NullOr(Schema.Finite);
const Metrics = Schema.Struct({
  coverage: Ratio,
  eligibleCoverage: Ratio,
  utilization: Ratio,
  effectiveSavingsRate: Ratio,
  netSavings: Schema.NullOr(Schema.Finite),
  onDemandRemainder: Schema.Finite,
  commitmentCost: Schema.Finite,
  usedCommitmentCost: Schema.Finite,
  unusedCommitmentCost: Schema.Finite,
  onDemandEquivalent: Schema.Finite,
  savingsMeasuredShare: Ratio,
});
type Metrics = typeof Metrics.Type;

const Series = Schema.Struct({
  id: Schema.String,
  groupKey: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  points: Schema.Array(Schema.Struct({ bucket: Schema.String, totals: Totals, metrics: Metrics })),
  total: Schema.Struct({ totals: Totals, metrics: Metrics }),
});
type Series = typeof Series.Type;

/**
 * A result, decoded for the text and the CSV. The enums the text only labels
 * decode as known-or-raw, so a newer server's grouping or notice still
 * renders; provider statuses stay strings for the same reason.
 */
const resultFields = {
  from: Schema.String,
  to: Schema.String,
  granularity: knownOr(GRANULARITIES),
  groupBy: knownOr(GROUP_BYS),
  buckets: Schema.Array(Schema.String),
  series: Schema.Array(Series),
  overall: Schema.Array(Series),
  providers: Schema.Array(
    Schema.Struct({ pluginId: Schema.String, displayName: Schema.String, status: Schema.String }),
  ),
  notices: Schema.Array(Schema.String),
};
const Result = wire<CommitmentReportResult>()(Schema.Struct(resultFields));
type Result = typeof Result.Type;
const RunResult = wire<CommitmentReportRunResult>()(
  Schema.Struct({ ...resultFields, reportId: Schema.String, name: Schema.String }),
);

/** The picker values, for the ad-hoc query's filter flags. */
const Options = wire<CommitmentReportOptions>()(
  Schema.Struct({
    providers: Schema.Array(Schema.Struct({ pluginId: Schema.String, displayName: Schema.String })),
    accounts: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    services: Schema.Array(Schema.String),
    regions: Schema.Array(Schema.String),
    commitments: Schema.Array(
      Schema.Struct({ commitmentId: Schema.String, description: Schema.String }),
    ),
  }),
);
type Options = typeof Options.Type;

// ─── Flags ─────────────────────────────────────────────────────────────────

const metricFlag = Flag.Literals("metric", METRICS).pipe(
  Flag.withDescription("The metric the sparkline draws (the table and CSV carry every metric)"),
);

const csvFormat = formatOf(["csv"], () => "--format takes csv for commitment reports.");

/** A repeatable filter flag, resolved against `report-options` by the command. */
const repeatable = (name: string, metavar: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withMetavar(metavar),
    Flag.withDescription(`${description} (repeatable)`),
    Flag.atLeast(0),
  );

// ─── Rendering ─────────────────────────────────────────────────────────────

const raw = <A extends string>(value: A | Unrecognized): string =>
  value instanceof Unrecognized ? value.raw : value;

/** A label off one of client-core's tables, or the raw value a newer server sent. */
const label = (table: Partial<Record<string, string>>, value: string): string =>
  table[value] ?? safe(value);

const isRatio = (metric: CommitmentReportMetric) => RATIO_METRICS.has(metric);

/** A dash for "nothing to measure": a null ratio is never printed as 0. */
function metricText(metric: CommitmentReportMetric, value: number | null, currency: string) {
  if (value === null) return c.dim("-");
  return isRatio(metric) ? `${(value * 100).toFixed(1)}%` : formatMoney(value, currency);
}

function seriesLabel(core: Core, s: Series, groupBy: Result["groupBy"]): string {
  if (s.groupKey === core.COMMITMENT_REPORT_ON_DEMAND_KEY) return "on demand (not covered)";
  if (s.groupKey === core.COMMITMENT_REPORT_UNATTRIBUTED_KEY) {
    return "covered, commitment not reported";
  }
  if (s.groupKey === core.COMMITMENT_REPORT_UNKNOWN_KIND_KEY) return "commitment not in inventory";
  if (groupBy === "commitment_type") return label(core.COMMITMENT_KIND_LABELS, s.groupKey);
  if (groupBy === "none") return "all commitments";
  return s.label ? safe(s.label) : c.dim("(not set)");
}

const printResult = Effect.fnUntraced(function* (
  core: Core,
  result: Result,
  metric: CommitmentReportMetric,
  title: string,
) {
  const groupByLabel = label(core.COMMITMENT_REPORT_GROUP_BY_LABELS, raw(result.groupBy));
  yield* Print.line(
    `${c.bold(safe(title))} ${c.dim(
      `· ${result.from} to ${result.to} · ${label(core.COMMITMENT_REPORT_GRANULARITY_LABELS, raw(result.granularity)).toLowerCase()}` +
        (result.groupBy !== "none" ? ` · by ${groupByLabel.toLowerCase()}` : ""),
    )}`,
  );
  const names = (status: string) =>
    result.providers
      .filter((p) => p.status === status)
      .map((p) => safe(p.displayName))
      .join(", ");
  const measured = names("measured");
  const inventoryOnly = names("inventory_only");
  if (measured) yield* Print.line(c.dim(`  measured: ${measured}`));
  if (inventoryOnly) {
    yield* Print.line(
      c.dim(
        `  not measured (holdings only, their cost data has no coverage signal): ${inventoryOnly}`,
      ),
    );
  }
  for (const n of result.notices) yield* Print.line(c.yellow(`  ${NOTICE_TEXT[n] ?? safe(n)}`));
  yield* Print.line();

  for (const s of result.overall) {
    const m = s.total.metrics;
    const coverage =
      m.coverage !== null && m.eligibleCoverage !== null && m.eligibleCoverage - m.coverage > 0.0005
        ? `${metricText("coverage", m.coverage, s.currency)}–${metricText("eligibleCoverage", m.eligibleCoverage, s.currency)}`
        : metricText("coverage", m.coverage, s.currency);
    yield* Print.line(
      `${c.bold(safe(s.currency))}  coverage ${coverage}  ·  utilization ${metricText("utilization", m.utilization, s.currency)}  ·  ESR ${metricText("effectiveSavingsRate", m.effectiveSavingsRate, s.currency)}`,
    );
    yield* Print.line(
      c.dim(
        `     net savings ${metricText("netSavings", m.netSavings, s.currency)} · on-demand remainder ${formatMoney(m.onDemandRemainder, s.currency)} · commitment ${formatMoney(m.commitmentCost, s.currency)} (${formatMoney(m.usedCommitmentCost, s.currency)} used, ${formatMoney(m.unusedCommitmentCost, s.currency)} unused)`,
      ),
    );
    // A gap (null) drops out of the line rather than drawing as zero.
    const values = s.points.flatMap((p) => {
      const value = p.metrics[metric];
      return value === null ? [] : [value];
    });
    if (values.length > 1) {
      const width = Math.min(48, values.length);
      const line = isRatio(metric)
        ? rangedSparkline(values, Math.min(0, ...values), Math.max(1, ...values), width)
        : sparkline(values, width);
      yield* Print.line(`     ${core.COMMITMENT_REPORT_METRIC_LABELS[metric]}  ${line}`);
    }
  }
  yield* Print.line();

  interface Row {
    readonly label: string;
    readonly currency: string;
    readonly metrics: Metrics;
  }
  const rows: Row[] =
    result.groupBy === "none"
      ? result.overall.flatMap((s) =>
          s.points.map((p) => ({ label: p.bucket, currency: s.currency, metrics: p.metrics })),
        )
      : result.series.map((s) => ({
          label: seriesLabel(core, s, result.groupBy),
          currency: s.currency,
          metrics: s.total.metrics,
        }));
  if (rows.length === 0) {
    return yield* Print.line(c.dim("No commitment or usage spend in this window."));
  }
  const columns: Column<Row>[] = [
    {
      header: result.groupBy === "none" ? "period" : groupByLabel.toLowerCase(),
      value: (r) => r.label,
    },
    ...TABLE_METRICS.map(([m, header]): Column<Row> => ({
      header,
      value: (r) => metricText(m, r.metrics[m], r.currency),
      align: "right",
    })),
  ];
  yield* Print.table(rows, columns);
  yield* Print.line(
    c.dim(
      "Amortized basis. ESR is the effective savings rate; used and unused are commitment cost. A dash means nothing to measure, not zero. --json or --format csv for every metric.",
    ),
  );
});

const copySeries = (s: Series): CommitmentReportSeries => ({
  ...s,
  points: s.points.map((p) => ({
    bucket: p.bucket,
    totals: { ...p.totals },
    metrics: { ...p.metrics },
  })),
  total: { totals: { ...s.total.totals }, metrics: { ...s.total.metrics } },
});

/**
 * The result as client-core's CSV writer takes it. The writer reads the
 * grouping only to tell "none" from any other, and never the granularity,
 * providers or notices, so a value this build does not know cannot change the
 * file.
 */
const forCsv = (result: Result): CommitmentReportResult => ({
  from: result.from,
  to: result.to,
  granularity: result.granularity instanceof Unrecognized ? "daily" : result.granularity,
  groupBy: result.groupBy instanceof Unrecognized ? "service" : result.groupBy,
  buckets: [...result.buckets],
  series: result.series.map(copySeries),
  overall: result.overall.map(copySeries),
  providers: [],
  notices: [],
});

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Commitment reports live in Infrawrench Cloud: they read server-side cost rows and the commitment inventory.",
    });
  }
});

const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

// ─── commitments reports ───────────────────────────────────────────────────

const listReports = Effect.fnUntraced(function* (
  core: Core,
  orgId: string,
  body: unknown,
  reports: ReadonlyArray<ReportRow>,
) {
  const session = yield* CliSession;
  if (session.output === "json") return yield* Print.json({ org: orgId, reports: body });
  if (reports.length === 0) {
    return yield* Print.line(
      c.dim(
        "No commitment reports. Create one on the Costs page under Commitments, or run an unsaved one with `infrawrench commitments report`.",
      ),
    );
  }
  yield* Print.table(reports, [
    { header: "report", value: (r) => safe(r.name) },
    {
      header: "chart",
      value: (r) => label(core.COMMITMENT_REPORT_METRIC_LABELS, raw(r.config.metric)),
    },
    {
      header: "granularity",
      value: (r) => label(core.COMMITMENT_REPORT_GRANULARITY_LABELS, r.config.granularity),
    },
    {
      header: "group by",
      value: (r) => label(core.COMMITMENT_REPORT_GROUP_BY_LABELS, r.config.groupBy),
    },
    { header: "id", value: (r) => c.dim(r.id) },
  ]);
});

export const commitmentReports = Command.make(
  "reports",
  {
    query: Argument.String("name|id").pipe(
      Argument.withDescription("A report to run (the words join into one name)"),
      Argument.variadic(),
    ),
    metric: metricFlag.pipe(Flag.optional),
    format: csvFormat,
    ...destination,
  },
  Effect.fn("commitments.reports")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const core = yield* loadCore;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, LIST_PATH);
    const reports = (yield* decodePaired(Reports, LIST_PATH)(body)).map((r) => r.row);

    const query = input.query.join(" ");
    if (!query) return yield* listReports(core, org.id, body, reports);

    const found = matchCostReport(reports, query);
    if (!found.match) {
      return yield* new CliFailure({
        message:
          found.candidates.length > 1
            ? `"${query}" matches ${found.candidates.length} commitment reports: ${found.candidates.map((r) => safe(r.name)).join(", ")}. Use the id.`
            : `No commitment report named "${query}". Run \`infrawrench commitments reports\` to see the saved ones.`,
      });
    }
    const report = found.match;
    const runPath = `/commitments/reports/${encodeURIComponent(report.id)}/run`;
    const resultBody = yield* api.json(org.id, runPath, { method: "POST", body: "{}" });
    // `--json` passes the body through undecoded: a field a newer server
    // reshaped cannot stop a script from reading the rest.
    if (Option.isNone(input.format) && session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, resultBody, runPath));
    }
    const result = yield* decodeBody(RunResult, runPath)(resultBody);
    if (Option.isSome(input.format)) {
      return yield* writeOrPrint(destinationOf(input), core.commitmentReportToCsv(forCsv(result)));
    }
    const saved = report.config.metric;
    const metric = Option.getOrElse(input.metric, () =>
      saved instanceof Unrecognized ? "coverage" : saved,
    );
    yield* printResult(core, result, metric, result.name);
  }),
).pipe(
  Command.withDescription(
    "Saved commitment reports, or run one: coverage, utilization, savings and commitment cost over time (cloud only)",
  ),
  Command.withExamples([
    { command: "infrawrench commitments reports", description: "List the saved reports" },
    {
      command: 'infrawrench commitments reports "EC2 coverage" --metric utilization',
      description: "Run one, charting utilization",
    },
    {
      command: 'infrawrench commitments reports "EC2 coverage" --format csv --out ec2.csv',
      description: "Write its CSV",
    },
  ]),
);

// ─── commitments report ────────────────────────────────────────────────────

/**
 * A flag's values resolved to what `report-options` lists, so the config the
 * server receives names each one exactly as it stores it: an exact value
 * first, then a unique case-insensitive match on the value or its name.
 * Repeats collapse, since the contract refuses a list that names a value twice.
 */
const resolveValues = Effect.fnUntraced(function* (
  flag: string,
  wanted: ReadonlyArray<string>,
  choices: ReadonlyArray<{ readonly value: string; readonly name: string }>,
  noun: string,
) {
  const resolved: string[] = [];
  for (const text of wanted) {
    const query = text.trim();
    const lower = query.toLowerCase();
    const exact = choices.find((choice) => choice.value === query);
    const matches = exact
      ? [exact]
      : choices.filter(
          (choice) => choice.value.toLowerCase() === lower || choice.name.toLowerCase() === lower,
        );
    const [match] = matches;
    if (match === undefined || matches.length > 1) {
      const listed = (matches.length > 1 ? matches : choices).map((choice) => safe(choice.value));
      const shown = listed.length > 12 ? `${listed.slice(0, 12).join(", ")}, …` : listed.join(", ");
      return yield* new CliFailure({
        message:
          matches.length > 1
            ? `--${flag} "${query}" matches ${matches.length} ${noun}s: ${shown}. Pass one exactly as listed.`
            : listed.length === 0
              ? `--${flag} "${query}": no ${noun} you can see has commitment data.`
              : `--${flag} "${query}" is not a ${noun} with commitment data. Choices: ${shown}.`,
      });
    }
    if (!resolved.includes(match.value)) resolved.push(match.value);
  }
  return resolved;
});

export const commitmentReport = Command.make(
  "report",
  {
    ...dateRange,
    bin: Flag.ChoiceWithValue("bin", [
      ["day", "daily"],
      ["week", "weekly"],
      ["month", "monthly"],
      ["quarter", "quarterly"],
    ] as const).pipe(
      Flag.withDescription(
        "Bucket size (no hourly: spend is stored one row per day, so an hour would be invented)",
      ),
      Flag.withDefault("weekly" as const),
    ),
    groupBy: Flag.Literals("group-by", GROUP_BYS).pipe(
      Flag.withDescription("Split the report by this dimension"),
      Flag.withDefault("none" as const),
    ),
    metric: metricFlag.pipe(Flag.withDefault("coverage" as const)),
    provider: repeatable("provider", "id|name", "Only this provider (aws, azure, gcp)"),
    service: repeatable("service", "name", "Only this service, as the provider names it"),
    region: repeatable("region", "region", "Only this region"),
    commitmentType: Flag.Literals("commitment-type", KINDS).pipe(
      Flag.withDescription("Only commitments of this kind (repeatable)"),
      Flag.atLeast(0),
    ),
    commitment: repeatable("commitment", "id|description", "Only this commitment"),
    format: csvFormat,
    ...destination,
  },
  Effect.fn("commitments.report")(function* (input) {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const core = yield* loadCore;
    const org = yield* currentOrg;

    // `-a` is the global account flag; one account, as everywhere else.
    const accounts = session.account === null ? [] : [session.account];
    const needsOptions = [
      input.provider,
      input.service,
      input.region,
      input.commitment,
      accounts,
    ].some((values) => values.length > 0);
    const options: Options | null = needsOptions
      ? yield* api.decode(Options, org.id, OPTIONS_PATH)
      : null;
    const pick = (
      flag: string,
      wanted: ReadonlyArray<string>,
      noun: string,
      choices: (o: Options) => ReadonlyArray<{ value: string; name: string }>,
    ) =>
      options === null || wanted.length === 0
        ? Effect.succeed<string[]>([])
        : resolveValues(flag, wanted, choices(options), noun);

    const providers = yield* pick("provider", input.provider, "provider", (o) =>
      o.providers.map((p) => ({ value: p.pluginId, name: p.displayName })),
    );
    const accountIds = yield* pick("account", accounts, "account", (o) =>
      o.accounts.map((a) => ({ value: a.id, name: a.name })),
    );
    const services = yield* pick("service", input.service, "service", (o) =>
      o.services.map((s) => ({ value: s, name: s })),
    );
    const regions = yield* pick("region", input.region, "region", (o) =>
      o.regions.map((r) => ({ value: r, name: r })),
    );
    const commitmentIds = yield* pick("commitment", input.commitment, "commitment", (o) =>
      o.commitments.map((h) => ({ value: h.commitmentId, name: h.description })),
    );

    // A list only when it says something: the contract refuses an empty one
    // rather than reading it as absent, so a config has one spelling.
    const filters: CommitmentReportFilters = {};
    if (providers.length > 0) filters.providers = providers;
    if (input.commitmentType.length > 0)
      filters.commitmentTypes = [...new Set(input.commitmentType)];
    if (services.length > 0) filters.services = services;
    if (accountIds.length > 0) filters.accountIds = accountIds;
    if (regions.length > 0) filters.regions = regions;
    if (commitmentIds.length > 0) filters.commitmentIds = commitmentIds;

    const explicitRange =
      Option.isSome(input.last) || Option.isSome(input.from) || Option.isSome(input.to);
    const window = resolveDateRange(input, 90);
    const config: CommitmentReportConfig = {
      version: 1,
      // No range flags is the editor's default, resolved by the server against its today.
      dateRange: explicitRange
        ? { kind: "absolute", from: window.from.slice(0, 10), to: window.to.slice(0, 10) }
        : { kind: "relative", preset: "90d" },
      granularity: input.bin,
      groupBy: input.groupBy,
      filters,
      metric: input.metric,
    };

    // The contract's own schema, the one the API decodes the body with: a
    // window too long for its granularity, or a day that does not exist, is a
    // usage mistake here rather than a 400 from the server.
    const contract = yield* Effect.promise(() => import("@infrawrench/api-contract/schemas"));
    yield* Schema.decodeUnknownEffect(contract.CommitmentReportConfig)(config).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(new CliUsageError({ message: `Invalid report: ${error.message}` })),
      ),
    );

    const body = yield* api.json(org.id, QUERY_PATH, {
      method: "POST",
      body: JSON.stringify(config),
    });
    if (Option.isNone(input.format) && session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, config }, body, QUERY_PATH));
    }
    const result = yield* decodeBody(Result, QUERY_PATH)(body);
    if (Option.isSome(input.format)) {
      return yield* writeOrPrint(destinationOf(input), core.commitmentReportToCsv(forCsv(result)));
    }
    yield* printResult(core, result, input.metric, org.displayName);
  }),
).pipe(
  Command.withDescription(
    "An unsaved commitment report: coverage, utilization, savings and commitment cost over time (cloud only)",
  ),
  Command.withExamples([
    {
      command: "infrawrench commitments report --last 180d --bin month --group-by commitment_type",
      description: "Six months, monthly, split by commitment type",
    },
    {
      command: "infrawrench commitments report --provider aws -a prod --metric utilization",
      description: "One AWS account, charting utilization",
    },
  ]),
);
