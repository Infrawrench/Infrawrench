/**
 * Anomaly detection and efficiency-alert bodies, as Effect schemas: the
 * per-org tuning, suppressions, verdicts on a finding, and the three
 * efficiency detectors' settings.
 */
import { Schema, SchemaTransformation } from "effect";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_LIMITS,
  COST_ANOMALY_RECURRENCES,
  COST_ANOMALY_SMS_MODES,
  COST_ANOMALY_SUPPRESSION_SCOPES,
  COST_ANOMALY_VERDICTS,
  COST_EFFICIENCY_LIMITS,
  type CostAnomalyFeedbackInput as CostAnomalyFeedbackInputContract,
  type CostAnomalySettings as CostAnomalySettingsContract,
  type CostAnomalySuppressionInput as CostAnomalySuppressionInputContract,
  type CostEfficiencySettings as CostEfficiencySettingsContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { AlertEmailRecipients } from "./alert-email";
import { IsoDate } from "./primitives";

const between = (minimum: number, maximum: number) => Schema.isBetween({ minimum, maximum });

/**
 * Per-org anomaly tuning (PUT /costs/anomaly-settings). The bounds are the
 * point: a `sigmas` under 1 flags a third of ordinary days, a floor of zero
 * removes the noise filter, and the ceilings stop a typo from switching
 * detection off. `sigmas` is rounded to one decimal on the way in, so the
 * stored value is what the form's step shows.
 */
export const CostAnomalySettings = Schema.Struct({
  sigmas: Schema.Finite.check(between(COST_ANOMALY_LIMITS.sigmasMin, COST_ANOMALY_LIMITS.sigmasMax))
    .annotate({
      description:
        "Standard deviations above a key's own trailing mean that count as a spike. " +
        "Lower is more sensitive. Bounded at 1 (below that roughly a third of ordinary " +
        "days clear the bar) and at 10, above which nothing short of a 10x jump fires. " +
        "Defaults to 3.",
    })
    .pipe(
      Schema.decodeTo(
        Schema.Finite,
        SchemaTransformation.transform({
          decode: (v: number) => Math.round(v * 10) / 10,
          encode: (v: number) => v,
        }),
      ),
    ),
  minDeltaCents: Schema.Int.check(
    between(COST_ANOMALY_LIMITS.minDeltaCentsMin, COST_ANOMALY_LIMITS.minDeltaCentsMax),
  ).annotate({
    description:
      "Minimum rise over the baseline mean before a spike alerts, in USD cents (converted " +
      "per series, so it means the same real amount in every currency). Defaults to 1000 ($10).",
  }),
  newSourceMinCents: Schema.Int.check(
    between(COST_ANOMALY_LIMITS.newSourceMinCentsMin, COST_ANOMALY_LIMITS.newSourceMinCentsMax),
  ).annotate({
    description:
      "Minimum first-day spend before a new spend source alerts, in USD cents. A key with no " +
      "prior spend has no statistical bar to clear, so this absolute floor is the only thing " +
      "keeping a new $0.02/day service quiet. Defaults to 2500 ($25).",
  }),
  /**
   * The one setting here that costs money and wakes people: an explicit enum
   * with no default, so an older client's PUT cannot quietly switch it off.
   */
  smsAlerts: Schema.Literals(COST_ANOMALY_SMS_MODES).annotate({
    description:
      "Which anomalies also text the organization's Twilio recipients. Defaults to `off`: " +
      "an organization with Twilio configured for budgets does not start receiving anomaly " +
      "texts until it asks to. `new_source` texts only about spend appearing from nothing, " +
      "which is what a leaked key looks like on a bill; `all` adds spikes on existing lines. " +
      "Delivery is batched (one SMS per detection pass summarizing what it alerted on, at " +
      "most one every six hours per organization) and never places a voice call. Push, " +
      "Slack and Teams delivery is unaffected by this setting.",
  }),
  /** Optional: it arrived after whole-object clients shipped, so absent is "unchanged". */
  feedbackTuning: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether repeated `expected` feedback on a provider or service raises its spike " +
        "threshold: half a standard deviation per expected verdict after the first within 90 " +
        "days, at most +2σ and never past 10σ, cancelled by any `unexpected` verdict on the same " +
        "key. Defaults to true. Optional on PUT: omitting it keeps the stored value. Always " +
        "present on a read.",
    }),
  ),
  emailRecipients: Schema.optionalKey(AlertEmailRecipients).annotateKey({
    description:
      "Who is emailed about each anomaly, besides the alert routing rules. Optional on PUT: " +
      "omitting it leaves the stored list unchanged. Always present in responses.",
  }),
}).annotate({ identifier: "CostAnomalySettings" });

export const CostAnomalyFeedbackReason = Schema.Literals(COST_ANOMALY_FEEDBACK_REASONS).annotate({
  identifier: "CostAnomalyFeedbackReason",
});

