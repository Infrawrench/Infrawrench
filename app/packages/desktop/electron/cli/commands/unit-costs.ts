/**
 * `infrawrench unit-costs`: business metrics and what a unit of the business
 * actually costs.
 *
 * Deliberately not `infrawrench metrics`: that verb already means "chart a
 * resource's provider metrics" and taking it would break a shipped command.
 * `unit-costs` names the question this command answers, and hyphenated
 * top-level verbs are already the house style (`status-pages`, `ssh-fanout`).
 *
 * With no argument it lists the org's metrics and how well each is being fed:
 * a metric nobody is reporting produces a chart made entirely of gaps, and that
 * failure is silent everywhere else. With a metric key it draws the ratio.
 *
 * The one rule this command must never break: **a period with no reported
 * metric value prints as a dash, never as 0.** The chart skips it and the table
 * dims it. A CLI that printed `$0.00` for an unmeasured day would be believed
 * exactly as readily as a chart that drew a zero.
 */
import { Effect, Option, Predicate, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  BusinessMetric,
  BusinessMetricLabelSummary,
  CostBasis,
  CostBinningId,
  UnitCostQueryRequest,
  UnitCostQueryResponse,
  UnitCostScale,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { formatOf } from "../effect/file-flags";
import * as Print from "../effect/print";
import {
  basis as basisFlag,
  currency as currencyFlag,
  dateRange,
  groupBy as groupByFlag,
  resolveDateRange,
  where as whereFlag,
} from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, formatNumber, safe, type Column } from "../output";
import {
  type CliUnitCostMode,
  formatUnitCostRatio,
  parseUnitCostLabelFlag,
  parseUnitCostModeFlag,
  parseUnitCostScaleFlag,
  unitCostRatioLabel,
} from "../format";
import { sparkline } from "../charts";
import { importer, sources } from "./unit-cost-importers";

const COST_BASES: readonly CostBasis[] = ["cash", "amortized", "blended"];
const BINNINGS = [
  "daily",
  "weekly",
  "monthly",
  "cumulative",
] as const satisfies readonly CostBinningId[];
const SCALES: readonly UnitCostScale[] = [1, 100, 1_000, 1_000_000, 1_000_000_000];
const MODES = ["unit_cost", "margin", "usage_unit_cost", "raw_metric"] as const;

const usage = (message: string) => new CliUsageError({ message });

const refuseLocal = (message: string) =>
  CliSession.use((session) =>
    session.local ? Effect.fail(new CliFailure({ message })) : Effect.void,
  );

const Metrics = wire<{ metrics: BusinessMetric[] }>()(
  Schema.Struct({
    metrics: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        name: Schema.String,
        unit: Schema.String,
        kind: Schema.String,
        currency: Schema.NullOr(Schema.String),
        costScope: Schema.Array(Schema.Unknown),
        coverage: Schema.NullOr(
          Schema.Struct({
            firstDay: Schema.String,
            lastDay: Schema.String,
            reportedDays: Schema.Finite,
          }),
        ),
      }),
    ),
  }),
);
type Metric = (typeof Metrics.Type)["metrics"][number];

const UsageUnits = Schema.Struct({
  units: Schema.Array(
    Schema.Struct({
      unit: Schema.String,
      usage: Schema.Finite,
      services: Schema.Array(Schema.String),
    }),
  ),
});

