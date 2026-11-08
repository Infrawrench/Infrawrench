/**
 * Anomaly feedback: verdicts, suppressions, sensitivity and precision, under
 * `/api/org/:orgId/costs` beside the anomaly list (the costs domain), sharing
 * its `CostAnomaly` from `http/schemas/cost-anomalies.ts`. The endpoint
 * definitions.
 *
 * Reads are `costs:read`; writes are `costs:write`, the scope the
 * acknowledgement and the anomaly settings already use: all of it changes
 * what the org's cost feed alerts on. Bodies are the shared schemas the
 * feedback and suppression editors validate with (`@infrawrench/api-contract/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  CostAnomalyFeedbackInput,
  CostAnomalyFeedbackReason,
  CostAnomalyRecurrence,
  CostAnomalySuppressionInput,
  CostAnomalySuppressionScope,
  IsoDate as Day,
  pattern,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";
import { CostAnomaly } from "../http/schemas/cost-anomalies";

const SuppressionDay = Day.annotate({ examples: ["2026-10-01"] });

export const CostAnomalySuppression = Schema.Struct({
  id: Uuid,
  scope: CostAnomalySuppressionScope,
  scopeKey: Schema.String,
  tagKey: Schema.NullOr(Schema.String),
  scopeLabel: Schema.NullOr(Schema.String).annotate({
    description: "The account or cost centre name for id-valued scopes; null otherwise.",
  }),
  recurrence: CostAnomalyRecurrence,
  anchorDay: SuppressionDay,
  startsOn: SuppressionDay,
  expiresOn: SuppressionDay,
  reason: Schema.NullOr(CostAnomalyFeedbackReason),
  note: Schema.NullOr(Schema.String),
  sourceAnomalyId: Schema.NullOr(Uuid).annotate({
    description: "The anomaly whose `expected` verdict created this; null for one made by hand.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdByName: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  active: Schema.Boolean.annotate({
    description: "Whether it still covers today or a later day. Read-only.",
  }),
  suppressedCount: Schema.Int.annotate({
    description: "How many detected findings it has suppressed so far. Read-only.",
  }),
}).annotate({ identifier: "CostAnomalySuppression" });

export const CostAnomalySuppressionList = Schema.Struct({
  suppressions: Schema.Array(CostAnomalySuppression),
});

export const CostAnomalyFeedbackResult = Schema.Struct({
  anomaly: CostAnomaly,
  suppression: Schema.NullOr(CostAnomalySuppression),
}).annotate({ identifier: "CostAnomalyFeedbackResult" });

export const CostAnomalySensitivity = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "The `feedbackTuning` setting; false means no key moves.",
  }),
  windowDays: Schema.Int,
  baseSigmas: Schema.Finite,
  adjustments: Schema.Array(
    Schema.Struct({
      dimension: Schema.Literals(["provider", "service"]),
      dimensionKey: Schema.String,
      baseSigmas: Schema.Finite,
      sigmas: Schema.Finite.annotate({
        description: "The σ this key's spikes are judged against.",
      }),
      expectedCount: Schema.Int,
      unexpectedCount: Schema.Int,
      explanation: Schema.String,
    }),
  ),
}).annotate({ identifier: "CostAnomalySensitivity" });

const precisionCounts = {
  detected: Schema.Int,
  suppressed: Schema.Int,
  expected: Schema.Int,
  unexpected: Schema.Int,
  precision: Schema.NullOr(Schema.Finite).annotate({
    description: "unexpected / (expected + unexpected); null when nothing has a verdict.",
  }),
};

export const CostAnomalyPrecisionReport = Schema.Struct({
  months: Schema.Int,
  periods: Schema.Array(Schema.Struct({ month: Schema.String, ...precisionCounts })),
  totals: Schema.Struct(precisionCounts),
  reasons: Schema.Array(Schema.Struct({ reason: CostAnomalyFeedbackReason, count: Schema.Int })),
}).annotate({ identifier: "CostAnomalyPrecisionReport" });

const AnomalyParams = { orgId: OrgId, anomalyId: Schema.String } as const;
const SuppressionParams = { orgId: OrgId, suppressionId: Schema.String } as const;

export class CostAnomalyFeedbackGroup extends HttpApiGroup.make("costAnomalyFeedback")
  .add(
    HttpApiEndpoint.post("submitFeedback", "/anomalies/:anomalyId/feedback", {
      params: AnomalyParams,
      payload: CostAnomalyFeedbackInput,
      success: CostAnomalyFeedbackResult,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Mark a cost anomaly expected or unexpected")
      .annotate(
        OpenApi.Description,
        "Record whether a finding was expected (planned or known) or unexpected (a real problem), " +
          "with an optional reason category and note. The verdict tunes detection: repeated " +
          "`expected` verdicts on a provider or service raise its spike threshold within bounds " +
          "(see GET /costs/anomaly-sensitivity), and an `expected` verdict with `suppress` creates a " +
          "suppression so the same pattern does not alert again. `unexpected` keeps sensitivity " +
          "where it is and removes any suppression an earlier `expected` verdict on the same anomaly " +
          "created. Sending again replaces the verdict.",
      )
      .annotate(SuccessDescription, "The updated anomaly and its suppression")
      .annotate(InvalidRequestMessage, "Invalid feedback"),
    HttpApiEndpoint.delete("clearFeedback", "/anomalies/:anomalyId/feedback", {
      params: AnomalyParams,
      success: CostAnomaly,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Withdraw a cost anomaly verdict")
      .annotate(
        OpenApi.Description,
        "Clears the verdict and deletes the suppression it created, if any. Suppressions made by " +
          "hand are never touched.",
      )
      .annotate(SuccessDescription, "The updated anomaly"),
    HttpApiEndpoint.get("listSuppressions", "/anomaly-suppressions", {
      params: OrgParams,
      success: CostAnomalySuppressionList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List anomaly suppressions")
      .annotate(
        OpenApi.Description,
        "Every suppression of the organization, active ones first (soonest expiry first), then " +
          "expired ones, most recent first. Expired suppressions are kept so the list can show what " +
          "they suppressed.",
      )
      .annotate(SuccessDescription, "Suppressions"),
    // The 404 is a cost-scoped caller's: org-wide findings are withheld from them.
    HttpApiEndpoint.post("createSuppression", "/anomaly-suppressions", {
      params: OrgParams,
      payload: CostAnomalySuppressionInput,
      success: CostAnomalySuppression.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create an anomaly suppression")
      .annotate(
        OpenApi.Description,
        "Declare that spend in a scope is expected on a pattern of days until an expiry. An " +
          "organization can hold at most 100 active suppressions (409 past that).",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid suppression"),
    HttpApiEndpoint.get("getSuppression", "/anomaly-suppressions/:suppressionId", {
      params: SuppressionParams,
      success: CostAnomalySuppression,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get an anomaly suppression")
      .annotate(SuccessDescription, "The suppression"),
    HttpApiEndpoint.put("updateSuppression", "/anomaly-suppressions/:suppressionId", {
      params: SuppressionParams,
      payload: CostAnomalySuppressionInput,
      success: CostAnomalySuppression,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update an anomaly suppression")
      .annotate(
        OpenApi.Description,
        "Replaces the whole object. Takes effect on the next detection pass.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid suppression"),
    HttpApiEndpoint.delete("deleteSuppression", "/anomaly-suppressions/:suppressionId", {
      params: SuppressionParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete an anomaly suppression")
      .annotate(
        OpenApi.Description,
        "The findings it suppressed keep their rows. Any whose day detection still re-judges (the " +
          "last three days) becomes eligible to alert on the next pass.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("sensitivity", "/anomaly-sensitivity", {
      params: OrgParams,
      success: CostAnomalySensitivity,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Per-key sensitivity learned from feedback")
      .annotate(
        OpenApi.Description,
        "Every provider or service with a verdict in the last 90 days, the σ its spikes are judged " +
          "against, and one sentence saying why.",
      )
      .annotate(SuccessDescription, "Sensitivity"),
    HttpApiEndpoint.get("precision", "/anomaly-precision", {
      params: OrgParams,
      query: {
        // Read raw and checked by the handler, which names the bounds in its 400.
        months: Schema.optionalKey(
          documentedAs(
            Schema.String.check(pattern(/^\d+$/)).annotate({
              description: "Months to cover, 1-24. Defaults to 6.",
            }),
          ),
        ),
      },
      success: CostAnomalyPrecisionReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Anomaly detection precision over time")
      .annotate(
        OpenApi.Description,
        "Per month of the anomalous day: findings detected, suppressed, and marked expected or " +
          "unexpected, and precision (the share of reviewed findings that were real problems).",
      )
      .annotate(SuccessDescription, "Precision report"),
  )
  .prefix("/api/org/:orgId/costs")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Costs") {}

export class CostAnomalyFeedbackApi extends withApiDefaults(
  HttpApi.make("cost-anomaly-feedback").add(CostAnomalyFeedbackGroup),
) {}
