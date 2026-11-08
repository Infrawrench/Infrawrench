/**
 * Budget request bodies, as Effect schemas: what the budget form validates
 * before saving and what the API decodes `POST`/`PUT /budgets` with. The
 * cross-field rules (a spend budget needs a positive amount, periods in order,
 * one unit per hierarchy) live in `budgetInputError`, which every caller runs
 * after this decodes.
 */
import { Effect, Schema } from "effect";
import { maxLength, minLength, trimmed } from "./checks";
import {
  BUDGET_LIMITS,
  BUDGET_MEASURES,
  BUDGET_PERIOD_UNITS,
  COST_ANNOTATION_LIMITS,
  COST_BASES,
  type BudgetInput as BudgetInputContract,
  type BudgetPeriod as BudgetPeriodContract,
  type BudgetThreshold as BudgetThresholdContract,
} from "@infrawrench/client-core";
import { AlertEmailRecipients } from "./alert-email";
import type { Exact } from "./contract";
import { CostFilter } from "./cost-filter";
import { IsoDate } from "./primitives";

const IsoDay = IsoDate.annotate({ examples: ["2026-10-01"] });

export const BudgetThreshold = Schema.Struct({
  type: Schema.Literals(["actual", "forecast"]),
  /** Percent of the budget amount at which this threshold fires. */
  percent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
}).annotate({ identifier: "BudgetThreshold" });

/** A budget's filter terms are documented under their own component name. */
export const BudgetCostFilter = CostFilter.annotate({ identifier: "BudgetCostFilter" });

export const BudgetCostBasis = Schema.Literals(COST_BASES).annotate({
  identifier: "BudgetCostBasis",
  description:
    "Which number the budget tracks. Defaults to `cash`: what the provider charged, when it " +
    "charged it. An organization holding reservations or savings plans usually wants " +
    "`amortized`: a cash budget is blown the month a commitment is bought and then reads as " +
    "under-spent for the rest of the term it paid for. `blended` additionally spreads each " +
    "commitment's discount evenly over all the usage it could cover, which is the fair " +
    "basis for a team's budget when commitments are bought centrally.",
});

export const BudgetMeasure = Schema.Literals(BUDGET_MEASURES).annotate({
  identifier: "BudgetMeasure",
  description:
    "What the budget counts. `cost` (the default) is money in `currency`, against " +
    "`amountCents`. `usage` sums the cost rows' usage quantity in `usageUnit` against " +
    "`usageAmount` (tokens, GB, instance-hours, requests: whatever the providers report; " +
    "list them with GET /costs/dimensions?dimension=usage-units). Units are matched exactly " +
    "and never converted. A usage budget takes no scenario model and no billing rules.",
});

export const BudgetUsageUnit = Schema.String.check(
  minLength(1),
  maxLength(BUDGET_LIMITS.maxUsageUnitLength),
).annotate({
  description: "The usage unit a usage budget counts, exactly as the providers report it.",
});

export const BudgetUsageAmount = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(BUDGET_LIMITS.maxUsageAmount),
).annotate({ description: "A usage budget's limit per period, in `usageUnit`." });

export const BudgetRecurringPeriod = Schema.Struct({
  kind: Schema.Literal("recurring"),
  unit: Schema.Literals(BUDGET_PERIOD_UNITS),
  interval: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BUDGET_LIMITS.maxInterval })),
  startDate: IsoDay.annotate({ description: "First day of the first period (UTC, inclusive)." }),
}).annotate({ identifier: "BudgetRecurringPeriod" });

export const BudgetExplicitPeriods = Schema.Struct({
  kind: Schema.Literal("explicit"),
  periods: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        start: IsoDay,
        end: IsoDay,
        amountCents: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThan(0)).annotate({
            description: "This period's limit, for a spend budget.",
          }),
        ),
        usageAmount: Schema.optionalKey(
          BudgetUsageAmount.annotate({ description: "This period's limit, for a usage budget." }),
        ),
      }),
    ),
  )
    .check(minLength(1), maxLength(BUDGET_LIMITS.maxExplicitPeriods))
    .annotate({ description: "Non-overlapping, inclusive periods, each with its own amount." }),
}).annotate({ identifier: "BudgetExplicitPeriods" });

/**
 * Which periods a budget covers. Shapes only: ordering, overlap and "each entry
 * carries the amount its budget's measure needs" are `budgetInputError`'s.
 */
export const BudgetPeriod = Schema.Union([BudgetRecurringPeriod, BudgetExplicitPeriods], {
  mode: "oneOf",
}).annotate({
  identifier: "BudgetPeriod",
  description:
    "Which periods the budget covers. Omitted (or null) is the calendar month. `recurring` " +
    "repeats every `interval` × `unit` from `startDate`; `explicit` lists the periods with " +
    "an amount each, and the top-level amount is then ignored. Thresholds fire once per " +
    "period; days outside every period are not measured.",
});

