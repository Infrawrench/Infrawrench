import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostAnomaly, CostAnomalyFeedbackReason } from "./costs";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-10-01" });

const Recurrence = z
  .enum(["one_off", "weekly", "monthly", "seasonal"])
  .describe(
    "How the suppression repeats. `one_off` covers every day from `startsOn` to `expiresOn`; " +
      "`weekly` the anchor day's weekday; `monthly` the anchor day's day of the month, give or " +
      "take a day (an anchor past the end of a shorter month falls on its last day); " +
      "`seasonal` the anchor day's calendar date, give or take three days, every year.",
  )
  .openapi("CostAnomalyRecurrence");

const Scope = z
  .enum(["provider", "service", "account", "tag", "cost_centre"])
  .describe(
    "What the suppression covers. On a covered day the scope's spend is set aside before the " +
      "day is judged; a finding that only existed because of it is stored as suppressed and " +
      "never alerted on, and one that survives (spend beyond the expected slice) alerts as normal.",
  )
  .openapi("CostAnomalySuppressionScope");

const SuppressionInput = strict({
  scope: Scope,
  scopeKey: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "The scope's value: a plugin id (`provider`), a service name, an account id, a tag value, " +
        "or a cost centre id. Accounts and cost centres must belong to the organization.",
    ),
  tagKey: z.string().min(1).max(256).optional().describe("Required when `scope` is `tag`."),
  recurrence: Recurrence,
  anchorDay: IsoDate.describe("The day the pattern is anchored to."),
  startsOn: IsoDate.optional().describe("First day covered. Defaults to `anchorDay`."),
  expiresOn: IsoDate.describe(
    "Last day covered, inclusive. At most three years after `startsOn`, and not before it.",
  ),
  reason: CostAnomalyFeedbackReason.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
}).openapi("CostAnomalySuppressionInput");

const Suppression = strict({
  id: Uuid,
  scope: Scope,
  scopeKey: z.string(),
  tagKey: z.string().nullable(),
  scopeLabel: z
    .string()
    .nullable()
    .describe("The account or cost centre name for id-valued scopes; null otherwise."),
  recurrence: Recurrence,
  anchorDay: IsoDate,
  startsOn: IsoDate,
  expiresOn: IsoDate,
  reason: CostAnomalyFeedbackReason.nullable(),
  note: z.string().nullable(),
  sourceAnomalyId: Uuid.nullable().describe(
    "The anomaly whose `expected` verdict created this; null for one made by hand.",
  ),
  createdByUserId: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  active: z.boolean().describe("Whether it still covers today or a later day. Read-only."),
  suppressedCount: z
    .number()
    .int()
    .describe("How many detected findings it has suppressed so far. Read-only."),
}).openapi("CostAnomalySuppression");

const FeedbackInput = strict({
  verdict: z
    .enum(["expected", "unexpected"])
    .describe("`expected`: planned or known. `unexpected`: a real problem."),
  reason: CostAnomalyFeedbackReason.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  explain: z
    .boolean()
    .optional()
    .describe(
      "Also record the note as the anomaly's explanation, which publishes it as an annotation " +
        "on every chart covering the day (the same as POST …/acknowledge). Ignored without a note.",
    ),
  suppress: strict({
    recurrence: Recurrence,
    scope: Scope.optional().describe("Defaults to the anomaly's own provider or service."),
    scopeKey: z.string().min(1).max(256).optional(),
    tagKey: z.string().min(1).max(256).optional(),
    expiresOn: IsoDate.optional().describe(
      "Defaults by recurrence: 7 days (one-off), 90 (weekly), 180 (monthly), 730 (seasonal), " +
        "counted from the later of the anomaly's day and today.",
    ),
  })
    .optional()
    .describe(
      "Only with `verdict: expected`. Creates a suppression anchored to the anomaly's day so the " +
        "same pattern does not alert again; re-sending updates it rather than adding another.",
    ),
}).openapi("CostAnomalyFeedbackInput");

const FeedbackResult = strict({
  anomaly: CostAnomaly,
  suppression: Suppression.nullable(),
}).openapi("CostAnomalyFeedbackResult");

const Sensitivity = strict({
  enabled: z.boolean().describe("The `feedbackTuning` setting; false means no key moves."),
  windowDays: z.number().int(),
  baseSigmas: z.number(),
  adjustments: z.array(
    strict({
      dimension: z.enum(["provider", "service"]),
      dimensionKey: z.string(),
      baseSigmas: z.number(),
      sigmas: z.number().describe("The σ this key's spikes are judged against."),
      expectedCount: z.number().int(),
      unexpectedCount: z.number().int(),
      explanation: z.string(),
    }),
  ),
}).openapi("CostAnomalySensitivity");

