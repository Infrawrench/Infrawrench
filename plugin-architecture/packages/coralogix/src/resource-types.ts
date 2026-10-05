import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";
import { POLICY_PRIORITY_CHOICES } from "./mappers.js";

/**
 * Coralogix resource types. Field names follow the API responses verified in
 * the published OpenAPI document (`/mgmt/openapi/5/openapi.yaml`, 2026-10);
 * each type names the endpoint it lists from.
 */

/**
 * The team the API key belongs to. Coralogix keys are team-scoped, and every
 * management endpoint is implicitly scoped to that team, so an account holds
 * exactly one: it is the account root.
 */
export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "The Coralogix team the API key belongs to. Shows this month's units, GB and estimated cost by pillar and TCO priority, today's use of the daily unit quota, and configuration limits.",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("teamId", "Team ID", { required: false, editable: false }),
    f("dailyQuota", "Daily Quota (units)", { kind: "number", required: false, editable: false }),
    f("todayUnits", "Units Today", { kind: "number", required: false, editable: false }),
    f("monthToDateUnits", "Units This Month", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("monthToDateGb", "GB This Month", { kind: "number", required: false, editable: false }),
    f("monthToDateCost", "Estimated Cost This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("unitPrice", "Price per Unit (USD)", { kind: "number", required: false, editable: false }),
    f("retentionDays", "Retention (days)", { kind: "number", required: false, editable: false }),
    f("usageMetricsExport", "Data Usage Metrics", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("teamId", "Team ID")],
  accountRoot: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /alerts/alerts/v3` (token pagination). */
export const AlertResourceType = rt({
  name: "Alert",
  id: "alert",
  description:
    "A Coralogix alert definition. Edit its name, description and priority, enable or disable it, and chart how often it has triggered.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("priority", "Priority", {
      kind: "enum",
      required: false,
      enumValues: ["P1", "P2", "P3", "P4", "P5"],
      description: "P1 is the most severe, P5 the least.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("groupBy", "Group By", { required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("lastTriggeredAt", "Last Triggered", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("alertId", "Alert ID"), o("alertVersionId", "Alert Version ID")],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "search",
});

/** `GET /dashboards/dashboards/v1/catalog/list`. */
export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description:
    "A Coralogix custom dashboard. Pin or unpin it, make it the team's default dashboard, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("folder", "Folder", { required: false, editable: false }),
    f("pinned", "Pinned", { kind: "boolean", required: false, editable: false }),
    f("isDefault", "Default", { kind: "boolean", required: false, editable: false }),
    f("locked", "Locked", { kind: "boolean", required: false, editable: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("dashboardId", "Dashboard ID")],
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /dataplans/policies/v1`: logs, spans and RUM policies together. */
export const TcoPolicyResourceType = rt({
  name: "TCO Policy",
  plural: "TCO Policies",
  id: "tco-policy",
  description:
    "A TCO Optimizer policy: routes matching logs, spans or RUM events to a priority (High for Frequent Search, Medium for Monitoring, Low for Compliance, or Block), which sets the units per GB. Edit its priority, name and description, or enable or disable it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("priority", "Priority", {
      kind: "enum",
      enumValues: [...POLICY_PRIORITY_CHOICES],
      description:
        "High is fully indexed for Frequent Search, Medium keeps data for Monitoring (alerts, dashboards, Events2Metrics), Low sends it straight to the archive for Compliance, Block drops it. Lower priorities cost fewer units per GB.",
    }),
    f("priorityLabel", "Priority (TCO)", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("applications", "Applications", { required: false, editable: false }),
    f("subsystems", "Subsystems", { required: false, editable: false }),
    f("severities", "Severities", { required: false, editable: false }),
    f("services", "Services", { required: false, editable: false }),
    f("actions", "Actions", { required: false, editable: false }),
    f("order", "Order", { kind: "number", required: false, editable: false }),
    f("currentPriority", "Current Priority (quota override)", {
      required: false,
      editable: false,
    }),
    f("archiveRetentionId", "Archive Retention", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("policyId", "Policy ID")],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "sliders",
});

/** `GET /parsing-rules/rule-groups/v1`. */
export const ParsingRuleGroupResourceType = rt({
  name: "Parsing Rule Group",
  id: "parsing-rule-group",
  description:
    "A group of parsing rules that parse, extract, replace or block log data as it arrives. Enable or disable the group, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("order", "Order", { kind: "number", required: false, editable: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
    f("ruleKinds", "Rule Types", { required: false, editable: false }),
    f("applications", "Applications", { required: false, editable: false }),
    f("subsystems", "Subsystems", { required: false, editable: false }),
    f("severities", "Severities", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
  ],
  outputs: [o("ruleGroupId", "Rule Group ID")],
  supportsDelete: true,
  iconKey: "pipeline",
});

/** `GET /enrichment-rules/enrichment-rules/v1`. */
export const EnrichmentResourceType = rt({
  name: "Enrichment",
  id: "enrichment",
  description:
    "An enrichment rule that adds Geo IP, suspicious IP, AWS resource or custom lookup data to a log field as it arrives. Create one against a field and a lookup you pick, or delete it.",
  fields: [
    f("fieldName", "Field", { editable: false }),
    f("enrichedFieldName", "Enriched Field", { required: false, editable: false }),
    f("kind", "Type", { required: false, editable: false }),
    f("customEnrichment", "Custom Enrichment", { required: false, editable: false }),
    f("customEnrichmentId", "Custom Enrichment ID", { required: false, editable: false }),
    f("awsResourceType", "AWS Resource Type", { required: false, editable: false }),
    f("selectedColumns", "Columns", { required: false, editable: false }),
    f("datasets", "Datasets", { required: false, editable: false }),
  ],
  outputs: [o("enrichmentId", "Enrichment ID")],
  dependsOn: [
    { fieldKey: "customEnrichmentId", targetTypeId: "custom-enrichment", label: "looks up" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "layers",
});

/** `GET /enrichment-rules/custom-enrichment-rules/v1`. */
export const CustomEnrichmentResourceType = rt({
  name: "Custom Enrichment",
  id: "custom-enrichment",
  description:
    "A custom enrichment lookup table uploaded to Coralogix as a CSV file. Enrichment rules use it to add columns to matching logs.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("fileName", "File", { required: false, editable: false }),
    f("fileSize", "File Size (bytes)", { kind: "number", required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("queryOnly", "Query Only", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("customEnrichmentId", "Custom Enrichment ID")],
  supportsDelete: true,
  iconKey: "database",
});

/** `GET /integrations/webhooks/v1`. */
export const OutgoingWebhookResourceType = rt({
  name: "Outbound Webhook",
  id: "outgoing-webhook",
  description:
    "An outbound webhook alerts notify through: Slack, PagerDuty, Opsgenie, Microsoft Teams, Jira, email groups, Amazon EventBridge or a generic HTTP endpoint. Send a test notification, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("externalId", "External ID", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("webhookId", "Webhook ID"), o("externalId", "External ID")],
  supportsDelete: true,
  iconKey: "webhook",
});

/** `GET /dataplan/quota-rules/v1`: one row per entity type in the rule set. */
export const QuotaRuleResourceType = rt({
  name: "Quota Rule",
  id: "quota-rule",
  description:
    "How the team's daily unit quota is shared between entity types (logs, spans, metrics, session recordings...). Change an entity type's allocation, whether it may overflow into unused quota, or switch the rule off.",
  fields: [
    f("entityType", "Entity Type", { editable: false }),
    f("allocation", "Allocation", {
      kind: "number",
      required: false,
      description:
        "A percentage of the daily quota, or a fixed number of units when the allocation type is Locked units.",
    }),
    f("allocationType", "Allocation Type", { required: false, editable: false }),
    f("canOverflow", "Can Overflow", {
      kind: "boolean",
      required: false,
      description: "Let this entity type use quota other entity types leave unused.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("cxManaged", "Managed by Coralogix", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("entityType", "Entity Type")],
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "sliders",
});

/** `GET /events2metrics/events2metrics/v2`. */
export const Events2MetricsResourceType = rt({
  name: "Events2Metrics Rule",
  id: "events2metrics",
  description:
    "An Events2Metrics rule that turns matching logs or spans into metrics, so the raw events can be routed to a cheaper TCO priority. Shows its query, the metrics and labels it produces and its permutation limit; delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("query", "Query", { required: false, editable: false }),
    f("applications", "Applications", { required: false, editable: false }),
    f("subsystems", "Subsystems", { required: false, editable: false }),
    f("severities", "Severities", { required: false, editable: false }),
    f("metrics", "Metrics", { required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("permutationsLimit", "Permutations Limit", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("limitExceeded", "Limit Exceeded", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("e2mId", "Rule ID")],
  supportsDelete: true,
  iconKey: "dashboard",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  TeamResourceType,
  AlertResourceType,
  DashboardResourceType,
  TcoPolicyResourceType,
  ParsingRuleGroupResourceType,
  EnrichmentResourceType,
  CustomEnrichmentResourceType,
  OutgoingWebhookResourceType,
  QuotaRuleResourceType,
  Events2MetricsResourceType,
];
