/**
 * Scenario model bodies (POST/PUT /cost-scenarios), as Effect schemas.
 *
 * Shape only, deliberately: which fields each `kind` may carry, one currency
 * per model and an end not before its start are `costScenarioModelInputError`
 * (client-core), which the editors and the service both run, so a form
 * refuses exactly what the API refuses rather than rendering a union's
 * account of three failed branches.
 */
import { Effect, Schema } from "effect";
import {
  COST_SCENARIO_ADJUSTMENT_KINDS,
  COST_SCENARIO_LIMITS,
  COST_SCENARIO_PERIODS,
  type CostScenarioAdjustment as CostScenarioAdjustmentContract,
  type CostScenarioModelInput as CostScenarioModelInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { CostFilter } from "./cost-filter";
import { CurrencyCode, IsoDate, NonEmptyString } from "./primitives";

export const CostScenarioScopeTerm = CostFilter.annotate({ identifier: "CostScenarioScopeTerm" });

const ScenarioDay = IsoDate.annotate({ examples: ["2026-09-01"] });

/**
 * One adjustment inside a scenario model. Every kind-specific field is
 * nullable and defaults to null: each kind leaves most of them unset, and a
 * client round-tripping a stored model sends nulls.
 */
export const CostScenarioAdjustment = Schema.Struct({
  id: NonEmptyString.annotate({
    description: "Stable within the model; also the key of its per-adjustment total.",
  }),
  label: Schema.String.check(minLength(1), maxLength(COST_SCENARIO_LIMITS.maxLabelLength)).annotate(
    {
      description:
        "What this adjustment is. Named on the chart whenever the scenario moves a number.",
    },
  ),
  kind: Schema.Literals(COST_SCENARIO_ADJUSTMENT_KINDS).annotate({
    description:
      "`one_off` is a single amount on a single day; `recurring` is an amount every period " +
      "from a date; `rate_change` is ±X% of the trend from a date. The split between an " +
      "amount and a percentage of the trend is what fixes the composition order; see the " +
      "`scenario` field on the cost query response.",
  }),
  startDate: ScenarioDay,
  endDate: Schema.NullOr(ScenarioDay)
    .annotate({
      description:
        "Inclusive last day, or null for indefinitely. Refused for `one_off`, which is one day.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  amountCents: Schema.NullOr(Schema.Int)
    .annotate({
      description:
        "Minor units of the model's currency, for the amount kinds; null for `rate_change`. " +
        "May be negative; turning off an old cluster is as real a known future cost as buying " +
        "a new one.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  currency: Schema.NullOr(CurrencyCode)
    .annotate({
      description:
        "Always the model's own currency; a model that held two would sum two kinds of money.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  period: Schema.NullOr(Schema.Literals(COST_SCENARIO_PERIODS))
    .annotate({
      description:
        "How often a `recurring` amount charges. A monthly amount is spread evenly across each " +
        "calendar month it covers rather than landing as a spike on the 1st, so a month the " +
        "scenario only partly covers costs proportionally less.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  percent: Schema.NullOr(Schema.Finite)
    .annotate({
      description: "Percent change to the trend, for `rate_change`. -20 is a fifth cheaper.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  scope: Schema.mutable(Schema.Array(CostScenarioScopeTerm))
    .check(maxLength(COST_SCENARIO_LIMITS.maxScopeFilters))
    .annotate({
      description:
        "Which spend this adjustment describes; empty is the whole organization. For a rate " +
        "change the scope is what the percentage is *of*. For an amount it decides whether the " +
        "adjustment applies to a given chart at all; a GCP commitment does not belong on a " +
        "chart filtered to AWS, and one that is excluded is named in `scenario.outOfScope`.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
}).annotate({ identifier: "CostScenarioAdjustment" });

export const CostScenarioModelInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(COST_SCENARIO_LIMITS.maxNameLength)),
  description: Schema.optionalKey(
    Schema.String.check(maxLength(COST_SCENARIO_LIMITS.maxDescriptionLength)),
  ),
  /** The one currency every amount in the model is denominated in. */
  currency: CurrencyCode.annotate({
    description:
      "Three-letter code. Every amount in the model must be in it; a model that mixed two " +
      "would produce a projection that is the sum of two kinds of money, so this is refused " +
      "rather than converted behind the caller's back.",
    examples: ["USD"],
  }),
  adjustments: Schema.mutable(Schema.Array(CostScenarioAdjustment))
    .check(maxLength(COST_SCENARIO_LIMITS.maxAdjustments))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
}).annotate({ identifier: "CostScenarioModelInput" });

export type CostScenarioSchemasMatchContract = [
  Exact<typeof CostScenarioAdjustment.Type, CostScenarioAdjustmentContract>,
  Exact<typeof CostScenarioModelInput.Type, CostScenarioModelInputContract>,
];
[true, true] satisfies CostScenarioSchemasMatchContract;
