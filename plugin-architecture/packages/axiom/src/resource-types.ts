import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Axiom resource types. A token is scoped to one organization, so the
 * organization is the plugin's account root and everything else hangs off
 * the account. Each type names the endpoint it lists from.
 */

/** `GET /v2/orgs/{id}` (the token's organization). */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The Axiom organization the token belongs to: its plan, billing period and the limits its license sets. Charts hourly ingest and query compute from the audit log. Rename it here.",
  fields: [
    f("name", "Name"),
    f("plan", "Plan", { required: false, editable: false }),
    f("paymentStatus", "Payment Status", { required: false, editable: false }),
    f("defaultEdgeDeployment", "Default Edge Deployment", { required: false, editable: false }),
    f("edgeDeployments", "Edge Deployments", { required: false, editable: false }),
    f("billingPeriodStart", "Billing Period Start", { required: false, editable: false }),
    f("billingPeriodEnd", "Billing Period End", { required: false, editable: false }),
    f("monthlyIngestGb", "Monthly Ingest Allowance (GB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("monthlyQueryGbHours", "Monthly Query Allowance (GB-hours)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maxDatasets", "Dataset Limit", { kind: "number", required: false, editable: false }),
    f("maxMonitors", "Monitor Limit", { kind: "number", required: false, editable: false }),
    f("maxUsers", "User Limit", { kind: "number", required: false, editable: false }),
    f("maxFields", "Fields per Dataset Limit", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("primaryEmail", "Primary Email", { required: false, editable: false }),
    f("orgId", "Organization ID", { required: false, editable: false }),
  ],
  outputs: [o("orgId", "Organization ID")],
  accountRoot: true,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

const DATASET_FIELD = f("dataset", "Dataset", { required: false, editable: false });
const ON_DATASET = { fieldKey: "dataset", targetTypeId: "dataset", targetKey: "name", label: "on" };

/** `GET /v2/datasets`. */
export const DatasetResourceType = rt({
  name: "Dataset",
  id: "dataset",
  description:
    "An Axiom dataset of events, logs, traces or metrics. Query it with APL in the query editor, tail its newest events in the Logs tab, chart events and ingested bytes, change its description and retention, trim old data or vacuum unused fields.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("useRetentionPeriod", "Custom Retention", {
      kind: "boolean",
      required: false,
      description:
        "On to delete events older than the retention below; off keeps them for the plan's default.",
    }),
    f("retentionDays", "Retention (days)", { kind: "number", required: false }),
    f("kind", "Kind", { required: false, editable: false }),
    f("edgeDeployment", "Edge Deployment", { required: false, editable: false }),
    f("mapFields", "Map Fields", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("sharedByOrg", "Shared By Organization", { required: false, editable: false }),
  ],
  outputs: [o("name", "Dataset Name"), o("edgeUrl", "Ingest and Query Endpoint")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "database",
});

/** `GET /v2/datasets/{id}/fields`. */
export const FieldResourceType = rt({
  name: "Field",
  id: "field",
  description:
    "A field (column) in a dataset. Set its unit, description and whether it is hidden, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("unit", "Unit", {
      required: false,
      description: "How Axiom formats values, for example ms, s, bytes or percent.",
    }),
    f("description", "Description", { required: false }),
    f("hidden", "Hidden", { kind: "boolean", required: false }),
    DATASET_FIELD,
  ],
  outputs: [],
  parentTypeId: "dataset",
  dependsOn: [ON_DATASET],
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

/** `GET /v2/vfields?dataset=`. */
export const VirtualFieldResourceType = rt({
  name: "Virtual Field",
  id: "virtual-field",
  description:
    "A field Axiom computes at query time from an APL expression. Create one on a dataset and edit its expression, type, unit and description.",
  fields: [
    f("name", "Name"),
    f("expression", "Expression", {
      description: "An APL expression, for example toint(status) >= 500.",
    }),
    f("type", "Type", { required: false }),
    f("unit", "Unit", { required: false }),
    f("description", "Description", { required: false }),
    DATASET_FIELD,
  ],
  outputs: [],
  parentTypeId: "dataset",
  showInSidebar: true,
  dependsOn: [ON_DATASET],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "function",
});

