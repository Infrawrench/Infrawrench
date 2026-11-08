// `infrawrench costs`: org cost graphs in the terminal, backed by the same
// /costs/query API the web + desktop dashboards use, plus the cost questions
// that share the word: `--anomalies` (and its feedback verbs), `--alerts`,
// `tag-keys`, `forecast(s)`, `push` and `sources`.
//
// The response schemas are checked against `@infrawrench/client-core` (the
// same definitions the web, desktop, and mobile cost views describe the wire
// with) by `wire`, so a server-side change breaks the CLI's build instead of
// its output. The imports are type-only, plus the dynamic `import()` of the
// shared helpers, so the CLI still ships zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  CostAccountStatus,
  CostAlert,
  CostAlertEvent,
  CostBasis,
  CostBinningId,
  CostChargeType,
  CostDimensionId,
  CostDimensionOption,
  CostFilter,
  CostMeasure,
  CostQueryRequest,
  CostQueryResponse,
  KeyedCostDimensionId,
  SavedCostFilter,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import {
  basis as basisFlag,
  costDisplay,
  costScope,
  currency as currencyFlag,
  dateRange,
  days as daysFlag,
  groupBy as groupByFlag,
  limit as limitFlag,
  resolveDateRange,
  resolveDayWindow,
} from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { decodePaired, knownOr, type Paired, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, formatMoney, safe, seriesColor } from "../output";
import {
  anomalyDeltaPercent,
  anomalyDriverLabel,
  anomalyFeedbackLabel,
  formatGroupBy,
  KEYED_GROUP_DIMENSIONS,
  parseGroupByFlag,
  shortId,
} from "../format";
import { barChart, sparkline } from "../charts";
import {
  AnomalyRow,
  DIMENSION_LABELS,
  MAX_ANOMALY_DAYS,
  anomalyCommands,
} from "./anomaly-feedback";
import { costForecast, costForecasts } from "./forecasts";
import { costsPush } from "./push";
import { costSources, LOCAL_REFUSAL } from "./custom-costs";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const GROUP_DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "charge_type",
  "commitment",
] as const satisfies readonly CostDimensionId[];

// The keyed dimensions (`tag:env`, `virtual_tag:team`) are parsed by
// `parseGroupByFlag`; pinned to the wire type here so a dimension renamed
// upstream fails this file's typecheck rather than a request.
const KEYED_DIMENSIONS: readonly KeyedCostDimensionId[] = KEYED_GROUP_DIMENSIONS;

/**
 * The money bases and the measures, restated as plain arrays: client-core is
 * imported type-only, and typing them against the wire unions fails this
 * file's build when one is removed upstream.
 */
const COST_BASES: readonly CostBasis[] = ["cash", "amortized", "blended"];
const MEASURES: readonly CostMeasure[] = ["cost", "usage", "count"];

// Restated for `knownOr`: `wire` fails the build when client-core adds one.
const DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "tag",
  "charge_type",
  "commitment",
  "virtual_tag",
] as const;

/**
 * `--bin` spellings: the short noun (`quarter`, the one people type) or the
 * API's own adjective (`quarterly`), both accepted.
 */
const BINS: Partial<Record<string, CostBinningId>> = {
  hour: "hourly",
  hourly: "hourly",
  day: "daily",
  daily: "daily",
  week: "weekly",
  weekly: "weekly",
  month: "monthly",
  monthly: "monthly",
  quarter: "quarterly",
  quarterly: "quarterly",
};

/** `--local` refused in `message`'s words: every cost question is a cloud one. */
const refuseLocal = Effect.fnUntraced(function* (message: string) {
  const session = yield* CliSession;
  if (session.local) return yield* new CliFailure({ message });
});

/* ------------------------------------------------------------------ *
 * The display flags `costs` and `reports` share
 * ------------------------------------------------------------------ */

/** The display options `costs` and `reports` share, parsed and checked. */
export interface DisplayFlags {
  measure?: CostMeasure;
  binning?: CostBinningId;
  usageUnit?: string;
  cumulative?: boolean;
  /** A dimension on the X axis, or `date` (reports only) to put the bins back. */
  xAxis?: CostDimensionId | "date";
  xAxisTagKey?: string;
}

/** The display flags as `effect/cli` parsed them: `costDisplay` in `range-flags.ts`. */
export interface DisplayFlagValues {
  readonly measure: Option.Option<string>;
  readonly bin: Option.Option<string>;
  readonly unit: Option.Option<string>;
  readonly cumulative: boolean;
  readonly xAxis: Option.Option<string>;
}

const usage = (message: string) => new CliUsageError({ message });

/**
 * `--x-axis provider|service|tag:<key>|…|date`, in the `--group-by` spelling
 * (a keyed dimension carries its key after a colon). `date` and `none` mean
 * the date bins.
 */
function parseXAxisFlag(raw: string): Pick<DisplayFlags, "xAxis" | "xAxisTagKey"> | CliUsageError {
  const value = raw.trim();
  if (value === "date" || value === "none") return { xAxis: "date" };
  const parsed = parseGroupByFlag(value, GROUP_DIMENSIONS);
  if ("error" in parsed) return usage(parsed.error.replaceAll("--group-by", "--x-axis"));
  const dimension = DIMENSIONS.find((d) => d === parsed.groupBy);
  if (dimension === undefined) return { xAxis: "date" };
  return { xAxis: dimension, ...(parsed.tagKey ? { xAxisTagKey: parsed.tagKey } : {}) };
}

/**
 * `--measure`, `--bin`, `--unit`, `--cumulative`, `--x-axis` → the request
 * fields, each omitted when not given so an older server answers the request
 * it always did. Shape errors are caught here; the cross-field rules (a usage
 * query needs a unit, a count needs a group-by) are the shared
 * `costDisplayProblem`, checked by {@link checkDisplayFlags} once the
 * group-by is known.
 */
export const parseDisplayFlags = (
  input: DisplayFlagValues,
): Effect.Effect<DisplayFlags, CliUsageError> => {
  const flags: DisplayFlags = {};
  if (Option.isSome(input.measure)) {
    const wanted = input.measure.value;
    const measure = MEASURES.find((m) => m === wanted);
    if (!measure) {
      return Effect.fail(
        usage(`--measure must be one of ${MEASURES.join(", ")} (got "${wanted}").`),
      );
    }
    flags.measure = measure;
  }
  if (Option.isSome(input.bin)) {
    const binning = BINS[input.bin.value.toLowerCase()];
    if (!binning) {
      return Effect.fail(
        usage(`--bin must be one of hour, day, week, month, quarter (got "${input.bin.value}").`),
      );
    }
    flags.binning = binning;
  }
  const unit = Option.getOrUndefined(input.unit)?.trim();
  if (unit) flags.usageUnit = unit;
  if (input.cumulative) flags.cumulative = true;
  if (Option.isSome(input.xAxis)) {
    const axis = parseXAxisFlag(input.xAxis.value);
    if (axis instanceof CliUsageError) return Effect.fail(axis);
    Object.assign(flags, axis);
  }
  return Effect.succeed(flags);
};

