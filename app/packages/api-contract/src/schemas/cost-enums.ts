/**
 * The vocabulary a cost query, a saved graph and a report run share, so the
 * three cannot disagree about what a bin, a measure or a basis is.
 *
 * Named ones carry the OpenAPI component the Zod spec registered them under.
 * Describe a named schema at a use site with `.annotateKey(...)`, never
 * `.annotate(...)`: annotating it would define the component a second time.
 */
import { Schema } from "effect";
import {
  COST_BASES,
  COST_BINNINGS,
  COST_CHARGE_TYPES,
  COST_DIMENSIONS,
  COST_MEASURES,
  COST_RANGE_PRESETS,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import { CostDimension } from "./cost-filter";
import { IsoDate } from "./primitives";

/** `COST_BASES`, undocumented: the saved graph lists it inline. */
export const CostBasisValue = Schema.Literals(COST_BASES);

export const CostBasis = CostBasisValue.annotate({
  identifier: "CostBasis",
  description:
    "Which number to sum. `cash` is what the provider charged on the day it charged it; the " +
    "default, and what every query returned before this existed. `amortized` spreads a " +
    "commitment's up-front fee across the term it buys, so a year of capacity bought on one " +
    "day is counted on the days it covers. Providers that report no amortized amount fall " +
    "back to their cash amount, so an amortized query over a mixed estate never drops their " +
    "spend. `blended` is amortized with each commitment's discount (reservations, savings " +
    "plans, committed-use discounts) spread evenly over all the usage it was eligible to " +
    "cover, so every eligible hour in the commitment's scope carries the same effective rate " +
    "whichever account or resource the provider applied it to: the fair basis for chargeback. " +
    "Day totals equal the amortized totals exactly; rows a provider did not blend fall back " +
    "to their amortized amount.",
});

export const CostChargeType = Schema.Literals(COST_CHARGE_TYPES).annotate({
  identifier: "CostChargeType",
});

export const CostBinning = Schema.Literals(COST_BINNINGS).annotate({
  identifier: "CostBinning",
  description:
    "Time bucket of the x axis. Weeks start on Monday and quarters on the first of January, " +
    "April, July and October (UTC). `cumulative` is the older spelling of daily bins with " +
    "`cumulative: true`, kept so stored configs and existing clients keep working. `hourly` " +
    "is refused with a 400 while no connected account stores hourly cost rows: every " +
    "provider's spend is collected per UTC day today (see `granularity` on /costs/status).",
});

export const CostMeasure = Schema.Literals(COST_MEASURES).annotate({
  identifier: "CostMeasure",
  description:
    "What the Y axis sums. `cost` (the default) is money per currency. `usage` sums the usage " +
    "quantity providers report beside the money and requires `usageUnit`, because quantities " +
    "in different units cannot be added. `count` is how many distinct values of the `groupBy` " +
    "dimension had nonzero cost in each bin (how many services were billed each day) and " +
    "requires a `groupBy`; its range total is a distinct count, not a sum of the bins. " +
    "`usage` and `count` cannot carry a forecast, a scenario or billing rules (a 400), " +
    "`count` cannot be cumulative, and a display currency is ignored for both.",
});

export const CostUsageUnit = Schema.String.check(minLength(1), maxLength(64)).annotate({
  description:
    "The usage unit a `usage` measure sums, exactly as the provider spells it (`Hrs`, " +
    "`GB-Mo`). List them with GET /costs/dimensions?dimension=usage-units. Required for " +
    "`usage`, refused for any other measure.",
});

export const CostXAxis = CostDimension.annotate({
  description:
    "Put this dimension's values on the X axis instead of date bins: one bar per value, ranked " +
    "by spend over the range, the top `topN` then `__other__`. `groupBy` then segments each " +
    "bar (or set `segmentByDate` to segment by bin instead). Omitted is the date axis. Refused " +
    "with a forecast, a scenario, a running total, the `count` measure or a unit-cost chart, " +
    "which all need dates.",
});

export const CostXAxisTagKey = Schema.String.check(minLength(1), maxLength(256)).annotate({
  description:
    "Required when `xAxis` is `tag` or `virtual_tag`: which key's values go on the axis.",
});

export const CostSegmentByDate = Schema.Boolean.annotate({
  description:
    "With `xAxis` and `groupBy: none`: segment each bar by date bin (one series per bin). " +
    "Refused alongside a `groupBy`; ignored without `xAxis`.",
});

export const CostCumulative = Schema.Boolean.annotate({
  description:
    "Running totals from the start of the range, at any bin size. Omitted is off. Totals " +
    "then report the last point rather than the sum.",
});

/** `groupBy` on a graph or a query: a dimension, or `none` for one total. */
export const CostGroupBy = Schema.Literals(["none", ...COST_DIMENSIONS]);

const RangeDay = IsoDate.annotate({ examples: ["2026-07-01"] });

/** zod's `costDateRangeSchema`. */
export const CostDateRange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("relative"), preset: Schema.Literals(COST_RANGE_PRESETS) }),
  Schema.Struct({ kind: Schema.Literal("absolute"), from: RangeDay, to: RangeDay }),
]).annotate({
  identifier: "CostDateRange",
  description:
    "A relative preset resolves against today every time the report runs, so a saved report " +
    "keeps meaning 'the last 30 days'; an absolute range pins it to fixed dates.",
});