export const CostAnomalyRecurrence = Schema.Literals(COST_ANOMALY_RECURRENCES).annotate({
  identifier: "CostAnomalyRecurrence",
  description:
    "How the suppression repeats. `one_off` covers every day from `startsOn` to `expiresOn`; " +
    "`weekly` the anchor day's weekday; `monthly` the anchor day's day of the month, give or " +
    "take a day (an anchor past the end of a shorter month falls on its last day); " +
    "`seasonal` the anchor day's calendar date, give or take three days, every year.",
});

export const CostAnomalySuppressionScope = Schema.Literals(
  COST_ANOMALY_SUPPRESSION_SCOPES,
).annotate({
  identifier: "CostAnomalySuppressionScope",
  description:
    "What the suppression covers. On a covered day the scope's spend is set aside before the " +
    "day is judged; a finding that only existed because of it is stored as suppressed and " +
    "never alerted on, and one that survives (spend beyond the expected slice) alerts as normal.",
});

const SuppressionDay = IsoDate.annotate({ examples: ["2026-10-01"] });
const ScopeKey = Schema.String.check(
  minLength(1),
  maxLength(COST_ANOMALY_FEEDBACK_LIMITS.scopeKeyMaxLength),
);
const FeedbackNote = Schema.NullOr(
  Schema.String.check(maxLength(COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength)),
);

/**
 * `POST /costs/suppressions` and `PUT /costs/anomaly-suppressions/:id`. The
 * cross-field rules (a tag key for tag scope, expiry after start, the
 * three-year cap) are `costAnomalySuppressionInputError`, which the route runs
 * after this and the editor before sending.
 */
export const CostAnomalySuppressionInput = Schema.Struct({
  scope: CostAnomalySuppressionScope,
  scopeKey: ScopeKey.annotate({
    description:
      "The scope's value: a plugin id (`provider`), a service name, an account id, a tag value, " +
      "or a cost centre id. Accounts and cost centres must belong to the organization.",
  }),
  tagKey: Schema.optionalKey(ScopeKey.annotate({ description: "Required when `scope` is `tag`." })),
  recurrence: CostAnomalyRecurrence,
  anchorDay: SuppressionDay.annotate({ description: "The day the pattern is anchored to." }),
  startsOn: Schema.optionalKey(
    SuppressionDay.annotate({ description: "First day covered. Defaults to `anchorDay`." }),
  ),
  expiresOn: SuppressionDay.annotate({
    description:
      "Last day covered, inclusive. At most three years after `startsOn`, and not before it.",
  }),
  reason: Schema.optionalKey(Schema.NullOr(CostAnomalyFeedbackReason)),
  note: Schema.optionalKey(FeedbackNote),
}).annotate({ identifier: "CostAnomalySuppressionInput" });

/** `POST /costs/anomalies/:id/feedback`. */
export const CostAnomalyFeedbackInput = Schema.Struct({
  verdict: Schema.Literals(COST_ANOMALY_VERDICTS).annotate({
    description: "`expected`: planned or known. `unexpected`: a real problem.",
  }),
  reason: Schema.optionalKey(Schema.NullOr(CostAnomalyFeedbackReason)),
  note: Schema.optionalKey(FeedbackNote),
  explain: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Also record the note as the anomaly's explanation, which publishes it as an annotation " +
        "on every chart covering the day (the same as POST …/acknowledge). Ignored without a note.",
    }),
  ),
  suppress: Schema.optionalKey(
    Schema.Struct({
      recurrence: CostAnomalyRecurrence,
      scope: Schema.optionalKey(CostAnomalySuppressionScope).annotateKey({
        description: "Defaults to the anomaly's own provider or service.",
      }),
      scopeKey: Schema.optionalKey(ScopeKey),
      tagKey: Schema.optionalKey(ScopeKey),
      expiresOn: Schema.optionalKey(
        SuppressionDay.annotate({
          description:
            "Defaults by recurrence: 7 days (one-off), 90 (weekly), 180 (monthly), 730 (seasonal), " +
            "counted from the later of the anomaly's day and today.",
        }),
      ),
    }).annotate({
      description:
        "Only with `verdict: expected`. Creates a suppression anchored to the anomaly's day so the " +
        "same pattern does not alert again; re-sending updates it rather than adding another.",
    }),
  ),
}).annotate({ identifier: "CostAnomalyFeedbackInput" });

const L = COST_EFFICIENCY_LIMITS;

/**
 * Per-org tuning for the three efficiency detectors (PUT
 * /costs/efficiency-alert-settings). Whole-object with no defaults, like the
 * anomaly settings: a field an older client omits is refused rather than
 * reset. The expiry horizons are de-duplicated and sorted descending on the
 * way in, so the stored row and the form agree and "30, 30" cannot fire twice.
 */