const UsageUnits = wire<{ values: CostDimensionOption[] }>()(
  Schema.Struct({ values: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String }))) }),
);

/**
 * Refuse a combination the server would refuse, before the round trip, in the
 * server's own words (the rule is client-core's `costDisplayProblem`). A usage
 * query without a unit gets the units the org actually has listed, so the fix
 * is in the error message.
 */
export const checkDisplayFlags = Effect.fnUntraced(function* (
  orgId: string,
  q: {
    measure?: CostMeasure | undefined;
    usageUnit?: string | undefined;
    groupBy: CostQueryRequest["groupBy"];
    groupByTagKey?: string | undefined;
    binning: CostBinningId;
    cumulative?: boolean | undefined;
    xAxis?: CostDimensionId | undefined;
    xAxisTagKey?: string | undefined;
    segmentByDate?: boolean | undefined;
  },
) {
  if (q.measure === "usage" && !q.usageUnit) {
    const api = yield* CloudApi;
    const res = yield* api.decode(UsageUnits, orgId, "/costs/dimensions?dimension=usage-units");
    const units = (res.values ?? []).map((u) => u.value);
    return yield* usage(
      units.length > 0
        ? `--measure usage needs --unit: quantities in different units cannot be added. Units in your cost data: ${units.slice(0, 20).join(", ")}.`
        : "--measure usage needs --unit, and no connected provider reports usage quantities yet.",
    );
  }
  const { costDisplayProblem } = yield* loadCore;
  const problem = costDisplayProblem(q);
  if (problem) return yield* usage(problem);
});

/* ------------------------------------------------------------------ *
 * The query response, as the renderers read it
 * ------------------------------------------------------------------ */

const Point = Schema.Struct({ bucket: Schema.String, amount: Schema.Finite });
const QuerySeries = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  points: Schema.Array(Point),
});
type QuerySeries = typeof QuerySeries.Type;

const Conversion = Schema.Struct({
  displayCurrency: Schema.String,
  converted: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      rates: Schema.Array(
        Schema.Struct({
          effectiveFrom: Schema.String,
          rate: Schema.Finite,
          source: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  unconverted: Schema.Array(Schema.String),
});
type Conversion = typeof Conversion.Type;

/**
 * A `/costs/query` (or report run) body. `printDimensionAxis` and
 * `withPreviousTotal` take a `CostQueryResponse`; {@link asCostQuery}
 * projects this onto one.
 */
export const CostQuery = wire<CostQueryResponse>()(
  Schema.Struct({
    series: Schema.Array(QuerySeries),
    comparison: Schema.optionalKey(Schema.Array(QuerySeries)),
    currencies: Schema.Array(Schema.String),
    totals: Schema.Record(Schema.String, Schema.Finite),
    previousTotals: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
    conversion: Schema.optional(Conversion),
    measure: Schema.optionalKey(knownOr(["usage", "count"])),
    usageUnit: Schema.optionalKey(Schema.String),
    xAxis: Schema.optionalKey(
      Schema.Struct({
        dimension: knownOr(DIMENSIONS),
        tagKey: Schema.optionalKey(Schema.String),
        segment: knownOr(["none", "dimension", "date"]),
        values: Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })),
      }),
    ),
  }),
);
export type CostQuery = typeof CostQuery.Type;

const copySeries = (s: QuerySeries) => ({ ...s, points: s.points.map((p) => ({ ...p })) });

/**
 * The figures as the shared cost helpers take them. Each value this build
 * does not know is projected onto one that renders the same: a measure onto
 * usage without a unit (both print a bare number), a segment onto `dimension`
 * (the helpers only ask whether it is `date`), a dimension onto any (none of
 * them reads it).
 */
export function asCostQuery(q: CostQuery): CostQueryResponse {
  const unknownMeasure = q.measure instanceof Unrecognized;
  const measure = q.measure instanceof Unrecognized ? "usage" : q.measure;
  return {
    series: q.series.map(copySeries),
    currencies: [...q.currencies],
    totals: { ...q.totals },
    ...(q.comparison ? { comparison: q.comparison.map(copySeries) } : {}),
    ...(q.previousTotals ? { previousTotals: { ...q.previousTotals } } : {}),
    ...(measure ? { measure } : {}),
    ...(q.usageUnit !== undefined && !unknownMeasure ? { usageUnit: q.usageUnit } : {}),
    ...(q.xAxis
      ? {
          xAxis: {
            dimension: q.xAxis.dimension instanceof Unrecognized ? "service" : q.xAxis.dimension,
            ...(q.xAxis.tagKey !== undefined ? { tagKey: q.xAxis.tagKey } : {}),
            segment: q.xAxis.segment instanceof Unrecognized ? "dimension" : q.xAxis.segment,
            values: q.xAxis.values.map((v) => ({ ...v })),
          },
        }
      : {}),
  };
}

/**
 * The headline total with the previous period beside it, when the response
 * carries one: "$1,200.00 (prev $1,000.00, +20.0%)".
 */
export function withPreviousTotal(totalLine: string, response: CostQueryResponse): string {
  const currency = response.currencies[0];
  const prev = currency !== undefined ? response.previousTotals?.[currency] : undefined;
  if (prev === undefined || currency === undefined) return totalLine;
  const current = response.totals[currency] ?? 0;
  const pct =
    prev === 0
      ? "new"
      : `${current >= prev ? "+" : ""}${(((current - prev) / Math.abs(prev)) * 100).toFixed(1)}%`;
  return `${totalLine} (prev ${formatMeasureValue(prev, currency, response)}, ${pct})`;
}

/**
 * A dimension-X-axis result as text: one bar per value in the server's ranked
 * order, each with its change against the previous period when the response
 * carries one, then the segments each bar is split by. The layout is
 * client-core's `costCategoryChart`, the one every chart draws from.
 */
