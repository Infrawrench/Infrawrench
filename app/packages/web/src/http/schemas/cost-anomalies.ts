/**
 * One detected cost anomaly, as `GET /costs/anomalies` lists it and every
 * route that changes one (acknowledging it, giving or clearing a verdict)
 * answers with it. Shared by the costs and anomaly-feedback domains.
 */
import { Schema } from "effect";
import { COST_ANOMALY_VERDICTS } from "@infrawrench/client-core";
import { CostAnomalyFeedbackReason } from "@infrawrench/ui/schemas";
import { IsoDateTime, Uuid } from "./common";
import { costDay } from "./cost-query";

const CostAnomalyFeedback = Schema.Struct({
  verdict: Schema.Literals(COST_ANOMALY_VERDICTS),
  reason: Schema.NullOr(CostAnomalyFeedbackReason),
  note: Schema.NullOr(Schema.String),
  at: IsoDateTime.annotate({
    description: "When the current verdict was recorded; restamped on every save.",
  }),
  byUserId: Schema.NullOr(Schema.String),
  byName: Schema.NullOr(Schema.String).annotate({
    description: "Display name (or email) of whoever gave the verdict, while they are still known.",
  }),
  suppressionId: Schema.NullOr(Uuid).annotate({
    description:
      "The suppression this verdict created, or null (none was asked for, or it was deleted).",
  }),
}).annotate({
  identifier: "CostAnomalyFeedback",
  description:
    "Whether somebody marked this finding expected (planned or known) or unexpected (a real " +
    "problem), with who and when; null while nobody has. See POST " +
    "/costs/anomalies/{anomalyId}/feedback.",
});

const CostAnomalyContributor = Schema.Struct({
  facet: Schema.Literals([
    "resource",
    "account",
    "region",
    "usage_unit",
    "charge_type",
    "tag",
  ]).annotate({
    description:
      "Which breakdown this value belongs to. Each facet partitions the anomaly's spend, so " +
      "within a facet the deltas add up to the anomaly's rise.",
  }),
  key: Schema.String.annotate({
    description:
      "The value as cost rows carry it: an account id, a region, the provider-native resource " +
      "id, a usage unit, a charge type or a tag value. Empty for rows with no value and for " +
      "the folded `other` row.",
  }),
  tagKey: Schema.NullOr(Schema.String).annotate({
    description: "The tag key, for the `tag` facet; null otherwise.",
  }),
  label: Schema.String.annotate({
    description: "Display name: the account's or synced resource's name where known, else `key`.",
  }),
  accountId: Schema.NullOr(Schema.String).annotate({
    description: "The one account this value's spend sits in; null when it spans several.",
  }),
  resource: Schema.NullOr(
    Schema.Struct({
      id: Schema.String.annotate({ description: "Infrawrench's resource id." }),
      accountId: Schema.String,
      pluginId: Schema.String,
      resourceTypeId: Schema.String,
      name: Schema.String,
    }),
  ).annotate({
    description:
      "The synced inventory resource a `resource` contributor's provider id matched, for a " +
      "link to its detail page; null when it was never synced.",
  }),
  actualCents: Schema.Int.annotate({ description: "Spend on the anomalous day, in cents." }),
  baselineCents: Schema.Int.annotate({
    description: "Mean daily spend over the same 28-day baseline the detector used, in cents.",
  }),
  deltaCents: Schema.Int.annotate({ description: "`actualCents - baselineCents`." }),
  share: Schema.NullOr(Schema.Finite).annotate({
    description:
      "`deltaCents` as a share of the anomaly's whole rise (0 to 1; above 1 when other values " +
      "fell). Null when the scope did not rise as a whole.",
  }),
  other: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "True for the row standing in for contributors outside the caller's cost visibility " +
        "scope: their amounts summed, their names withheld.",
    }),
  ),
}).annotate({ identifier: "CostAnomalyContributor" });

export const CostAnomaly = Schema.Struct({
  id: Uuid,
  day: costDay({ description: "The anomalous UTC day." }),
  kind: Schema.Literals(["spike", "new_source"]).annotate({
    description:
      "Which detection produced the row. `spike` is spend far above the key's own trailing " +
      "baseline; `new_source` is a provider or service with no spend at all across the " +
      "trailing window that suddenly has material spend; it can never be a `spike`, since " +
      "a zero baseline has no mean or deviation to exceed. Rows written before new-source " +
      "detection existed read as `spike`.",
  }),
  dimension: Schema.Literals(["provider", "service"]),
  dimensionKey: Schema.String.annotate({
    description: "The dimension's value; a plugin id or a service name.",
  }),
  currency: Schema.String,
  actualCents: Schema.Int,
  baselineCents: Schema.Int.annotate({
    description:
      "Mean daily spend over the trailing 28-day baseline, in cents. Zero, or near it, for a " +
      "`new_source`: clients must not compute a percentage change from it.",
  }),
  thresholdCents: Schema.Int.annotate({
    description:
      "The detection bar the day cleared, in cents: baseline mean + N·stddev for a `spike`, " +
      "the new-source floor for a `new_source`.",
  }),
  detectedAt: IsoDateTime,
  notifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "When the anomaly was delivered to a notification channel; null when delivery " +
      "failed or a recent anomaly for the same key suppressed it.",
  }),
  hints: Schema.Array(Schema.String).annotate({
    description:
      "Root-cause hints computed when the anomaly fired: human-readable facts from the " +
      "change timeline and audit log for the anomalous day and the day before (e.g. " +
      '"12 gce-instance resources appeared", a workflow run, a lifted change freeze), ' +
      "ranked by likely relevance and capped at three. Empty when nothing notable " +
      "happened in the window or the anomaly predates hint collection. When the contributor " +
      "breakdown found a clear lead, the first hint names it.",
  }),
  contributors: Schema.Array(CostAnomalyContributor).annotate({
    description:
      "What moved underneath the flagged provider or service: the anomalous day's rise over its " +
      "baseline decomposed by resource, account, region, usage unit, charge type and tag " +
      "value, a few per facet, largest first within each. The driving resource is the " +
      "`resource` row with the largest delta that carries at least 20% of the rise. Computed " +
      "at detection (and on first read for older findings) and stored. Contributors outside " +
      "the caller's cost visibility scope are folded into one `other` row per facet.",
  }),
  acknowledgement: Schema.NullOr(
    Schema.Struct({
      explanation: Schema.String.annotate({
        description: "What somebody established this finding was. Also the annotation's text.",
      }),
      acknowledgedAt: IsoDateTime.annotate({
        description: "When the current explanation was recorded, restamped by a correction.",
      }),
      acknowledgedByUserId: Schema.NullOr(Schema.String),
      annotationId: Schema.NullOr(Uuid).annotate({
        description:
          "The cost annotation this created, drawn on every chart covering the anomalous day. " +
          "Null once that note has been deleted; which removes the marker, never the " +
          "acknowledgement: the finding stays explained.",
      }),
    }),
  ).annotate({
    description:
      "Present once somebody has explained this finding, null while it is still an open " +
      "question. Acknowledging does not suppress detection; the same key spiking again " +
      "on a later day is a new anomaly and fires as normal.",
  }),
  feedback: Schema.NullOr(CostAnomalyFeedback),
  suppressionId: Schema.NullOr(Uuid).annotate({
    description:
      "The suppression that explained this finding when detection judged it. A suppressed " +
      "finding is stored but never alerted on, so its `notifiedAt` stays null. Null once the " +
      "suppression is deleted.",
  }),
}).annotate({ identifier: "CostAnomaly" });
