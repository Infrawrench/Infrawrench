/**
 * Change-based cost alerts: `/api/org/:orgId/cost-alerts`, the endpoint
 * definitions.
 *
 * The third cost-alert family, distinct from the other two on purpose:
 * budgets fire on an absolute monthly total, anomaly detection fires on
 * unconfigured statistical outliers, and these fire on a configured relative
 * change on a chosen scope and cadence. Evaluation runs from the poller; these
 * routes only manage the configuration and read what fired. Reads need
 * `costs:read`, writes `costs:write`, the cost-reports stance. The body is the
 * shared schema the alert editor validates with (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AlertEmailRecipients,
  CostAlertFilter,
  CostAlertInput,
  CostChangeCadence,
  CostChangeDirection,
  CostDimension,
  IsoDate as Day,
} from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";

const EventDay = Day.annotate({ examples: ["2026-08-09"] });

export const CostAlert = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  filters: Schema.Array(CostAlertFilter),
  groupBy: Schema.NullOr(CostDimension).annotate({
    description:
      "Per-group fan-out. Null watches the scope's one total; a dimension watches each group " +
      "against its own prior window, and each offending group fires its own event.",
  }),
  groupByTagKey: Schema.NullOr(Schema.String),
  cadence: CostChangeCadence,
  thresholdPercent: Schema.NullOr(Schema.Int),
  thresholdAmountCents: Schema.NullOr(Schema.Int),
  direction: CostChangeDirection,
  enabled: Schema.Boolean,
  lastEvaluatedAt: Schema.NullOr(IsoDateTime),
  lastFiredAt: Schema.NullOr(IsoDateTime),
  emailRecipients: AlertEmailRecipients,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({
  identifier: "CostAlert",
  description:
    "A change-based cost alert: fires when spend on its scope moves more than the configured " +
    "threshold versus the prior period. The third alert family alongside budgets (absolute " +
    "monthly total) and anomaly detection (statistical outliers against a learned baseline).",
});

const CostAlertEvent = Schema.Struct({
  id: Uuid,
  alertId: Uuid,
  alertName: Schema.String,
  periodKey: Schema.String.annotate({
    description:
      "The cadence period the firing belongs to; a day, an ISO week (2026-W32) or a month " +
      "(2026-08). One period fires at most once per group and currency.",
  }),
  windowFrom: EventDay,
  windowTo: EventDay,
  previousFrom: EventDay,
  previousTo: EventDay,
  groupKey: Schema.String.annotate({
    description: "The offending group; empty when the alert watches one total.",
  }),
  currency: Schema.String,
  previousAmountCents: Schema.Int,
  currentAmountCents: Schema.Int,
  changePercent: Schema.NullOr(Schema.Int).annotate({
    description:
      "Signed percent change. Null when the prior window had no spend at all (new spend; the " +
      "change is infinite); -100 when the group vanished.",
  }),
  direction: Schema.Literals(["increase", "decrease"]),
  firedAt: IsoDateTime,
  notifiedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "CostAlertEvent" });

export const CostAlertList = Schema.Struct({ alerts: Schema.Array(CostAlert) });
export const CostAlertEventList = Schema.Struct({ events: Schema.Array(CostAlertEvent) });

export class CostAlertsGroup extends HttpApiGroup.make("costAlerts")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: CostAlertList,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List change-based cost alerts")
      .annotate(SuccessDescription, "Alerts"),
    HttpApiEndpoint.get("events", "/events", {
      params: OrgParams,
      query: {
        alertId: Schema.optionalKey(Uuid),
        // Read raw and checked by the handler, which answers its own 400.
        limit: Schema.optionalKey(
          documentedAs(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
        ),
      },
      success: CostAlertEventList,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List recently fired cost-alert events")
      .annotate(
        OpenApi.Description,
        "Newest first. Optionally scoped to one alert with ?alertId=; an unknown alertId is a 404, " +
          "distinct from an alert that simply has no events yet.",
      )
      .annotate(SuccessDescription, "Events"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: CostAlertInput,
      success: CostAlert,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a change-based cost alert")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid cost alert"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: CostAlert,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a cost alert")
      .annotate(SuccessDescription, "Alert"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: CostAlertInput,
      success: CostAlert,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Update a cost alert")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid cost alert"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a cost alert")
      .annotate(
        OpenApi.Description,
        "Soft delete. Fired events disappear from the org-wide event feed with it.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/cost-alerts")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Cost alerts") {}

export class CostAlertsApi extends withApiDefaults(
  HttpApi.make("cost-alerts").add(CostAlertsGroup),
) {}