export const printDimensionAxis = Effect.fnUntraced(function* (
  response: CostQueryResponse,
  binning: CostBinningId,
) {
  const { costCategoryChart, costComparisonDelta, formatCostChangePct } = yield* loadCore;
  const chart = costCategoryChart(response, binning);
  const currency = response.currencies[0] ?? "";
  const items = chart.categories.map((cat, i) => {
    const total = chart.totals[i] ?? 0;
    const delta = chart.previous ? costComparisonDelta(total, chart.previous[i]) : null;
    const change = chart.previous
      ? ` ${c.dim(delta ? formatCostChangePct(delta.changePct) : "new")}`
      : "";
    return {
      label: cat.isOther ? c.dim("other") : safe(cat.label),
      value: total,
      display: `${formatMeasureValue(total, currency, response)}${change}`,
      colorIndex: i,
    };
  });
  for (const row of barChart(items, 32)) yield* Print.line(row);
  if (chart.series.length > 1) {
    yield* Print.line();
    const names = chart.series.map((s) => (s.isOther ? "other" : safe(s.label)));
    yield* Print.line(
      c.dim(
        `each bar split by ${response.xAxis?.segment === "date" ? "date bin" : "segment"}: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}`,
      ),
    );
  }
});

/** One value as text, for whichever measure the response carries. */
export function formatMeasureValue(
  amount: number,
  currency: string,
  response: Pick<CostQueryResponse, "measure" | "usageUnit">,
): string {
  if (!response.measure) return formatMoney(amount, currency);
  const n = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: response.measure === "count" ? 0 : Math.abs(amount) < 10 ? 2 : 0,
  }).format(amount);
  return response.measure === "usage" && response.usageUnit
    ? `${n} ${safe(response.usageUnit)}`
    : n;
}

/** A series' period total: the last point of a running sum, else the sum. */
export function seriesTotal(
  points: ReadonlyArray<{ readonly amount: number }>,
  cumulative: boolean,
): number {
  if (cumulative) return points[points.length - 1]?.amount ?? 0;
  return points.reduce((sum, p) => sum + p.amount, 0);
}

/* ------------------------------------------------------------------ *
 * The scope flags `costs` and `export` share
 * ------------------------------------------------------------------ */

/**
 * `--currency USD`: the display currency to convert into.
 *
 * Validated for shape only. Whether the org has actually configured this
 * currency and stated rates is a server-side question, and the answer comes
 * back in the response's `conversion` block rather than as an error: an org
 * that has not opted in gets its honest per-currency numbers, which is the
 * right outcome, not a failure.
 */
function parseCurrency(raw: Option.Option<string>): string | undefined | CliUsageError {
  if (Option.isNone(raw)) return undefined;
  const code = raw.value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return usage(`--currency must be a three-letter code like USD (got "${raw.value}").`);
  }
  return code;
}

/** `--basis cash|amortized|blended`, defaulting to cash. */
function parseBasis(raw: Option.Option<string>): CostBasis | undefined | CliUsageError {
  if (Option.isNone(raw)) return undefined;
  const match = COST_BASES.find((b) => b === raw.value);
  if (!match) {
    return usage(`--basis must be one of ${COST_BASES.join(", ")} (got "${raw.value}").`);
  }
  return match;
}

/**
 * `--where "provider = 'aws' AND tag['env'] != 'dev'"` → the structured filter.
 *
 * Compiled here rather than posted as the API's `query` field for two reasons.
 * A mistake is reported before the round trip, with the offset and a caret
 * under it: the shared parser knows exactly where it gave up, and that
 * information does not survive being turned into an HTTP status. And the
 * compiled `filters` are understood by every server version, whereas a `query`
 * sent to a server that predates it would be ignored and quietly return
 * *unfiltered* spend, which is the one failure mode worth engineering against.
 */
export const parseWhere = Effect.fnUntraced(function* (where: Option.Option<string>) {
  const text = Option.getOrUndefined(where)?.trim();
  if (!text) return [] satisfies CostFilter[];
  const { parseCostQuery, CostQueryParseError } = yield* loadCore;
  // Anything but a parse error is a bug in the parser: it stays a defect.
  return yield* Effect.suspend(() => {
    try {
      return Effect.succeed(parseCostQuery(text));
    } catch (e) {
      if (e instanceof CostQueryParseError) return Effect.fail(usage(`--where: ${e.annotated()}`));
      throw e;
    }
  });
});

const SavedFilters = wire<SavedCostFilter[]>()(
  Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
);
const SAVED_FILTERS_PATH = "/saved-cost-filters";

/**
 * `--filter <name|id>` → the saved filter it names (beside the element the
 * server sent, whose `filters` the `--json` output echoes), or null when the
 * flag is absent.
 *
 * Resolved to an *id* here and to rows on the server at query time: the same
 * reference semantics every graph and budget pointing at the filter gets. The
 * list is fetched once to match by id or (case-insensitive) name; names are
 * unique per org, so a name can never be ambiguous. An unknown value is an
 * error listing what exists, never a silent unfiltered query.
 */
export const resolveSavedFilterFlag = Effect.fnUntraced(function* (
  orgId: string,
  flag: Option.Option<string>,
) {
  const wanted = Option.getOrUndefined(flag)?.trim();
  if (!wanted) return null;
  const api = yield* CloudApi;
  const saved = yield* decodePaired(
    SavedFilters,
    SAVED_FILTERS_PATH,
  )(yield* api.json(orgId, SAVED_FILTERS_PATH));
  const match =
    saved.find((f) => f.row.id === wanted) ??
    saved.find((f) => f.row.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const names = saved.map((f) => `"${f.row.name}"`).join(", ");
    return yield* usage(
      `--filter: no saved cost filter named "${wanted}".` +
        (saved.length > 0
          ? ` Saved filters: ${names}.`
          : " This organization has no saved filters yet. Create one from any cost editor."),
    );
  }
  return match;
});

/** A saved filter's `filters` as the server sent them, for the `--json` echo. */
export const savedFilterRows = (filter: Paired<{ readonly id: string }>) =>
  decodeBody(
    Schema.Struct({ filters: Schema.Unknown }),
    SAVED_FILTERS_PATH,
  )(filter.raw).pipe(Effect.map((f) => f.filters));

/* ------------------------------------------------------------------ *
 * `infrawrench costs`
 * ------------------------------------------------------------------ */

