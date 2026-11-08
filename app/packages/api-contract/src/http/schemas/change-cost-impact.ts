/**
 * Cost per change and cost per deploy: what a change, or the resources a
 * deployment run provisioned, did to the run rate.
 *
 * One set of components for every surface that reports an impact, because the
 * shape of an impact is the contract and describing it several times is how
 * the descriptions end up disagreeing: `GET /deployments/runs/{id}/cost-impact`
 * (the deployments domain), `POST /cost-annotations/change-impact` (the cost
 * annotations domain) and `POST /changes/cost-impacts` (the resource changes
 * domain).
 */
import { Schema } from "effect";
import { COST_BASES } from "@infrawrench/client-core";
import { ResourceId, Uuid } from "./common";

export const ChangeCostBasis = Schema.Literals(COST_BASES).annotate({
  identifier: "ChangeCostBasis",
  description:
    "Which charge-type basis both windows are read on. `cash` (the default) is what the provider " +
    "charged on the day it charged it; `amortized` spreads a commitment's up-front fee across " +
    "the term it buys; `blended` also spreads each commitment's discount evenly over the " +
    "usage it could cover. It is echoed on every response because a delta whose basis is unstated " +
    "is unreadable: an amortized 'after' against a cash 'before' looks exactly like a saving.",
});

const ChangeCostImpactStatus = Schema.Literals([
  "measured",
  "insufficient_data",
  "unknown",
]).annotate({
  identifier: "ChangeCostImpactStatus",
  description:
    "`measured`: both windows had collected data and the delta is real. " +
    "`insufficient_data`: the windows exist but are too short to compare. " +
    "`unknown`: nothing here can answer the question. **`unknown` is never zero**: a resource " +
    "with no cost data reports that we cannot say, not that the change was free.",
});

export const ChangeCostImpactConfidence = Schema.Literals([
  "high",
  "medium",
  "low",
  "none",
]).annotate({
  identifier: "ChangeCostImpactConfidence",
  description:
    "How much the delta is worth believing. Derived from the number of comparable days per " +
    "side (7+ high, 4+ medium, otherwise low) and dropped one tier when other recorded changes " +
    "touched the same resource inside the window.",
});

const ChangeCostImpactReason = Schema.Literals([
  "no_cost_identity",
  "period_native_provider",
  "no_cost_data",
  "no_coverage_before",
  "no_coverage_after",
  "short_window",
  "window_clamped",
  "overlapping_changes",
]).annotate({
  identifier: "ChangeCostImpactReason",
  description:
    "Why the result reads the way it does. Every non-`measured` status carries at least one, and " +
    "`measured` carries whatever lowered its confidence. `period_native_provider` is the " +
    "notable one: a provider that dates a whole invoice period to the period's start cannot be " +
    "read by a day-window comparison at all.",
});

const ChangeCostImpactSeries = Schema.Struct({
  currency: Schema.String.annotate({ description: "ISO 4217 code. Currencies are never summed." }),
  beforePerDay: Schema.Finite,
  afterPerDay: Schema.Finite,
  deltaPerDay: Schema.Finite.annotate({
    description: "`afterPerDay - beforePerDay`. Positive means the change costs more.",
  }),
  deltaPercent: Schema.NullOr(Schema.Finite).annotate({
    description: "Null when the before window spent nothing; there is no percentage.",
  }),
  beforeTotal: Schema.Finite,
  afterTotal: Schema.Finite,
}).annotate({ identifier: "ChangeCostImpactSeries" });

const ChangeCostImpactWindow = Schema.Struct({
  from: Schema.String.annotate({ description: "Inclusive first UTC day, `YYYY-MM-DD`." }),
  to: Schema.String.annotate({ description: "Inclusive last UTC day." }),
}).annotate({ identifier: "ChangeCostImpactWindow" });

const NonNegativeInt = (description: string) =>
  Schema.Int.annotate({ description }).check(Schema.isGreaterThanOrEqualTo(0));

export const ChangeCostImpact = Schema.Struct({
  status: ChangeCostImpactStatus,
  costBasis: ChangeCostBasis,
  windowDays: Schema.Int.annotate({ description: "The half-window that was requested." }),
  effectiveWindowDays: Schema.Int.annotate({
    description:
      "The half-window the data supported. Clamped symmetrically, so both means always average " +
      "the same number of days.",
  }),
  eventDay: Schema.String.annotate({
    description: "UTC day the change landed on. Excluded from both windows; it is a mixed day.",
  }),
  before: Schema.NullOr(ChangeCostImpactWindow),
  after: Schema.NullOr(ChangeCostImpactWindow),
  series: Schema.Array(ChangeCostImpactSeries),
  confidence: ChangeCostImpactConfidence,
  reasons: Schema.Array(ChangeCostImpactReason),
  overlappingChanges: NonNegativeInt(
    "Other recorded changes to the same resource inside the window. A delta is correlation, " +
      "never causation; this is the number that says how much else was going on.",
  ),
}).annotate({ identifier: "ChangeCostImpact" });

const DeploymentCostImpactResource = Schema.Struct({
  resourceId: ResourceId,
  displayName: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  impact: ChangeCostImpact,
}).annotate({ identifier: "DeploymentCostImpactResource" });

/** `GET /deployments/runs/{id}/cost-impact`: the impact of what a run provisioned. */
export const DeploymentCostImpact = Schema.Struct({
  runId: Uuid,
  costBasis: ChangeCostBasis,
  windowDays: Schema.Int,
  eventDay: Schema.String.annotate({
    description: "The run's start day, UTC; what both windows hang off.",
  }),
  resources: Schema.Array(DeploymentCostImpactResource).annotate({
    description:
      "One row per resource the run provisioned through `infra.accounts.*.create(...)`. That is " +
      "the only set attributable to a run with certainty: a deploy that merely re-shipped an " +
      "image links to nothing and honestly reports an empty breakdown.",
  }),
  total: Schema.Array(
    Schema.Struct({ currency: Schema.String, deltaPerDay: Schema.Finite }),
  ).annotate({
    description:
      "Summed `deltaPerDay` per currency across the **measured** rows only, so the breakdown " +
      "always adds up to it. An unmeasurable resource contributes nothing rather than zero.",
  }),
  unknownResources: NonNegativeInt(
    "Rows excluded from `total` because their impact could not be measured.",
  ),
  confidence: ChangeCostImpactConfidence.annotateKey({
    description:
      "The weakest confidence among the measured rows; a breakdown is only as good as its worst row.",
  }),
}).annotate({ identifier: "DeploymentCostImpact" });
