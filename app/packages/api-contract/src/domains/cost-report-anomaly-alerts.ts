/**
 * Anomaly alerts scoped to one cost report, the endpoint definitions:
 * `/api/org/:orgId/cost-reports/:id/anomaly-alert` (one per report) and the
 * org-wide list at `/api/org/:orgId/cost-report-anomaly-alerts`.
 *
 * Reads are `costs:read` plus viewer access to the report through object
 * sharing (an invisible report reads as not found), like the report itself.
 * Writes and the destination catalog are `org:settings:write`, the report
 * schedule stance: an alert is standing authorisation to send this scope's
 * spend to destinations the writer picks, arbitrary email addresses included.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { AlertDestination, alertDestinationCatalogFields } from "../http/schemas/alert-routing";
import { IsoDateTime, OrgId, OrgParams } from "../http/schemas/common";

/**
 * Documented. The handler reads the body itself after finding the report,
 * checking its shape, then each destination, then the limits, each with its
 * own sentence.
 */
const costReportAnomalyAlertInputFields = {
  enabled: Schema.Boolean.annotate({
    description: "Off keeps the configuration but stops evaluation.",
  }),
  sigmas: Schema.Finite.annotate({
    description:
      "Standard deviations above the trailing 28-day mean that count as anomalous, 1 to 10. " +
      "The org-wide default is 3.",
    examples: [3],
  }).check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  minDeltaCents: Schema.Int.annotate({
    description:
      "Least rise over the trailing mean, in cents of the spend's own currency, before a day " +
      "is reported however many standard deviations it is. 100 to 10,000,000.",
    examples: [1000],
  }).check(Schema.isBetween({ minimum: 100, maximum: 10_000_000 })),
  destinations: Schema.Array(AlertDestination)
    .annotate({
      description:
        "Where findings go, in the alert routing vocabulary (`GET …/anomaly-alert/targets` lists " +
        "what is available). Delivered as given: organization alert rules neither redirect, " +
        "swallow nor hold them for quiet hours. At least one when `enabled`.",
    })
    .check(Schema.isMaxLength(20)),
};

const CostReportAnomalyAlertInput = Schema.Struct(costReportAnomalyAlertInputFields).annotate({
  identifier: "CostReportAnomalyAlertInput",
});

const CostReportAnomaly = Schema.Struct({
  id: Schema.String,
  day: Schema.String.annotate({ description: "The anomalous day, YYYY-MM-DD (UTC)." }),
  currency: Schema.String,
  actual: Schema.Finite.annotate({ description: "That day's spend in the report's scope." }),
  baseline: Schema.Finite.annotate({
    description: "The trailing 28-day mean it was judged against.",
  }),
  threshold: Schema.Finite.annotate({
    description: "The bar it cleared: mean + sigmas x stddev.",
  }),
  notifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When it was delivered; null while undelivered or inside the 7-day cooldown.",
  }),
  createdAt: IsoDateTime,
}).annotate({ identifier: "CostReportAnomaly" });

export const CostReportAnomalyAlert = Schema.Struct({
  ...costReportAnomalyAlertInputFields,
  id: Schema.String,
  reportId: Schema.String,
  reportName: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastEvaluatedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  recent: Schema.Array(CostReportAnomaly).annotate({
    description: "The latest 20 findings, newest first.",
  }),
}).annotate({ identifier: "CostReportAnomalyAlert" });

export const CostReportAnomalyAlertTargets = Schema.Struct(alertDestinationCatalogFields).annotate({
  identifier: "CostReportAnomalyAlertTargets",
});

export const CostReportAnomalyAlertDeleted = Schema.Struct({ ok: Schema.Boolean });

export const CostReportAnomalyAlertList = Schema.Struct({
  alerts: Schema.Array(CostReportAnomalyAlert),
});

/** The report's id; never documented as a UUID here. */
const ReportParams = { orgId: OrgId, id: Schema.String } as const;

export class CostReportAnomalyAlertsGroup extends HttpApiGroup.make("costReportAnomalyAlerts")
  .add(
    HttpApiEndpoint.get("get", "/:id/anomaly-alert", {
      params: ReportParams,
      success: CostReportAnomalyAlert,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a report's anomaly alert")
      .annotate(
        OpenApi.Description,
        "The report's own anomaly alert and its latest findings. The detector judges the " +
          "report's filtered daily total (its filters and saved filter, per currency) against the " +
          "trailing 28 days after each cost collection, re-judging the last three days as they fill " +
          "in, and delivers a day once (then a 7-day cooldown per currency). 404 when the report has " +
          "none, or when the caller cannot see the report.",
      )
      .annotate(SuccessDescription, "The alert"),
    HttpApiEndpoint.get("targets", "/:id/anomaly-alert/targets", {
      params: ReportParams,
      success: CostReportAnomalyAlertTargets,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List destinations for a report anomaly alert")
      .annotate(
        OpenApi.Description,
        "The organization's connected Slack channels, Teams webhooks, live on-call rotations, " +
          "members and external-address policy: what the destination picker offers. Paging " +
          "provider targets are listed by `GET /paging-providers/destinations`.",
      )
      .annotate(SuccessDescription, "Destination catalog"),
    HttpApiEndpoint.put("put", "/:id/anomaly-alert", {
      params: ReportParams,
      payload: CostReportAnomalyAlertInput,
      success: CostReportAnomalyAlert,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create or replace a report's anomaly alert")
      .annotate(
        OpenApi.Description,
        "One alert per report, replaced whole. Destinations must belong to this organization " +
          "(a live Slack channel, a Teams webhook, a current member, an address the email policy " +
          "allows). Requires `org:settings:write`, like report delivery schedules. The alert reads " +
          "spend with the writer's cost visibility when they are cost-scoped.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid anomaly alert"),
    HttpApiEndpoint.delete("delete", "/:id/anomaly-alert", {
      params: ReportParams,
      success: CostReportAnomalyAlertDeleted,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a report's anomaly alert")
      .annotate(
        OpenApi.Description,
        "Removes the alert and its findings. The report itself is untouched.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/cost-reports")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

export class OrgReportAnomalyAlertsGroup extends HttpApiGroup.make("orgReportAnomalyAlerts")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: CostReportAnomalyAlertList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List report anomaly alerts")
      .annotate(
        OpenApi.Description,
        "Every report anomaly alert in the organization whose report the caller can see, in " +
          "report name order, each with its latest findings.",
      )
      .annotate(SuccessDescription, "Alerts"),
  )
  .prefix("/api/org/:orgId/cost-report-anomaly-alerts")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost reports") {}

export class CostReportAnomalyAlertsApi extends withApiDefaults(
  HttpApi.make("cost-report-anomaly-alerts")
    .add(CostReportAnomalyAlertsGroup)
    .add(OrgReportAnomalyAlertsGroup),
) {}