const Status = wire<CostAccountStatus>()(
  Schema.Struct({
    displayName: Schema.String,
    supportsCosts: Schema.Boolean,
    costLastPolledAt: Schema.NullOr(Schema.String),
    costPollError: Schema.NullOr(
      Schema.Struct({
        message: Schema.String,
        helpLink: Schema.NullOr(Schema.Struct({ url: Schema.String })),
      }),
    ),
    coverage: Schema.NullOr(Schema.Struct({ firstDay: Schema.String, lastDay: Schema.String })),
    // Each optional on older servers' responses; absent reads as "doesn't",
    // which is what such a server was doing.
    estimated: Schema.optional(Schema.Boolean),
    amortization: Schema.optional(Schema.Boolean),
    blending: Schema.optional(Schema.Boolean),
  }),
);
type Status = typeof Status.Type;
const STATUS_PATH = "/costs/status";

/**
 * Collection runs daily in the background and backs off on failure, so a
 * misconfigured provider reads as missing spend rather than an error. Fetch
 * the per-account state so the numbers below can be trusted (or explained).
 *
 * Three states are worth reporting: collection that failed, collection that
 * succeeded with nothing to show (a billing export that hasn't produced its
 * first rows yet) (both otherwise look like an account with no spend) and
 * spend that was computed here rather than billed by the provider, which looks
 * like nothing at all until someone reconciles it against an invoice.
 */
interface CollectionState {
  failing: ReadonlyArray<Paired<Status>>;
  empty: ReadonlyArray<Paired<Status>>;
  estimated: ReadonlyArray<Paired<Status>>;
  /** True when some account's plugin reports amortized cost at all. */
  amortizing: boolean;
  /** True when some account's plugin reports blended commitment discounts. */
  blending: boolean;
}

const loadCollectionState = Effect.fnUntraced(function* (orgId: string) {
  const api = yield* CloudApi;
  const body = yield* api.decode(
    Schema.Struct({ accounts: Schema.optional(Schema.Unknown) }),
    orgId,
    STATUS_PATH,
  );
  const accounts = yield* decodePaired(Schema.Array(Status), STATUS_PATH)(body.accounts ?? []);
  const state: CollectionState = {
    failing: accounts.filter((a) => a.row.supportsCosts && a.row.costPollError),
    empty: accounts.filter(
      (a) =>
        a.row.supportsCosts &&
        !a.row.costPollError &&
        a.row.costLastPolledAt !== null &&
        !a.row.coverage,
    ),
    estimated: accounts.filter((a) => a.row.supportsCosts && a.row.estimated === true),
    amortizing: accounts.some((a) => a.row.supportsCosts && a.row.amortization === true),
    blending: accounts.some((a) => a.row.supportsCosts && a.row.blending === true),
  };
  return state;
});

const printCollectionWarnings = Effect.fnUntraced(function* ({
  failing,
  empty,
  estimated,
}: CollectionState) {
  for (const { row: account } of failing) {
    if (!account.costPollError) continue;
    yield* Print.line(
      `${c.yellow("!")} ${c.bold(safe(account.displayName))} ${c.dim("cost collection failing")}`,
    );
    yield* Print.line(`  ${safe(account.costPollError.message)}`);
    if (account.costPollError.helpLink) {
      yield* Print.line(`  ${c.dim("→")} ${c.blue(safe(account.costPollError.helpLink.url))}`);
    }
  }
  for (const { row: account } of empty) {
    yield* Print.line(
      `${c.dim("·")} ${c.bold(safe(account.displayName))} ${c.dim("no spend data yet")}`,
    );
    yield* Print.line(`  ${c.dim("collected without error. The provider reported no spend")}`);
  }
  for (const { row: account } of estimated) {
    yield* Print.line(
      `${c.dim("·")} ${c.bold(safe(account.displayName))} ${c.dim("spend is estimated")}`,
    );
    yield* Print.line(
      `  ${c.dim("priced from current inventory at list rates. No billing API; runs low for anything deleted mid-period, and excludes credits, tax and refunds")}`,
    );
  }
  if (failing.length > 0 || empty.length > 0 || estimated.length > 0) yield* Print.line();
});

/**
 * The conversion caveat, as lines for text mode.
 *
 * Two things, in the order they matter: what got folded in and at whose rates,
 * then what is still outside the headline figure. The second is the one that
 * must never be dropped: a currency with no rate is shown separately, so the
 * big number is not the whole spend and the reader has to be told.
 */
const printConversionNotice = Effect.fnUntraced(function* (conversion: Conversion | undefined) {
  if (!conversion) return;
  const { converted, unconverted } = conversion;
  const displayCurrency = safe(conversion.displayCurrency);
  if (converted.length === 0 && unconverted.length === 0) return;

  for (const entry of converted) {
    // Stated rates are listed one by one (they are what a reader reconciles
    // against); a daily feed across a quarter is sixty-odd rates, so it is
    // condensed to its range and publication dates.
    const manual = entry.rates.filter((r) => (r.source ?? "manual") === "manual");
    const feed = entry.rates.filter((r) => r.source === "ecb");
    const parts = manual.map((r) => `${r.rate} from ${safe(r.effectiveFrom)} (your rate)`);
    const [onlyFeed] = feed;
    if (onlyFeed && feed.length === 1) {
      parts.push(`${onlyFeed.rate} (ECB reference rate, ${safe(onlyFeed.effectiveFrom)})`);
    } else if (feed.length > 1) {
      const values = feed.map((r) => r.rate);
      const dates = feed.map((r) => safe(r.effectiveFrom)).sort();
      parts.push(
        `${Math.min(...values)}–${Math.max(...values)} (ECB reference rates, ${dates[0]} to ${dates[dates.length - 1]})`,
      );
    }
    const rates = parts.join("; ");
    yield* Print.line(
      `${c.dim("·")} ${c.bold(safe(entry.currency))} ${c.dim(`converted to ${displayCurrency} at ${rates}`)}`,
    );
  }
  if (converted.length > 0) {
    yield* Print.line(
      `  ${c.dim(
        "a rate your organization stated always wins over an automatic ECB rate; weekends and holidays carry the last ECB publication; spend already in " +
          displayCurrency +
          " is not converted",
      )}`,
    );
  }
  if (unconverted.length > 0) {
    yield* Print.line(
      `${c.yellow("!")} ${c.bold(unconverted.map(safe).join(", "))} ${c.dim(`not included in the ${displayCurrency} figure`)}`,
    );
    yield* Print.line(
      `  ${c.dim("no stated or automatic rate covers every day in this range (the ECB does not publish every currency), so these amounts are listed separately in their own currency rather than folded in or dropped")}`,
    );
  }
  yield* Print.line();
});