export const BudgetSavedFilterId = Schema.String.check(minLength(1)).annotate({
  description:
    "A saved cost filter (see /saved-cost-filters) applied by reference and AND-composed " +
    "with `filters` when the budget is evaluated. Updates are full replaces, so omitting " +
    "it on PUT clears it. A reference that fails to resolve errors the budget's " +
    "evaluation rather than silently measuring all spend.",
});

export const BudgetScenarioModelId = Schema.String.check(minLength(1)).annotate({
  description:
    "A scenario model (see /cost-scenarios) this budget's **forecast** thresholds are measured " +
    "against. Null (the default, and the value for every budget nobody deliberately opts " +
    "in) keeps them on the bare trend. Opting in is per-budget on purpose: a hypothesis " +
    "somebody typed into a form must not silently change when real people get paged. " +
    "`actual` thresholds are never affected; they measure money already spent. Updates are " +
    "full replaces, so omitting it on PUT clears the opt-in.",
});

export const BudgetUseAdjustedSpend = Schema.Boolean.annotate({
  description:
    "Measure this budget against billing-rule-adjusted spend (the internal figure) instead " +
    "of what the providers charged. False by default, and for every budget nobody opted in. " +
    "The default is a deliberate refusal: a markup is organisation policy and a budget " +
    "threshold pages a real person, so adding one settings row must not be able to move " +
    "every on-call rota at once. Unlike a scenario this affects `actual` thresholds too; an " +
    "opted-in budget is measuring the internal number, and month-to-date internal spend is " +
    "as marked up as the forecast is. The alert body says the figure is adjusted and names " +
    "the collected one. Updates are full replaces, so omitting it on PUT clears the opt-in.",
});

export const BudgetParentId = Schema.String.check(minLength(1)).annotate({
  description:
    "The budget this one rolls up into. A parent's actual and forecast are the sum of its " +
    "children's, each measured over the parent's period; parent and children must count " +
    "the same thing (one currency, or one usage unit). Hierarchies are at most 4 levels " +
    "deep. Deleting a budget moves its children up to its own parent. Updates are full " +
    "replaces, so omitting it on PUT makes the budget a root.",
});

/**
 * Create/update body for a budget. Updates are full replaces: an omitted
 * opt-in (`savedFilterId`, `scenarioModelId`, `useAdjustedSpend`, `period`,
 * `parentBudgetId`) clears it. `emailRecipients` is the exception: absent
 * leaves the stored list alone.
 */
export const BudgetInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(120)),
  amountCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    .annotate({
      description:
        "The limit per period of a spend budget, in minor units of `currency`. Required (and " +
        "positive) for a spend budget unless `period` is an explicit list; ignored by a usage " +
        "budget. Defaults to 0.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  currency: Schema.String.check(minLength(3), maxLength(3)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("USD")),
  ),
  filters: Schema.mutable(Schema.Array(BudgetCostFilter)).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => [])),
  ),
  savedFilterId: Schema.optionalKey(BudgetSavedFilterId),
  scenarioModelId: Schema.optionalKey(BudgetScenarioModelId),
  thresholds: Schema.mutable(Schema.Array(BudgetThreshold)).check(minLength(1), maxLength(10)),
  costBasis: Schema.optionalKey(BudgetCostBasis),
  useAdjustedSpend: Schema.optionalKey(BudgetUseAdjustedSpend),
  measure: Schema.optionalKey(BudgetMeasure),
  // Trimmed, then checked, as zod's `.trim().min(1).max(n)` was.
  usageUnit: Schema.optionalKey(
    trimmed([minLength(1), maxLength(BUDGET_LIMITS.maxUsageUnitLength)], {
      description: "The usage unit a usage budget counts, exactly as the providers report it.",
    }),
  ),
  usageAmount: Schema.optionalKey(BudgetUsageAmount),
  period: Schema.optionalKey(BudgetPeriod),
  parentBudgetId: Schema.optionalKey(BudgetParentId),
  emailRecipients: Schema.optionalKey(AlertEmailRecipients),
}).annotate({ identifier: "BudgetInput" });

/**
 * Body for a note on a fired budget alert. One field: the note's date is the
 * day the alert fired and its scope org-wide, both derived by the server.
 */
export const BudgetAlertNoteInput = Schema.Struct({
  note: Schema.String.check(minLength(1), maxLength(COST_ANNOTATION_LIMITS.maxTextLength)).annotate(
    {
      description:
        "What this firing was, in a sentence. The date and scope of the chart marker it creates " +
        "are derived from the event (the day it fired, org-wide), never chosen by the caller.",
    },
  ),
}).annotate({ identifier: "BudgetAlertNoteInput" });

export type BudgetSchemasMatchContract = [
  Exact<typeof BudgetThreshold.Type, BudgetThresholdContract>,
  Exact<typeof BudgetPeriod.Type, BudgetPeriodContract>,
  Exact<typeof BudgetInput.Type, BudgetInputContract>,
];
[true, true, true] satisfies BudgetSchemasMatchContract;