const PrecisionCounts = {
  detected: z.number().int(),
  suppressed: z.number().int(),
  expected: z.number().int(),
  unexpected: z.number().int(),
  precision: z
    .number()
    .nullable()
    .describe("unexpected / (expected + unexpected); null when nothing has a verdict."),
};

const Precision = strict({
  months: z.number().int(),
  periods: z.array(strict({ month: z.string(), ...PrecisionCounts })),
  totals: strict(PrecisionCounts),
  reasons: z.array(strict({ reason: CostAnomalyFeedbackReason, count: z.number().int() })),
}).openapi("CostAnomalyPrecisionReport");

const SuppressionIdParam = OrgIdParam.extend({ suppressionId: z.string() });

export function registerCostAnomalyFeedbackPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/anomalies/{anomalyId}/feedback",
    tags: ["Costs"],
    summary: "Mark a cost anomaly expected or unexpected",
    description:
      "Record whether a finding was expected (planned or known) or unexpected (a real problem), " +
      "with an optional reason category and note. The verdict tunes detection: repeated " +
      "`expected` verdicts on a provider or service raise its spike threshold within bounds " +
      "(see GET /costs/anomaly-sensitivity), and an `expected` verdict with `suppress` creates a " +
      "suppression so the same pattern does not alert again. `unexpected` keeps sensitivity " +
      "where it is and removes any suppression an earlier `expected` verdict on the same anomaly " +
      "created. Sending again replaces the verdict.",
    request: {
      params: OrgIdParam.extend({ anomalyId: z.string() }),
      body: { content: { "application/json": { schema: FeedbackInput } }, required: true },
    },
    responses: {
      200: {
        description: "The updated anomaly and its suppression",
        content: { "application/json": { schema: FeedbackResult } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/costs/anomalies/{anomalyId}/feedback",
    tags: ["Costs"],
    summary: "Withdraw a cost anomaly verdict",
    description:
      "Clears the verdict and deletes the suppression it created, if any. Suppressions made by " +
      "hand are never touched.",
    request: { params: OrgIdParam.extend({ anomalyId: z.string() }) },
    responses: {
      200: {
        description: "The updated anomaly",
        content: { "application/json": { schema: CostAnomaly } },
      },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomaly-suppressions",
    tags: ["Costs"],
    summary: "List anomaly suppressions",
    description:
      "Every suppression of the organization, active ones first (soonest expiry first), then " +
      "expired ones, most recent first. Expired suppressions are kept so the list can show what " +
      "they suppressed.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Suppressions",
        content: { "application/json": { schema: strict({ suppressions: z.array(Suppression) }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/costs/anomaly-suppressions",
    tags: ["Costs"],
    summary: "Create an anomaly suppression",
    description:
      "Declare that spend in a scope is expected on a pattern of days until an expiry. An " +
      "organization can hold at most 100 active suppressions (409 past that).",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SuppressionInput } }, required: true },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: Suppression } } },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomaly-suppressions/{suppressionId}",
    tags: ["Costs"],
    summary: "Get an anomaly suppression",
    request: { params: SuppressionIdParam },
    responses: {
      200: {
        description: "The suppression",
        content: { "application/json": { schema: Suppression } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/costs/anomaly-suppressions/{suppressionId}",
    tags: ["Costs"],
    summary: "Update an anomaly suppression",
    description: "Replaces the whole object. Takes effect on the next detection pass.",
    request: {
      params: SuppressionIdParam,
      body: { content: { "application/json": { schema: SuppressionInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Suppression } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/costs/anomaly-suppressions/{suppressionId}",
    tags: ["Costs"],
    summary: "Delete an anomaly suppression",
    description:
      "The findings it suppressed keep their rows. Any whose day detection still re-judges (the " +
      "last three days) becomes eligible to alert on the next pass.",
    request: { params: SuppressionIdParam },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomaly-sensitivity",
    tags: ["Costs"],
    summary: "Per-key sensitivity learned from feedback",
    description:
      "Every provider or service with a verdict in the last 90 days, the σ its spikes are judged " +
      "against, and one sentence saying why.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Sensitivity", content: { "application/json": { schema: Sensitivity } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/anomaly-precision",
    tags: ["Costs"],
    summary: "Anomaly detection precision over time",
    description:
      "Per month of the anomalous day: findings detected, suppressed, and marked expected or " +
      "unexpected, and precision (the share of reviewed findings that were real problems).",
    request: {
      params: OrgIdParam,
      query: strict({
        months: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Months to cover, 1-24. Defaults to 6."),
      }),
    },
    responses: {
      200: {
        description: "Precision report",
        content: { "application/json": { schema: Precision } },
      },
      400: ErrorResponses[400],
    },
  });
}