/** `GET /v2/monitors`. */
export const MonitorResourceType = rt({
  name: "Monitor",
  id: "monitor",
  description:
    "An Axiom monitor: a threshold, match-event or anomaly check on an APL query, run on a schedule. Enable, disable or snooze it, edit its query, threshold and schedule, and chart its query against the threshold with its recent alerts.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("aplQuery", "APL Query", { required: false }),
    f("operator", "Operator", {
      kind: "enum",
      required: false,
      enumValues: ["", "Above", "AboveOrEqual", "Below", "BelowOrEqual", "AboveOrBelow"],
      description: "Threshold monitors: how the query result is compared with the threshold.",
    }),
    f("threshold", "Threshold", { kind: "number", required: false }),
    f("intervalMinutes", "Run Every (minutes)", { kind: "number", required: false }),
    f("rangeMinutes", "Look Back (minutes)", { kind: "number", required: false }),
    f("alertOnNoData", "Alert on No Data", { kind: "boolean", required: false }),
    f("notifyByGroup", "Alert per Group", { kind: "boolean", required: false }),
    f("notifyEveryRun", "Notify Every Run", { kind: "boolean", required: false }),
    f("type", "Type", { required: false, editable: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("disabledUntil", "Snoozed Until", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("notifiers", "Notifiers", { required: false, editable: false }),
    f("notifierIds", "Notifier IDs", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("monitorId", "Monitor ID")],
  dependsOn: [{ fieldKey: "notifierIds", targetTypeId: "notifier", label: "notifies" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "bell",
});

/** `GET /v2/notifiers`. */
export const NotifierResourceType = rt({
  name: "Notifier",
  id: "notifier",
  description:
    "Where monitors send alerts: email, Slack, PagerDuty, Opsgenie, Microsoft Teams, Discord or a webhook. Create, rename or retarget one, snooze it for a while, or delete it.",
  fields: [
    f("name", "Name"),
    f("target", "Target", {
      required: false,
      description:
        "Email: comma-separated addresses. Slack, Teams, Discord webhook, webhook: the URL. Leave PagerDuty and Opsgenie keys blank to keep them.",
    }),
    f("secret", "Routing Key or API Key", {
      kind: "password",
      required: false,
      description:
        "PagerDuty routing key or Opsgenie API key. Leave blank to keep the current one.",
    }),
    f("channel", "Channel", { required: false, editable: false }),
    f("disabledUntil", "Snoozed Until", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("notifierId", "Notifier ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell",
});

/** `GET /v2/dashboards`. */
export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description:
    "An Axiom dashboard of APL and MPL charts. Rename it or change its description, create an empty one, open it in Axiom, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("charts", "Charts", { kind: "number", required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("uid", "UID", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
  ],
  outputs: [o("uid", "Dashboard UID"), o("url", "Axiom URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /v2/views`. */
export const ViewResourceType = rt({
  name: "View",
  id: "view",
  description:
    "A named APL query others can query as if it were a dataset, often used to share part of a dataset. Edit its query and description.",
  fields: [
    f("name", "Name", { editable: false }),
    f("aplQuery", "APL Query"),
    f("description", "Description", { required: false }),
    f("datasets", "Datasets", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "search",
});

/** `GET /v2/apl-starred-queries?who=all`. */
export const StarredQueryResourceType = rt({
  name: "Saved Query",
  plural: "Saved Queries",
  id: "starred-query",
  description:
    "A starred APL query. Its Metrics tab runs the query over the selected time range and charts what it returns.",
  fields: [
    f("name", "Name"),
    f("apl", "APL", { required: false, editable: false }),
    f("dataset", "Dataset", { required: false, editable: false }),
    f("who", "Starred By", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [ON_DATASET],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  pinnable: false,
  iconKey: "search",
});

/** `GET /v2/annotations`. */
export const AnnotationResourceType = rt({
  name: "Annotation",
  id: "annotation",
  description:
    "An annotation: a deploy or other event Axiom marks on the charts of the datasets it names. Add one by hand, or edit its title, description and link.",
  fields: [
    f("title", "Title", { required: false }),
    f("description", "Description", { required: false }),
    f("url", "Link", { required: false }),
    f("type", "Type", { required: false, editable: false }),
    f("time", "Time", { required: false, editable: false }),
    f("endTime", "End", { required: false, editable: false }),
    f("datasets", "Datasets", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "deployment",
});

/** `GET /v2/tokens`. Metadata only: the token itself is shown once. */
export const ApiTokenResourceType = rt({
  name: "API Token",
  id: "api-token",
  description:
    "An Axiom API token with its organization and dataset capabilities. Create one with exactly the capabilities it needs (its value is shown once, as the Token output), regenerate it, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("orgCapabilities", "Organization Capabilities", { required: false, editable: false }),
    f("datasetCapabilities", "Dataset Capabilities", { required: false, editable: false }),
  ],
  outputs: [
    o("tokenId", "Token ID"),
    o("token", "Token", {
      sensitive: true,
      description:
        "Only for tokens created or regenerated from Infrawrench: Axiom shows a token once.",
    }),
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Token expiry" },
  ],
  principalRole: { role: "key" },
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

/** `GET /v2/users`. */
export const UserResourceType = rt({
  name: "User",
  id: "user",
  description: "A member of the Axiom organization, with their role. Remove a user from here.",
  fields: [
    f("name", "Name", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("role", "Role", { required: false, editable: false }),
  ],
  outputs: [o("email", "Email")],
  principalRole: {
    role: "user",
    adminIndicatorKey: "role",
    adminValues: ["owner", "admin", "Owner", "Admin"],
  },
  supportsDelete: true,
  pinnable: false,
  iconKey: "user",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  DatasetResourceType,
  FieldResourceType,
  VirtualFieldResourceType,
  MonitorResourceType,
  NotifierResourceType,
  DashboardResourceType,
  ViewResourceType,
  StarredQueryResourceType,
  AnnotationResourceType,
  ApiTokenResourceType,
  UserResourceType,
];