export const CostEfficiencySettings = Schema.Struct({
  commitmentExpiryEnabled: Schema.Boolean.annotate({
    description: "Whether commitments approaching their term end raise alerts. Defaults to true.",
  }),
  commitmentExpiryHorizonDays: Schema.mutable(
    Schema.Array(Schema.Int.check(between(L.minExpiryHorizonDays, L.maxExpiryHorizonDays))),
  )
    .check(minLength(1), maxLength(L.maxExpiryHorizons))
    .annotate({
      description:
        "Days of notice, each firing at most once per commitment per term end. Defaults to " +
        "[60, 30, 7]. A commitment fires at the *smallest* horizon it has reached, so an " +
        "account connected 30 days before a term ends gets one alert, not two.",
    })
    .pipe(
      Schema.decodeTo(
        Schema.mutable(Schema.Array(Schema.Int)),
        SchemaTransformation.transform({
          decode: (days: ReadonlyArray<number>) => [...new Set(days)].sort((a, b) => b - a),
          encode: (days: ReadonlyArray<number>) => [...days],
        }),
      ),
    ),
  commitmentExpiryAlertOnExpired: Schema.Boolean.annotate({
    description:
      "Whether a commitment that lapsed without any horizon warning having fired raises one " +
      "alert anyway. Defaults to true, and bounded to terms that ended within the last 90 " +
      "days: connecting an account with years of dead reservations produces one pass of " +
      "recent news, not an archive.",
  }),

  commitmentIdleEnabled: Schema.Boolean.annotate({
    description: "Whether under-used commitments raise alerts. Defaults to true.",
  }),
  commitmentIdleThresholdPercent: Schema.Int.check(
    between(L.minIdleThresholdPercent, L.maxIdleThresholdPercent),
  ).annotate({
    description:
      "Utilization percent the whole window must stay under. Defaults to 70; roughly where " +
      "a 1-year no-upfront commitment stops beating on-demand for the usage it covers.",
  }),
  commitmentIdleWindowDays: Schema.Int.check(
    between(L.minIdleWindowDays, L.maxIdleWindowDays),
  ).annotate({
    description:
      "Trailing days utilization is aggregated over. Defaults to 30. Aggregated, never " +
      "sampled per day: a weekday-only workload reads about 71% over a month and does not " +
      "fire, which is the point.",
  }),
  commitmentIdleMinMeasuredDays: Schema.Int.check(
    between(L.minIdleMinMeasuredDays, L.maxIdleMinMeasuredDays),
  ).annotate({
    description:
      "Window days that must carry cost data before anything is judged. Defaults to 14. A " +
      "commitment whose utilization cannot be measured at all (a unit-denominated GCP CUD, " +
      "or an account whose plugin reports no commitment attribution) never alerts, " +
      "regardless of this value.",
  }),
  commitmentIdleMinWasteCents: Schema.Int.check(
    between(L.minIdleWasteCents, L.maxIdleWasteCents),
  ).annotate({
    description:
      "Least wasted money (obligation − delivered) before alerting, in USD cents, restated " +
      "per currency. Defaults to 5000 ($50).",
  }),

  unitCostRegressionEnabled: Schema.Boolean.annotate({
    description: "Whether rising cost per business-metric unit raises alerts. Defaults to true.",
  }),
  unitCostThresholdPercent: Schema.Int.check(
    between(L.minUnitCostThresholdPercent, L.maxUnitCostThresholdPercent),
  ).annotate({
    description: "Percent the unit cost must rise versus the prior window. Defaults to 20.",
  }),
  unitCostWindowDays: Schema.Int.check(
    between(L.minUnitCostWindowDays, L.maxUnitCostWindowDays),
  ).annotate({
    description:
      "Length of each of the two compared windows. Defaults to 14; two whole weekly cycles " +
      "a side, so a weekday-shaped unit cost compares like with like.",
  }),
  unitCostMinReportedDays: Schema.Int.check(
    between(L.minUnitCostReportedDays, L.maxUnitCostReportedDays),
  ).annotate({
    description:
      "Days inside **each** window that must carry a reported, positive metric value. " +
      "Defaults to 10. A day with no reported value is a gap and contributes to neither the " +
      "numerator nor the denominator; a window that fails this bar produces no comparison at " +
      "all rather than a comparison against a gap.",
  }),
  unitCostMinSpendCents: Schema.Int.check(
    between(L.minUnitCostSpendCents, L.maxUnitCostSpendCents),
  ).annotate({
    description:
      "Least spend in the current window before alerting, in USD cents, restated per " +
      "currency. Defaults to 10000 ($100).",
  }),

  emailRecipients: Schema.optionalKey(AlertEmailRecipients).annotateKey({
    description:
      "Who is emailed about commitment expiry, idle commitment and unit-cost regression alerts, " +
      "besides the alert routing rules. Optional on PUT: omitting it leaves the stored list " +
      "unchanged. Always present in responses.",
  }),
}).annotate({ identifier: "CostEfficiencySettings" });

export type CostAnomalySchemasMatchContract = [
  Exact<typeof CostAnomalySettings.Type, CostAnomalySettingsContract>,
  Exact<typeof CostAnomalySuppressionInput.Type, CostAnomalySuppressionInputContract>,
  Exact<typeof CostAnomalyFeedbackInput.Type, CostAnomalyFeedbackInputContract>,
  Exact<typeof CostEfficiencySettings.Type, CostEfficiencySettingsContract>,
];
[true, true, true, true] satisfies CostAnomalySchemasMatchContract;