/** What the chart handler reads off the command line. */
interface ChartInput extends DisplayFlagValues {
  readonly last: Option.Option<number>;
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly groupBy: Option.Option<string>;
  readonly basis: Option.Option<string>;
  readonly currency: Option.Option<string>;
  readonly where: Option.Option<string>;
  readonly filter: Option.Option<string>;
  readonly chargeType: ReadonlyArray<CostChargeType>;
  readonly segmentByDate: boolean;
  readonly compare: boolean;
}

const QUERY_PATH = "/costs/query";

/** `infrawrench costs`: the spend chart. */
const chart = Effect.fnUntraced(function* (input: ChartInput) {
  yield* refuseLocal(LOCAL_REFUSAL);
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;

  const display = yield* parseDisplayFlags(input);
  // A dimension on X makes the group-by a segment of each bar, so it defaults
  // to none there rather than to provider.
  const dimensionAxis = display.xAxis && display.xAxis !== "date" ? display.xAxis : undefined;
  const parsedGroupBy = parseGroupByFlag(
    Option.getOrElse(input.groupBy, () => (dimensionAxis ? "none" : "provider")),
    GROUP_DIMENSIONS,
  );
  if ("error" in parsedGroupBy) return yield* new CliFailure({ message: parsedGroupBy.error });
  const groupBy = DIMENSIONS.find((d) => d === parsedGroupBy.groupBy) ?? "none";
  // Set only for a keyed dimension (`tag:env`, `virtual_tag:team`): the server
  // refuses a keyed grouping without one, and ignores it for any other.
  const groupByTagKey = KEYED_DIMENSIONS.some((d) => d === groupBy)
    ? parsedGroupBy.tagKey
    : undefined;

  const basis = parseBasis(input.basis);
  if (basis instanceof CliUsageError) return yield* basis;
  const chargeTypes = [...input.chargeType];
  const displayCurrency = parseCurrency(input.currency);
  if (displayCurrency instanceof CliUsageError) return yield* displayCurrency;
  const filters = yield* parseWhere(input.where);
  const savedFilter = yield* resolveSavedFilterFlag(org.id, input.filter);
  const binning = display.binning ?? "daily";
  const cumulative = display.cumulative === true;
  const segmentByDate = Boolean(dimensionAxis && input.segmentByDate);
  const compare = input.compare;
  yield* checkDisplayFlags(org.id, {
    ...display,
    xAxis: dimensionAxis,
    binning,
    groupBy,
    ...(groupByTagKey ? { groupByTagKey } : {}),
    ...(segmentByDate ? { segmentByDate } : {}),
  });

  const { from, to } = resolveDateRange(input);
  const where = Option.getOrUndefined(input.where)?.trim();

  const query: CostQueryRequest = {
    from,
    to,
    binning,
    groupBy,
    ...(groupByTagKey ? { groupByTagKey } : {}),
    filters,
    topN: 8,
    comparePreviousPeriod: compare,
    forecast: false,
    // Omitted when defaulted, so an older server that has never heard of either
    // field still answers the same request it always did.
    ...(basis ? { costBasis: basis } : {}),
    ...(chargeTypes.length > 0 ? { chargeTypes } : {}),
    // Omitted unless asked for, so a server that has never heard of conversion
    // (and an org that has not opted in) answers the request it always did.
    ...(displayCurrency ? { displayCurrency } : {}),
    // The *id*, resolved server-side at query time and AND-composed with the
    // --where filter above: the same reference semantics a graph or budget
    // pointing at this filter gets, so `--filter prod-only` cannot drift from
    // what "prod-only" means everywhere else.
    ...(savedFilter ? { savedFilterId: savedFilter.row.id } : {}),
    // The display options, each omitted unless given: same rule as above.
    ...(display.measure && display.measure !== "cost" ? { measure: display.measure } : {}),
    ...(display.usageUnit ? { usageUnit: display.usageUnit } : {}),
    ...(cumulative ? { cumulative: true } : {}),
    ...(dimensionAxis
      ? {
          xAxis: dimensionAxis,
          ...(display.xAxisTagKey ? { xAxisTagKey: display.xAxisTagKey } : {}),
          ...(segmentByDate ? { segmentByDate: true } : {}),
        }
      : {}),
  };

  const [body, collection] = yield* Effect.all(
    [
      api.json(org.id, QUERY_PATH, { method: "POST", body: JSON.stringify(query) }),
      loadCollectionState(org.id),
    ],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    const head = {
      org: org.id,
      from,
      to,
      groupBy,
      groupByTagKey: groupByTagKey ?? null,
      // Echoed as both the text the user typed and the structure it compiled
      // to, so a script can see which filter actually ran without re-parsing.
      where: where || null,
      filters,
      // The saved filter is echoed as id + name + the rows it resolved to at
      // request time, so a script can see the whole effective filter.
      savedFilter: savedFilter
        ? {
            id: savedFilter.row.id,
            name: savedFilter.row.name,
            filters: yield* savedFilterRows(savedFilter),
          }
        : null,
      costBasis: basis ?? "cash",
      chargeTypes,
      // Echoed so a script can tell an unconverted run from a converted one
      // without inspecting `conversion`, which carries the rates applied and,
      // crucially, the currencies that could not be converted and are
      // therefore outside the headline totals.
      displayCurrency: displayCurrency ?? null,
      // Echoed so a script knows whether the amounts below are money, a
      // quantity (and in which unit) or a count, and how they were binned.
      measure: display.measure ?? "cost",
      usageUnit: display.usageUnit ?? null,
      binning,
      cumulative,
      // The axis the amounts are keyed by: `null` is the date bins.
      xAxis: dimensionAxis ?? null,
      xAxisTagKey: display.xAxisTagKey ?? null,
      segmentByDate,
      comparePreviousPeriod: compare,
    };
    return yield* Print.json({
      ...(yield* spreadBody(head, body, QUERY_PATH)),
      collectionFailures: collection.failing.map((a) => a.raw),
      awaitingData: collection.empty.map((a) => a.raw),
      // A script totalling this output has to be able to tell which accounts'
      // money was computed rather than billed.
      estimatedAccounts: collection.estimated.map((a) => a.raw),
    });
  }

  const decoded = yield* decodeBody(CostQuery, QUERY_PATH)(body);
  const response = asCostQuery(decoded);
  yield* printCollectionWarnings(collection);
  yield* printConversionNotice(decoded.conversion);

  const { series, totals } = response;
  if (series.length === 0) {
    return yield* Print.line(
      c.dim("No cost data yet. Connect a provider account with billing access."),
    );
  }

  const totalLine = withPreviousTotal(
    Object.entries(totals)
      .map(([currency, amount]) => formatMeasureValue(amount, currency, response))
      .join(" + "),
    response,
  );
  // The basis and any charge-type narrowing go in the header: a total that is
  // not the whole net bill must say so on the same line as the number, or it
  // gets quoted as if it were.
  const scope = [
    `${from} → ${to}`,
    // The filter belongs on the header line for the same reason the basis
    // does: a narrowed total that does not say what it excludes gets quoted as
    // if it were the whole bill. The saved filter's name too: a total scoped
    // by "prod only" that does not say so gets quoted as the whole bill.
    ...(savedFilter ? [`filter "${safe(savedFilter.row.name)}"`] : []),
    ...(filters.length > 0 && where ? [where] : []),
    ...(basis === "amortized" || basis === "blended" ? [basis] : []),
    ...(chargeTypes.length > 0 ? [chargeTypes.join(", ")] : []),
    // On the same line as the number, like the basis: a converted total that
    // does not say so gets quoted as if it were a collected one.
    ...(decoded.conversion && decoded.conversion.converted.length > 0
      ? [`converted to ${safe(decoded.conversion.displayCurrency)}`]
      : []),
    // A number with no currency sign must say what it is counting.
    ...(decoded.measure === "usage" ? [`usage in ${safe(decoded.usageUnit ?? "?")}`] : []),
    ...(decoded.measure === "count" ? [`distinct ${groupBy} count`] : []),
    ...(cumulative ? ["cumulative"] : []),
    ...(dimensionAxis
      ? [`by ${display.xAxisTagKey ? `${dimensionAxis} ${display.xAxisTagKey}` : dimensionAxis}`]
      : []),
  ].join(" · ");
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(`· ${scope}`)}  ${c.bold(totalLine)}`,
  );
  if (basis === "amortized" && !collection.amortizing) {
    yield* Print.line(
      c.dim("no connected provider reports amortized cost. These are the amounts you were charged"),
    );
  }
  if (basis === "blended") {
    yield* Print.line(
      c.dim(
        collection.blending
          ? "blended: each commitment's discount shared evenly across all the usage it could cover; day totals match amortized"
          : "no connected provider reports blended commitment discounts, so these are the amortized amounts",
      ),
    );
  }
  yield* Print.line();

  // A dimension on X: one bar per value (ranked, with the change when
  // comparing), not a trend over time.
  if (response.xAxis) return yield* printDimensionAxis(response, binning);

  // Daily total trend across all series (single-currency assumption per line).
  const byBucket = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.amount);
  }
  const buckets = [...byBucket.keys()].sort();
  const dailyTotals = buckets.map((b) => byBucket.get(b) ?? 0);
  const sparkWidth = Math.min(60, Math.max(20, buckets.length));
  yield* Print.line(`${c.dim(binning)} ${seriesColor(0)(sparkline(dailyTotals, sparkWidth))}`);
  yield* Print.line();

  const items = series.map((s, idx) => {
    const total = seriesTotal(s.points, cumulative);
    return {
      label: s.key === "__other__" ? c.dim("other") : safe(s.label),
      value: total,
      display: formatMeasureValue(total, s.currency, response),
      colorIndex: idx,
    };
  });
  for (const row of barChart(items, 32)) yield* Print.line(row);
});

/* ------------------------------------------------------------------ *
 * `infrawrench costs --anomalies`
 * ------------------------------------------------------------------ */

const DEFAULT_ANOMALY_DAYS = 30;

/**
 * Recent spend anomalies: days where one provider's or service's spend cleared
 * its own trailing baseline, and days where one started spending with no
 * history at all. Detection runs server-side after each cost collection, so
 * this is a read; the thresholds it uses are tuned from the Costs panel.
 */
const listAnomalies = Effect.fnUntraced(function* (range: {
  readonly days: Option.Option<number>;
  readonly last: Option.Option<number>;
}) {
  yield* refuseLocal(
    "Anomaly detection runs on Infrawrench Cloud over your org's collected spend. There is no local cost history.",
  );
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const days = yield* resolveDayWindow(range, DEFAULT_ANOMALY_DAYS, MAX_ANOMALY_DAYS);

  const path = `/costs/anomalies?days=${days}`;
  const body = yield* api.decode(Schema.Struct({ anomalies: Schema.Unknown }), org.id, path);

  if (session.output === "json") {
    return yield* Print.json({ org: org.id, days, anomalies: body.anomalies });
  }
  const anomalies = yield* decodeBody(Schema.Array(AnomalyRow), path)(body.anomalies);

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(`· spend anomalies, last ${days} day${days === 1 ? "" : "s"}`)}`,
  );
  yield* Print.line();

  if (anomalies.length === 0) {
    return yield* Print.line(
      c.dim(
        "No anomalies. Each day's spend per provider and service is compared with its own trailing 28-day baseline.",
      ),
    );
  }

  yield* Print.table(anomalies, [
    // Short ids: `costs --anomalies feedback <id>` accepts a unique prefix.
    { header: "id", value: (a) => c.dim(safe(shortId(a.id))) },
    { header: "day", value: (a) => safe(a.day) },
    {
      header: "what spiked",
      value: (a) => {
        const what = `${c.bold(safe(a.dimensionKey))} ${c.dim(safe(DIMENSION_LABELS[a.dimension] ?? a.dimension))}`;
        return a.kind === "new_source" ? `${what} ${c.yellow("[new source]")}` : what;
      },
    },
    {
      header: "actual",
      value: (a) => formatMoney(a.actualCents / 100, a.currency),
      align: "right",
    },
    {
      header: "baseline/day",
      // A new source has no baseline; printing "$0.00" invites the reader to
      // treat it as a measurement rather than an absence.
      value: (a) =>
        c.dim(a.kind === "new_source" ? "none" : formatMoney(a.baselineCents / 100, a.currency)),
      align: "right",
    },
    {
      header: "change",
      value: (a) => {
        const delta = anomalyDeltaPercent(
          a.actualCents,
          a.baselineCents,
          a.kind === "new_source" ? "new_source" : "spike",
        );
        return delta === null ? c.yellow("new") : c.red(delta);
      },
      align: "right",
    },
    {
      // The resource that carried most of the rise, and its share of it. The
      // whole breakdown (accounts, regions, usage units, charge types, tags)
      // is `contributors` in `--json`.
      header: "driven by",
      value: (a) => anomalyDriverLabel(a),
    },
    {
      header: "notified",
      value: (a) => (a.notifiedAt ? c.dim(safe(a.notifiedAt.slice(0, 10))) : c.dim("—")),
    },
    {
      // What somebody established this was, once they did. Truncated because a
      // table is not a place to read a paragraph; `--json` carries it whole.
      header: "explained",
      value: (a) => {
        const explanation = a.acknowledgement?.explanation;
        if (!explanation) return c.dim("—");
        return c.green(
          safe(explanation.length > 44 ? `${explanation.slice(0, 43)}…` : explanation),
        );
      },
    },
    {
      // The verdict somebody gave it, or that a suppression kept it quiet.
      header: "feedback",
      value: (a) => anomalyFeedbackLabel(a),
    },
  ]);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Baseline is the trailing 28-day mean for that provider or service; a day clears the bar at mean + N standard deviations. Rows marked [new source] had no spend at all across that window and cleared an absolute floor instead. Both thresholds are per-org, tuned from the Costs panel. The driven-by column is the resource that carried most of the day's rise, with its share; --json has the full breakdown by resource, account, region, usage unit, charge type and tag. Un-notified rows were detected while no alert channel was connected, or inside another anomaly's cooldown. An explained row is one somebody has said the cause of; that sentence is also drawn as a note on every cost chart covering the day, and explaining a spike never stops the same key being flagged again.",
    ),
  );
  yield* Print.line(
    c.dim(
      "Tell detection whether a row was a real problem: infrawrench costs --anomalies feedback <id> --expected|--unexpected. A suppressed row matched a suppression somebody created, so it was recorded but did not alert.",
    ),
  );
});

