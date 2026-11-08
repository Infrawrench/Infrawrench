/**
 * Metric alerts: `/api/org/:orgId/metric-alerts`, the endpoint definitions.
 *
 * Request bodies are the shared schemas the rule editor validates with
 * (`MetricAlertRuleInput` in `@infrawrench/ui/schemas`). The Terraform
 * provider manages these rules (`infrawrench_metric_alert`), so component and
 * property names stay as the Zod spec published them.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { MetricAlertRuleInput } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { numericQuery } from "../../schemas/query";

const ruleFields = {
  ...MetricAlertRuleInput.fields,
  id: Uuid,
  lastEvalAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const MetricAlertRule = Schema.Struct(ruleFields).annotate({
  identifier: "MetricAlertRule",
});

export const MetricAlertRuleWithStatus = Schema.Struct({
  ...ruleFields,
  firingCount: Schema.Int.annotate({
    description: "Resources currently in breach of this rule.",
  }),
  matchingResourceCount: Schema.Int.annotate({
    description: "Resources the selector matches right now.",
  }),
}).annotate({ identifier: "MetricAlertRuleWithStatus" });

export const MetricAlertEvent = Schema.Struct({
  id: Uuid,
  ruleId: Uuid,
  ruleName: Schema.String,
  resourceId: Schema.String,
  resourceName: Schema.String,
  status: Schema.Literals(["firing", "resolved"]),
  observedValue: Schema.Finite.annotate({
    description: "Worst sample observed in the breaching window, in the metric's unit.",
  }),
  firedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "MetricAlertEvent" });

export const MetricSeriesKey = Schema.Struct({
  label: Schema.String,
  unit: Schema.String,
  resourceCount: Schema.Int.annotate({
    description: "Distinct resources that reported this series in the last 7 days.",
  }),
}).annotate({ identifier: "MetricSeriesKey" });

export const MetricAlertSelectorOptions = Schema.Struct({
  plugins: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      resourceTypeIds: Schema.Array(Schema.String),
    }),
  ),
  tagKeys: Schema.Array(Schema.String).annotate({
    description:
      "Tag keys on the org's resources, with its tag key settings applied: preferred keys " +
      "first, hidden keys omitted.",
  }),
  preferredTagKeys: Schema.Array(Schema.String).annotate({
    description: "The subset of `tagKeys` the org pins, in its order.",
  }),
}).annotate({ identifier: "MetricAlertSelectorOptions" });

export const MetricAlertSelectorPreview = Schema.Struct({
  matchingResourceCount: Schema.Int,
  sampleResourceNames: Schema.Array(Schema.String).annotate({
    description: "Up to 10 matching display names, for a live form preview.",
  }),
}).annotate({ identifier: "MetricAlertSelectorPreview" });

/** A query string read as sent: the handlers treat an empty one as absent. */
const optionalText = Schema.optionalKey(Schema.String);

export class MetricAlertsGroup extends HttpApiGroup.make("metricAlerts")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(MetricAlertRuleWithStatus),
    })
      .annotate(RequiredPermission, "metric-alerts:read")
      .annotate(OpenApi.Summary, "List metric alert rules with live firing status")
      .annotate(SuccessDescription, "Rules"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: MetricAlertRuleInput,
      success: MetricAlertRule,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "metric-alerts:write")
      .annotate(OpenApi.Summary, "Create a metric alert rule")
      .annotate(
        OpenApi.Description,
        "Rules select resources by query (plugin + resource type + tag), never by id list, so a rule automatically covers resources created after it was written. The poller evaluates enabled rules about once a minute and alerts when the condition held for the whole trailing window.",
      )
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid metric alert rule"),
    HttpApiEndpoint.get("metricKeys", "/metric-keys", {
      params: OrgParams,
      query: { pluginId: optionalText, resourceTypeId: optionalText },
      success: Schema.Array(MetricSeriesKey),
    })
      .annotate(RequiredPermission, "metric-alerts:read")
      .annotate(OpenApi.Summary, "List metric series that actually exist")
      .annotate(
        OpenApi.Description,
        "The series labels resources reported in the last 7 days, optionally narrowed to one plugin and resource type; what the rule builder's metric picker is fed from.",
      )
      .annotate(SuccessDescription, "Series keys"),
    HttpApiEndpoint.get("selectorOptions", "/selector-options", {
      params: OrgParams,
      success: MetricAlertSelectorOptions,
    })
      .annotate(RequiredPermission, "metric-alerts:read")
      .annotate(OpenApi.Summary, "List what the organization's resources offer to select on")
      .annotate(SuccessDescription, "Selector options"),
    // The selector is decoded in the handler, after empty parts become null,
    // and refused as `Invalid selector` with its issues.
    HttpApiEndpoint.get("selectorPreview", "/selector-preview", {
      params: OrgParams,
      query: {
        pluginId: optionalText,
        resourceTypeId: optionalText,
        tagKey: optionalText,
        tagValue: optionalText,
      },
      success: MetricAlertSelectorPreview,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "metric-alerts:read")
      .annotate(OpenApi.Summary, "Preview which resources a selector matches right now")
      .annotate(SuccessDescription, "Preview")
      .annotate(InvalidRequestMessage, "Invalid selector"),
    // `limit` is parsed leniently by the handler (anything not a positive
    // number is ignored), so it is read as sent and documented as the integer.
    HttpApiEndpoint.get("events", "/events", {
      params: OrgParams,
      query: { ruleId: Schema.optionalKey(Uuid), limit: optionalText },
      success: Schema.Array(MetricAlertEvent),
    })
      .annotate(RequiredPermission, "metric-alerts:read")
      .annotate(OpenApi.Summary, "Recent metric alert firings")
      .annotate(SuccessDescription, "Events, newest first")
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
      ),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: MetricAlertRule,
      error: NotFound,
    })
      .annotate(RequiredPermission, "metric-alerts:read")
      .annotate(OpenApi.Summary, "Get a metric alert rule")
      .annotate(SuccessDescription, "Rule"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: MetricAlertRuleInput,
      success: MetricAlertRule,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "metric-alerts:write")
      .annotate(OpenApi.Summary, "Update a metric alert rule")
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid metric alert rule"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "metric-alerts:write")
      .annotate(OpenApi.Summary, "Delete a metric alert rule")
      .annotate(
        OpenApi.Description,
        "Soft delete. The rule's firing history stays readable via /metric-alerts/events.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/metric-alerts")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Metric alerts") {}

export class MetricAlertsApi extends withApiDefaults(
  HttpApi.make("metricAlerts").add(MetricAlertsGroup),
) {}
