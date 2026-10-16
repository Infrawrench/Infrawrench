import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { AlertDestination, AlertRulesResponse } from "./alert-rules";

/**
 * Anomaly alerts scoped to one cost report. One per report, addressed by the
 * report's id; the org-wide list is read-only.
 */

const CostReportAnomalyAlertInput = strict({
  enabled: z
    .boolean()
    .openapi({ description: "Off keeps the configuration but stops evaluation." }),
  sigmas: z
    .number()
    .min(1)
    .max(10)
    .openapi({
      description:
        "Standard deviations above the trailing 28-day mean that count as anomalous, 1 to 10. " +
        "The org-wide default is 3.",
      example: 3,
    }),
  minDeltaCents: z
    .number()
    .int()
    .min(100)
    .max(10_000_000)
    .openapi({
      description:
        "Least rise over the trailing mean, in cents of the spend's own currency, before a day " +
        "is reported however many standard deviations it is. 100 to 10,000,000.",
      example: 1000,
    }),
  destinations: z
    .array(AlertDestination)
    .max(20)
    .openapi({
      description:
        "Where findings go, in the alert routing vocabulary (`GET …/anomaly-alert/targets` lists " +
        "what is available). Delivered as given: organization alert rules neither redirect, " +
        "swallow nor hold them for quiet hours. At least one when `enabled`.",
    }),
}).openapi("CostReportAnomalyAlertInput");

const CostReportAnomaly = strict({
  id: z.string(),
  day: z.string().openapi({ description: "The anomalous day, YYYY-MM-DD (UTC)." }),
  currency: z.string(),
  actual: z.number().openapi({ description: "That day's spend in the report's scope." }),
  baseline: z.number().openapi({ description: "The trailing 28-day mean it was judged against." }),
  threshold: z.number().openapi({ description: "The bar it cleared: mean + sigmas x stddev." }),
  notifiedAt: IsoDateTime.nullable().openapi({
    description: "When it was delivered; null while undelivered or inside the 7-day cooldown.",
  }),
  createdAt: IsoDateTime,
}).openapi("CostReportAnomaly");

const CostReportAnomalyAlert = CostReportAnomalyAlertInput.extend({
  id: z.string(),
  reportId: z.string(),
  reportName: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastEvaluatedAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  recent: z
    .array(CostReportAnomaly)
    .openapi({ description: "The latest 20 findings, newest first." }),
}).openapi("CostReportAnomalyAlert");

const CostReportAnomalyAlertTargets = AlertRulesResponse.pick({
  slackChannels: true,
  msTeamsWebhooks: true,
  onCallSchedules: true,
  members: true,
  emailAvailable: true,
  emailSettings: true,
  memberDomains: true,
}).openapi("CostReportAnomalyAlertTargets");

export function registerCostReportAnomalyAlertPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const reportParam = OrgIdParam.extend({
    id: z.string().openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}/anomaly-alert",
    tags: ["Cost reports"],
    summary: "Get a report's anomaly alert",
    description:
      "The report's own anomaly alert and its latest findings. The detector judges the " +
      "report's filtered daily total (its filters and saved filter, per currency) against the " +
      "trailing 28 days after each cost collection, re-judging the last three days as they fill " +
      "in, and delivers a day once (then a 7-day cooldown per currency). 404 when the report has " +
      "none, or when the caller cannot see the report.",
    request: { params: reportParam },
    responses: {
      200: {
        description: "The alert",
        content: { "application/json": { schema: CostReportAnomalyAlert } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-reports/{id}/anomaly-alert/targets",
    tags: ["Cost reports"],
    summary: "List destinations for a report anomaly alert",
    description:
      "The organization's connected Slack channels, Teams webhooks, live on-call rotations, " +
      "members and external-address policy: what the destination picker offers. Paging " +
      "provider targets are listed by `GET /paging-providers/destinations`.",
    request: { params: reportParam },
    responses: {
      200: {
        description: "Destination catalog",
        content: { "application/json": { schema: CostReportAnomalyAlertTargets } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/cost-reports/{id}/anomaly-alert",
    tags: ["Cost reports"],
    summary: "Create or replace a report's anomaly alert",
    description:
      "One alert per report, replaced whole. Destinations must belong to this organization " +
      "(a live Slack channel, a Teams webhook, a current member, an address the email policy " +
      "allows). Requires `org:settings:write`, like report delivery schedules. The alert reads " +
      "spend with the writer's cost visibility when they are cost-scoped.",
    request: {
      params: reportParam,
      body: {
        content: { "application/json": { schema: CostReportAnomalyAlertInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Saved",
        content: { "application/json": { schema: CostReportAnomalyAlert } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/cost-reports/{id}/anomaly-alert",
    tags: ["Cost reports"],
    summary: "Delete a report's anomaly alert",
    description: "Removes the alert and its findings. The report itself is untouched.",
    request: { params: reportParam },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/cost-report-anomaly-alerts",
    tags: ["Cost reports"],
    summary: "List report anomaly alerts",
    description:
      "Every report anomaly alert in the organization whose report the caller can see, in " +
      "report name order, each with its latest findings.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Alerts",
        content: {
          "application/json": {
            schema: strict({ alerts: z.array(CostReportAnomalyAlert) }),
          },
        },
      },
    },
  });
}