/* ------------------------------------------------------------------ *
 * `infrawrench costs --alerts`
 * ------------------------------------------------------------------ */

/** How many recent firings the text listing shows; `--limit` overrides. */
const DEFAULT_ALERT_EVENTS = 20;
const MAX_ALERT_EVENTS = 200;

const CADENCE_WINDOWS: Partial<Record<string, string>> = {
  daily: "yesterday vs same day last week",
  weekly: "last 7 complete days vs prior 7",
  monthly: "month-to-date vs same days last month",
} satisfies Record<CostAlert["cadence"], string>;

const Alert = wire<CostAlert>()(
  Schema.Struct({
    name: Schema.String,
    enabled: Schema.Boolean,
    cadence: Schema.String,
    thresholdPercent: Schema.NullOr(Schema.Finite),
    thresholdAmountCents: Schema.NullOr(Schema.Finite),
    direction: Schema.String,
    groupBy: Schema.NullOr(Schema.String),
    groupByTagKey: Schema.NullOr(Schema.String),
    filters: Schema.Array(Schema.Unknown),
    lastFiredAt: Schema.NullOr(Schema.String),
  }),
);
type Alert = typeof Alert.Type;

const AlertEvent = wire<CostAlertEvent>()(
  Schema.Struct({
    alertName: Schema.String,
    windowFrom: Schema.String,
    windowTo: Schema.String,
    groupKey: Schema.String,
    currency: Schema.String,
    previousAmountCents: Schema.Finite,
    currentAmountCents: Schema.Finite,
    changePercent: Schema.NullOr(Schema.Finite),
    direction: Schema.String,
    firedAt: Schema.String,
  }),
);
type AlertEvent = typeof AlertEvent.Type;