const Labels = wire<{ labels: BusinessMetricLabelSummary[] }>()(
  Schema.Struct({
    labels: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        values: Schema.Array(Schema.String),
        truncated: Schema.Boolean,
        mapping: Schema.NullOr(
          Schema.Struct({
            kind: Schema.String,
            dimension: Schema.optional(Schema.String),
            tagKey: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
);

const Point = Schema.Struct({
  bucket: Schema.String,
  value: Schema.NullOr(Schema.Finite),
  cost: Schema.Finite,
  metricValue: Schema.NullOr(Schema.Finite),
  absoluteMargin: Schema.optional(Schema.NullOr(Schema.Finite)),
  gap: Schema.optional(Schema.String),
  reportedDays: Schema.Finite,
  bucketDays: Schema.Finite,
});
type Point = typeof Point.Type;

const Series = Schema.Struct({
  currency: Schema.String,
  label: Schema.optional(
    Schema.Struct({ value: Schema.NullOr(Schema.String), other: Schema.optional(Schema.Boolean) }),
  ),
  points: Schema.Array(Point),
  overallValue: Schema.NullOr(Schema.Finite),
  overallCost: Schema.Finite,
  overallMetricValue: Schema.NullOr(Schema.Finite),
  overallAbsoluteMargin: Schema.optional(Schema.NullOr(Schema.Finite)),
});
type Series = typeof Series.Type;

const Response = wire<UnitCostQueryResponse>()(
  Schema.Struct({
    metric: Schema.NullOr(Schema.Struct({ name: Schema.String, unit: Schema.String })),
    mode: knownOr(MODES),
    scale: Schema.Finite,
    usageUnit: Schema.optional(Schema.String),
    groupByLabel: Schema.optional(Schema.String),
    costPerLabel: Schema.optional(Schema.Boolean),
    series: Schema.Array(Series),
    gapBuckets: Schema.Finite,
    partialBuckets: Schema.Finite,
  }),
);

/** How well a metric is being fed, as one short phrase. */
function coverageLabel(metric: Metric): string {
  if (!metric.coverage) return "never reported";
  const { firstDay, lastDay, reportedDays } = metric.coverage;
  const span =
    Math.round(
      (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  const missing = span - reportedDays;
  return missing > 0 ? `${reportedDays}d (${missing} missing)` : `${reportedDays}d`;
}

const METRICS_PATH = "/business-metrics";

/** `infrawrench unit-costs`: the org's business metrics. */
const listMetrics = Effect.fnUntraced(function* () {
  yield* refuseLocal("Business metrics live in Infrawrench Cloud, next to the spend they divide.");
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.decode(
    Schema.Struct({ metrics: Schema.optional(Schema.Unknown) }),
    org.id,
    METRICS_PATH,
  );

  if (session.output === "json") {
    return yield* Print.json({ org: org.id, metrics: body.metrics ?? [] });
  }
  const { metrics } = yield* decodeBody(
    Metrics,
    METRICS_PATH,
  )({
    metrics: body.metrics ?? [],
  });

  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· business metrics")}`);
  yield* Print.line();

  if (metrics.length === 0) {
    return yield* Print.line(
      c.dim(
        "No business metrics yet. Create one on the Costs panel, then report its daily values " +
          "from a workflow with infra.businessMetrics.write, over the API, or by hand.",
      ),
    );
  }

  yield* Print.table(metrics, [
    { header: "key", value: (m) => safe(m.key) },
    { header: "name", value: (m) => safe(m.name) },
    { header: "unit", value: (m) => safe(m.unit) },
    {
      header: "kind",
      value: (m) => (m.kind === "currency" ? `revenue (${safe(m.currency)})` : "count"),
    },
    {
      header: "scope",
      value: (m) =>
        m.costScope.length === 0
          ? c.dim("all spend")
          : `${m.costScope.length} filter${m.costScope.length === 1 ? "" : "s"}`,
    },
    {
      header: "reported",
      // Dimmed when there is nothing, because "never reported" is the answer
      // that explains an empty chart and it should read as a warning, not a
      // datum.
      value: (m) => (m.coverage ? coverageLabel(m) : c.yellow(coverageLabel(m))),
    },
  ]);
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Run `infrawrench unit-costs <key>` for the cost per unit. Only revenue metrics support " +
        "--margin.",
    ),
  );
});

/** `infrawrench unit-costs --usage-units`: the usage units the org's cost rows carry. */
const listUsageUnits = Effect.fnUntraced(function* () {
  yield* refuseLocal("Usage units come from Infrawrench Cloud's cost store.");
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const path = "/business-metrics/usage-units";
  const body = yield* api.decode(
    Schema.Struct({ units: Schema.optional(Schema.Unknown) }),
    org.id,
    path,
  );
  if (session.output === "json") return yield* Print.json({ org: org.id, units: body.units ?? [] });
  const { units } = yield* decodeBody(UsageUnits, path)({ units: body.units ?? [] });
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim("· usage units, last 90 days, most spend first")}`,
  );
  yield* Print.line();
  if (units.length === 0) {
    return yield* Print.line(c.dim("No cost rows report a usage quantity yet."));
  }
  yield* Print.table(units, [
    { header: "unit", value: (u) => safe(u.unit) },
    { header: "usage", align: "right", value: (u) => formatNumber(u.usage) },
    { header: "services", value: (u) => c.dim(u.services.map(safe).join(", ")) },
  ]);
  yield* Print.line();
  yield* Print.line(
    c.dim('Run `infrawrench unit-costs --usage-unit "<unit>"` for the cost per unit.'),
  );
});

/** `infrawrench unit-costs <metric> --labels`: label keys, values and mappings. */
const printLabels = Effect.fnUntraced(function* (
  org: { readonly id: string; readonly displayName: string },
  metric: string,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const path = `${METRICS_PATH}/${encodeURIComponent(metric)}/labels`;
  const body = yield* api.decode(
    Schema.Struct({ labels: Schema.optional(Schema.Unknown) }),
    org.id,
    path,
  );
  if (session.output === "json") {
    return yield* Print.json({ org: org.id, metric, labels: body.labels ?? [] });
  }
  const { labels } = yield* decodeBody(Labels, path)({ labels: body.labels ?? [] });
  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim(`· ${safe(metric)} · labels`)}`);
  yield* Print.line();
  if (labels.length === 0) {
    return yield* Print.line(
      c.dim("No labelled values yet. Report values with labels to split this metric."),
    );
  }
  yield* Print.table(labels, [
    { header: "label", value: (l) => safe(l.key) },
    {
      header: "maps to",
      value: (l) =>
        !l.mapping
          ? c.dim("not mapped (raw metric only)")
          : l.mapping.kind === "cost_centre"
            ? "cost centre"
            : l.mapping.tagKey
              ? `${safe(l.mapping.dimension)} ${safe(l.mapping.tagKey)}`
              : safe(l.mapping.dimension ?? l.mapping.kind),
    },
    {
      header: "values",
      value: (l) =>
        `${l.values.slice(0, 6).map(safe).join(", ")}${l.values.length > 6 || l.truncated ? c.dim(" …") : ""}`,
    },
  ]);
});

/** Short reasons for the gap column, matching the API's enum. */
const GAP_REASONS: Partial<Record<string, string>> = {
  no_metric_value: "not reported",
  non_positive_metric_value: "value was 0 or negative",
  unconvertible_currency: "no rate to the metric's currency",
  no_usage: "no usage in this unit",
};

/** What the calculation reads off the command line. */
interface UnitCostInput {
  readonly last: Option.Option<number>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly groupBy: Option.Option<string>;
  readonly basis: Option.Option<string>;
  readonly currency: Option.Option<string>;
  readonly where: Option.Option<string>;
  readonly margin: boolean;
  readonly mode: Option.Option<string>;
  readonly scale: Option.Option<string>;
  readonly label: ReadonlyArray<string>;
  readonly split: Option.Option<string>;
  readonly usageUnit: Option.Option<string>;
  readonly labels: boolean;
  readonly format: Option.Option<"csv" | "ndjson">;
}

/** A legacy `format.ts` parser's thrown sentence as a usage error. */
const parsed = <A>(parse: () => A) =>
  Effect.try({
    try: parse,
    catch: (e) => usage(e instanceof Error ? e.message : String(e)),
  });

/** `infrawrench unit-costs <metric>` (or `--usage-unit <unit>`): the calculation over time. */
const unitCosts = Effect.fnUntraced(function* (metric: string | null, input: UnitCostInput) {
  yield* refuseLocal("Unit costs live in Infrawrench Cloud. There is no local cost history.");
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;

  if (metric && input.labels) return yield* printLabels(org, metric);

  let mode = yield* parsed(() => parseUnitCostModeFlag(Option.getOrUndefined(input.mode)));
  const scale = yield* parsed(() => parseUnitCostScaleFlag(Option.getOrUndefined(input.scale)));
  const labelFilters = yield* parsed(() => input.label.map(parseUnitCostLabelFlag));
  if (input.margin) {
    if (mode && mode !== "margin") return yield* usage("--margin and --mode disagree.");
    mode = "margin";
  }
  const usageUnit = Option.getOrUndefined(input.usageUnit);
  if (usageUnit) {
    if (mode && mode !== "usage_unit_cost") {
      return yield* usage("--usage-unit is the per-usage-unit calculation; drop --mode.");
    }
    mode = "usage_unit_cost";
  }
  if (mode === "usage_unit_cost" && !usageUnit) {
    return yield* usage(
      "Cost per usage unit needs --usage-unit. List the units with `infrawrench unit-costs --usage-units`.",
    );
  }
  if (mode !== "usage_unit_cost" && !metric) {
    return yield* usage("Name a metric key, or pass --usage-unit for cost per usage unit.");
  }

  const wantedBinning = Option.getOrElse(input.groupBy, () => "daily");
  const binning = BINNINGS.find((b) => b === wantedBinning);
  if (binning === undefined) {
    return yield* usage(
      `--group-by must be one of daily, weekly, monthly, cumulative (got "${wantedBinning}").`,
    );
  }

  const { from, to } = resolveDateRange(input);

  let basis: CostBasis | undefined;
  if (Option.isSome(input.basis)) {
    const wanted = input.basis.value;
    basis = COST_BASES.find((b) => b === wanted);
    if (!basis) {
      return yield* usage(`--basis must be one of ${COST_BASES.join(", ")} (got "${wanted}").`);
    }
  }
  let displayCurrency: string | undefined;
  if (Option.isSome(input.currency)) {
    displayCurrency = input.currency.value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(displayCurrency)) {
      return yield* usage(
        `--currency must be a three-letter code like USD (got "${input.currency.value}").`,
      );
    }
  }
  const where = Option.getOrUndefined(input.where);
  const request: UnitCostQueryRequest = {
    from,
    to,
    binning,
    ...(where ? { query: where } : {}),
    ...(basis ? { costBasis: basis } : {}),
    ...(displayCurrency ? { displayCurrency } : {}),
  };
  // Set only when asked, so a default never reaches the wire: "absent means
  // unit cost" is the contract, and sending it would make every request differ
  // from the one an older client sends for no behavioural reason.
  if (mode && mode !== "unit_cost") request.mode = mode;
  const wireScale = SCALES.find((s) => s === scale);
  if (wireScale !== undefined && wireScale !== 1) request.scale = wireScale;
  if (labelFilters.length > 0) request.labelFilters = labelFilters;
  const split = Option.getOrUndefined(input.split);
  if (split) request.groupByLabel = split;
  if (usageUnit) request.usageUnit = usageUnit;

  const path =
    mode === "usage_unit_cost" || metric === null
      ? `${METRICS_PATH}/usage-unit-costs`
      : `${METRICS_PATH}/${encodeURIComponent(metric)}/unit-costs`;

  // `--format csv|ndjson`: the server's export of the same query, verbatim on
  // stdout, so `> unit-costs.csv` captures a clean file. One row per bucket per
  // series with the spend and metric value behind each ratio; a gap is an
  // empty value, never 0.
  if (Option.isSome(input.format)) {
    return yield* Print.write(
      yield* api.text(org.id, `${path}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, format: input.format.value }),
      }),
    );
  }

  const body = yield* api.json(org.id, path, { method: "POST", body: JSON.stringify(request) });

  if (session.output === "json") {
    const { mode: answered } = yield* decodeBody(
      Schema.Struct({ mode: Schema.String }),
      path,
    )(body);
    // The resolved inputs first, then the response; the response's own
    // `metric`, `mode` and `binning` are authoritative, so they are spread last.
    return yield* Print.json(
      yield* spreadBody(
        {
          org: org.id,
          requestedMetric: metric,
          from,
          to,
          costBasis: basis ?? "cash",
          displayCurrency: displayCurrency ?? null,
          margin: answered === "margin",
        },
        body,
        path,
      ),
    );
  }
  const response = yield* decodeBody(Response, path)(body);

  // A mode this build does not know reads like a unit cost: a ratio of spend.
  const resolvedMode: CliUnitCostMode =
    response.mode instanceof Unrecognized ? "unit_cost" : response.mode;
  const unit = safe(
    resolvedMode === "usage_unit_cost"
      ? (response.usageUnit ?? "unit")
      : (response.metric?.unit ?? "unit"),
  );
  const subject = safe(response.metric?.name ?? `usage in ${response.usageUnit ?? "?"}`);
  const labelFor = (currency: string) =>
    unitCostRatioLabel(resolvedMode, safe(currency), unit, response.scale);
  const seriesName = (s: Series) =>
    s.label ? (s.label.other ? "Other" : safe(s.label.value ?? "(no label)")) : safe(s.currency);

  const scope = [`${from} → ${to}`, binning, basis ?? "cash"].join(" · ");
  const groupByLabel =
    response.groupByLabel === undefined ? undefined : safe(response.groupByLabel);
  const headline = groupByLabel
    ? `${response.series.length} values of ${groupByLabel}`
    : response.series
        .map((s) => {
          const margin = Predicate.isNotNullish(s.overallAbsoluteMargin)
            ? ` (${formatNumber(s.overallAbsoluteMargin)} ${safe(s.currency)})`
            : "";
          return `${formatUnitCostRatio(s.overallValue, resolvedMode)} ${labelFor(s.currency)}${margin}`;
        })
        .join("  ");
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${subject} · ${scope}`)}  ${c.bold(headline || c.dim("—"))}`,
  );
  yield* Print.line();

  if (response.series.length === 0) {
    return yield* Print.line(
      c.dim(`No spend in scope for ${subject} over this range, so there is nothing to divide.`),
    );
  }

  // The caveats go above the numbers, not below: a reader who scrolls away
  // after the chart must not miss the fact that some periods are unmeasured.
  if (response.gapBuckets > 0) {
    yield* Print.line(
      `${c.yellow("!")} ${c.bold(String(response.gapBuckets))} ${c.dim(
        "period(s) have nothing to divide by. Shown as “—”, not zero.",
      )}`,
    );
  }
  if (response.partialBuckets > 0) {
    yield* Print.line(
      `${c.yellow("!")} ${c.bold(String(response.partialBuckets))} ${c.dim(
        "period(s) are only partly reported, so the ratio there reads high.",
      )}`,
    );
  }
  const currencies = new Set(response.series.map((s) => s.currency));
  if (currencies.size > 1) {
    yield* Print.line(
      `${c.yellow("!")} ${c.dim(
        "spend spans currencies with no stated rate, so each divides the metric on its own and the series are not comparable",
      )}`,
    );
  }
  if (response.gapBuckets > 0 || response.partialBuckets > 0 || currencies.size > 1) {
    yield* Print.line();
  }

  // A split prints one summary row per label value: twenty-five full tables
  // would bury the answer. --json carries every point.
  if (groupByLabel) {
    yield* Print.table(response.series, [
      { header: groupByLabel, value: (s) => seriesName(s) },
      {
        header: labelFor(response.series[0]?.currency ?? ""),
        align: "right",
        value: (s) =>
          s.overallValue === null ? c.dim("—") : formatUnitCostRatio(s.overallValue, resolvedMode),
      },
      {
        header: "cost",
        align: "right",
        value: (s) => `${formatNumber(s.overallCost)} ${safe(s.currency)}`,
      },
      {
        header: unit,
        align: "right",
        value: (s) =>
          s.overallMetricValue === null ? c.dim("—") : formatNumber(s.overallMetricValue),
      },
      {
        header: "trend",
        value: (s) => {
          const drawn = s.points.map((p) => p.value).filter(Predicate.isNotNull);
          return drawn.length > 1 ? sparkline(drawn, Math.min(drawn.length, 24)) : "";
        },
      },
    ]);
    if (response.costPerLabel === false) {
      yield* Print.line();
      yield* Print.line(
        c.dim(`${groupByLabel} is not mapped to spend, so every row's cost is the whole scope's.`),
      );
    }
    return;
  }

  for (const series of response.series) {
    const label = labelFor(series.currency);
    const currency = safe(series.currency);
    // The sparkline can only draw numbers, so gaps are dropped from it, which
    // is why the table below it is the authoritative rendering and prints every
    // bucket, gap included.
    const drawn = series.points.map((p) => p.value).filter(Predicate.isNotNull);
    if (drawn.length > 1) {
      yield* Print.line(`${c.dim(label)} ${sparkline(drawn, Math.min(drawn.length, 48))}`);
    }
    const columns: Column<Point>[] = [
      { header: "period", value: (p) => safe(p.bucket) },
      {
        header: label,
        align: "right",
        // The one rule: a gap is a dash. Never 0, never blank.
        value: (p) => (p.value === null ? c.dim("—") : formatUnitCostRatio(p.value, resolvedMode)),
      },
      { header: "cost", align: "right", value: (p) => `${formatNumber(p.cost)} ${currency}` },
      {
        header: unit,
        align: "right",
        value: (p) => (p.metricValue === null ? c.dim("—") : formatNumber(p.metricValue)),
      },
      ...(resolvedMode === "margin"
        ? [
            {
              header: "margin",
              align: "right",
              value: (p) =>
                Predicate.isNullish(p.absoluteMargin)
                  ? c.dim("—")
                  : `${formatNumber(p.absoluteMargin)} ${currency}`,
            } satisfies Column<Point>,
          ]
        : []),
      {
        header: "why",
        value: (p) =>
          p.gap
            ? c.dim(safe(GAP_REASONS[p.gap] ?? p.gap))
            : p.reportedDays > 0 && p.reportedDays < p.bucketDays
              ? c.yellow(`partial ${p.reportedDays}/${p.bucketDays}d`)
              : "",
      },
    ];
    yield* Print.table(series.points, columns);
    yield* Print.line();
  }

  yield* Print.line(
    c.dim(
      "Each period's ratio is that period's summed cost over its summed denominator; the " +
        "headline is the summed cost over the summed denominator across the whole range, not an " +
        "average of the rows.",
    ),
  );
});

// Not `metrics`: that verb already charts a resource's provider metrics, and
// taking it would break a shipped command. With no argument this lists the
// org's business metrics; with a key it draws the ratio.
export const unitCostsCommand = Command.make(
  "unit-costs",
  {
    metric: Argument.String("key").pipe(
      Argument.withDescription("The business metric (the words join into one key)"),
      Argument.variadic(),
    ),
    ...dateRange,
    groupBy: groupByFlag.pipe(
      Flag.withMetavar("daily|weekly|monthly|cumulative"),
      Flag.withDescription("The bins (default daily)"),
    ),
    basis: basisFlag.pipe(
      Flag.withMetavar("cash|amortized|blended"),
      Flag.withDescription("Which cost to divide (default cash)"),
    ),
    currency: currencyFlag,
    where: whereFlag.pipe(Flag.withDescription("Narrow the spend, in the cost query language")),
    margin: Flag.Boolean("margin").pipe(
      Flag.withDescription(
        "(revenue − cost) ÷ revenue instead of cost per unit; revenue metrics only",
      ),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    mode: Flag.String("mode").pipe(
      Flag.withMetavar("unit|margin|usage|raw"),
      Flag.withDescription("Which calculation"),
      Flag.optional,
    ),
    scale: Flag.String("scale").pipe(
      Flag.withMetavar("1|100|1k|1m|1b"),
      Flag.withDescription("Cost per this many units"),
      Flag.optional,
    ),
    label: Flag.String("label").pipe(
      Flag.withMetavar("key=v[,v]|key!=v"),
      Flag.withDescription("Only metric values with (or without) these labels; repeatable"),
      Flag.atLeast(0),
    ),
    split: Flag.String("split").pipe(
      Flag.withMetavar("label"),
      Flag.withDescription("One series per value of a metric label"),
      Flag.optional,
    ),
    usageUnit: Flag.String("usage-unit").pipe(
      Flag.withMetavar("unit"),
      Flag.withDescription("Cost per provider usage unit, no business metric needed"),
      Flag.optional,
    ),
    labels: Flag.Boolean("labels").pipe(
      Flag.withDescription("The metric's labels, their values and the cost dimension each maps to"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    usageUnits: Flag.Boolean("usage-units").pipe(
      Flag.withDescription("The usage units your cost rows carry"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    format: formatOf(
      ["csv", "ndjson"],
      (value) => `--format must be csv or ndjson (got "${value}").`,
    ).pipe(
      Flag.withDescription(
        "The series as a file on stdout: one row per bucket per series, with the spend and metric value behind each ratio",
      ),
    ),
  },
  Effect.fn("unit-costs")(function* (input) {
    const metric = input.metric.join(" ");
    if (metric) return yield* unitCosts(metric, input);
    // Metric-free forms: list the usage units, or divide by one.
    if (input.usageUnits) return yield* listUsageUnits();
    if (Option.isSome(input.usageUnit)) return yield* unitCosts(null, { ...input, margin: false });
    yield* listMetrics();
  }),
).pipe(
  Command.withDescription(
    "Business metrics and their cost per unit over time; a period with no reported value prints as —",
  ),
  Command.withSubcommands([sources, importer]),
);