/** "+173%", "-42%", or "new" when the prior window had no spend at all. */
function alertDeltaLabel(event: AlertEvent): string {
  if (event.changePercent === null) return "new";
  return `${event.changePercent > 0 ? "+" : ""}${event.changePercent}%`;
}

/** The firing condition, compactly: "≥25% and ≥$100 up". */
function alertThresholdLabel(alert: Alert): string {
  const parts: string[] = [];
  if (alert.thresholdPercent !== null) parts.push(`≥${alert.thresholdPercent}%`);
  if (alert.thresholdAmountCents !== null) {
    parts.push(`≥${formatMoney(alert.thresholdAmountCents / 100, "USD")}`);
  }
  const direction =
    alert.direction === "both" ? "either way" : alert.direction === "increase" ? "up" : "down";
  return `${parts.join(" and ")} ${direction}`;
}

/**
 * Change-based cost alerts and their recent firings; the third cost-alert
 * family alongside budgets (absolute monthly total) and anomalies
 * (statistical outliers): a configured "spend on this scope moved more than
 * X% (or $Y) versus the prior period". Evaluation runs server-side after
 * each cost collection; alerts are managed from the Costs panel.
 */
const listAlerts = Effect.fnUntraced(function* (limitFlag: Option.Option<number>) {
  yield* refuseLocal(
    "Change alerts evaluate on Infrawrench Cloud over your org's collected spend. There is no local cost history.",
  );
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const limit = Math.min(
    Option.getOrElse(limitFlag, () => DEFAULT_ALERT_EVENTS),
    MAX_ALERT_EVENTS,
  );
  const alertsPath = "/cost-alerts";
  const eventsPath = `/cost-alerts/events?limit=${limit}`;

  const [alertsBody, eventsBody] = yield* Effect.all(
    [
      api.decode(Schema.Struct({ alerts: Schema.Unknown }), org.id, alertsPath),
      api.decode(Schema.Struct({ events: Schema.Unknown }), org.id, eventsPath),
    ],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    return yield* Print.json({ org: org.id, alerts: alertsBody.alerts, events: eventsBody.events });
  }
  const alerts = yield* decodeBody(Schema.Array(Alert), alertsPath)(alertsBody.alerts);
  const events = yield* decodeBody(Schema.Array(AlertEvent), eventsPath)(eventsBody.events);

  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("· change-based cost alerts")}`);
  yield* Print.line();

  if (alerts.length === 0) {
    return yield* Print.line(
      c.dim(
        "No change alerts. A change alert fires when spend on a scope moves more than a threshold versus the prior period. Create one from the Costs panel.",
      ),
    );
  }

  yield* Print.table(alerts, [
    {
      header: "name",
      value: (a) =>
        a.enabled ? c.bold(safe(a.name)) : `${c.bold(safe(a.name))} ${c.dim("[paused]")}`,
    },
    { header: "cadence", value: (a) => c.dim(safe(CADENCE_WINDOWS[a.cadence] ?? a.cadence)) },
    { header: "fires when", value: (a) => alertThresholdLabel(a) },
    {
      header: "watching",
      value: (a) =>
        c.dim(
          safe(
            `${formatGroupBy(a.groupBy, a.groupByTagKey)}${a.filters.length > 0 ? ` · ${a.filters.length} filter${a.filters.length === 1 ? "" : "s"}` : ""}`,
          ),
        ),
    },
    {
      header: "last fired",
      value: (a) => c.dim(a.lastFiredAt ? safe(a.lastFiredAt.slice(0, 10)) : "never"),
    },
  ]);

  yield* Print.line();
  if (events.length === 0) return yield* Print.line(c.dim("No firings yet."));

  yield* Print.line(c.dim(`recent firings (newest first, up to ${limit})`));
  yield* Print.table(events, [
    { header: "fired", value: (e) => safe(e.firedAt.slice(0, 10)) },
    {
      header: "alert",
      value: (e) =>
        e.groupKey === ""
          ? c.bold(safe(e.alertName))
          : `${c.bold(safe(e.alertName))} ${c.dim(`· ${safe(e.groupKey)}`)}`,
    },
    {
      header: "window",
      value: (e) =>
        c.dim(safe(e.windowFrom === e.windowTo ? e.windowTo : `${e.windowFrom}..${e.windowTo}`)),
    },
    {
      header: "previous",
      value: (e) => c.dim(formatMoney(e.previousAmountCents / 100, e.currency)),
      align: "right",
    },
    {
      header: "current",
      value: (e) => formatMoney(e.currentAmountCents / 100, e.currency),
      align: "right",
    },
    {
      header: "change",
      value: (e) => {
        const label = alertDeltaLabel(e);
        if (e.changePercent === null) return c.yellow(label);
        return e.direction === "increase" ? c.red(label) : c.green(label);
      },
      align: "right",
    },
  ]);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Windows are complete UTC days: daily compares one day to the same weekday a week earlier, weekly the last 7 complete days to the prior 7, monthly the month-to-date to the same number of days at the start of last month. Each cadence period fires at most once per watched group and currency; 'new' means the prior window had no spend at all.",
    ),
  );
});

/* ------------------------------------------------------------------ *
 * `infrawrench costs tag-keys`
 * ------------------------------------------------------------------ */

const TagKeyValues = wire<{ values: CostDimensionOption[] }>()(
  Schema.Struct({
    values: Schema.optional(
      Schema.Array(Schema.Union([Schema.String, Schema.Struct({ value: Schema.String })])),
    ),
  }),
);

const TAG_KEY_HEADINGS: Partial<Record<string, string>> = {
  tag: "Tags",
  k8s: "Kubernetes",
  k8s_node_label: "Kubernetes node labels",
  k8s_pvc_label: "Kubernetes volume labels",
  k8s_pod_label: "Kubernetes pod labels",
};

/**
 * `infrawrench costs tag-keys`: every tag key in the org's cost data, grouped
 * so Kubernetes node and volume labels read as labels. The values are what
 * `--group-by` and `--where` accept.
 */
const tagKeys = Command.make(
  "tag-keys",
  {},
  Effect.fn("costs.tag-keys")(function* () {
    yield* refuseLocal(LOCAL_REFUSAL);
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const res = yield* api.decode(TagKeyValues, org.id, "/costs/dimensions?dimension=tag-keys");
    const keys = (res.values ?? []).map((v) => (typeof v === "string" ? v : v.value));
    const { groupCostTagKeys, costTagAliasFor } = yield* loadCore;
    const groups = groupCostTagKeys(keys);
    const groupByOf = (key: string) => {
      const alias = costTagAliasFor(key);
      return alias ? `${alias.alias}:${alias.name}` : `tag:${key}`;
    };

    if (session.output === "json") {
      return yield* Print.json({
        org: org.id,
        groups: groups.map((g) => ({
          group: g.group,
          keys: g.keys.map((k) => ({ key: k.key, name: k.name, groupBy: groupByOf(k.key) })),
        })),
      });
    }

    if (groups.length === 0) return yield* Print.line(c.dim("No tagged spend yet."));
    for (const g of groups) {
      yield* Print.line(c.bold(TAG_KEY_HEADINGS[g.group] ?? g.group));
      yield* Print.table(
        g.keys,
        [
          { header: "name", value: (k) => safe(k.name) },
          { header: "--group-by", value: (k) => c.dim(safe(groupByOf(k.key))) },
        ],
        { indent: 2 },
      );
      yield* Print.line();
    }
  }),
).pipe(
  Command.withDescription(
    "The tag keys in your cost data, Kubernetes node and volume labels grouped",
  ),
);

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

/**
 * `--anomalies` is shared so it may come before the verb it introduces:
 * `costs --anomalies feedback <id>`, like `posture dismiss`, where the flag
 * picks the question and the verb what to do about it.
 */
const costsBase = Command.make("costs", {
  ...dateRange,
  days: daysFlag.pipe(Flag.withDescription("costs --anomalies: whole-day window (max 90)")),
  limit: limitFlag.pipe(
    Flag.withDescription("costs --alerts: recent firings to list (default 20, max 200)"),
  ),
  groupBy: groupByFlag.pipe(
    Flag.withDescription(
      "provider (default), account, service, region, resource, charge_type, commitment, or tag:<key> / virtual_tag:<key> / k8s_node_label:<key> / k8s_pvc_label:<key> / k8s_pod_label:<key>",
    ),
  ),
  basis: basisFlag.pipe(
    Flag.withMetavar("cash|amortized|blended"),
    Flag.withDescription("Which cost to sum (default cash)"),
  ),
  currency: currencyFlag.pipe(
    Flag.withDescription(
      "Convert to your org's display currency (stated rates, then automatic ECB rates if on)",
    ),
  ),
  ...costScope,
  ...costDisplay,
  segmentByDate: Flag.Boolean("segment-by-date").pipe(
    Flag.withDescription("With --x-axis and no --group-by: split each value's bar by date bin"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  compare: Flag.Boolean("compare").pipe(
    Flag.withDescription("Add the previous period of the same length, with the change"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  alerts: Flag.Boolean("alerts").pipe(
    Flag.withDescription('Change-based cost alerts and recent firings ("spend moved >X%")'),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
}).pipe(
  Command.withSharedFlags({
    anomalies: Flag.Boolean("anomalies").pipe(
      Flag.withDescription(
        "Days a provider or service spiked past its own baseline; also introduces feedback, suppressions, precision and sensitivity",
      ),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  }),
);

export const costs = Command.withHandler(
  costsBase,
  Effect.fn("costs")(function* (input) {
    if (input.anomalies) return yield* listAnomalies(input);
    if (input.alerts) return yield* listAlerts(input.limit);
    yield* chart(input);
  }),
).pipe(
  Command.withDescription(
    "Org cost graphs; --anomalies lists spend spikes, --alerts change-based cost alerts",
  ),
  Command.withSubcommands([
    tagKeys,
    costForecast,
    costForecasts,
    costsPush,
    costSources,
    ...anomalyCommands,
  ]),
);
