import type { ResourceDependencyRule, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Honeycomb resource types. Every environment-scoped type carries the
 * environment slug (`environment`) and, where it lives in one, the dataset
 * slug (`dataset`, `__all__` for environment-wide objects). External ids are
 * `{environment}/{dataset}/{id}` because every `/1/...` route needs the
 * dataset back, and the environment picks which configuration key to send.
 */

/** The environment-wide pseudo dataset the `/1/...` routes accept. */
export const ALL_DATASETS = "__all__";

const ENVIRONMENT_FIELD = f("environment", "Environment", { required: false, editable: false });
const DATASET_FIELD = f("dataset", "Dataset", {
  required: false,
  editable: false,
  description: "Empty for environment-wide objects.",
});
const REGION_FIELD = f("region", "Region", { required: false, editable: false });

const IN_ENVIRONMENT: ResourceDependencyRule = {
  fieldKey: "environment",
  targetTypeId: "environment",
  label: "in",
};
const ON_DATASET: ResourceDependencyRule = {
  fieldKey: "dataset",
  targetTypeId: "dataset",
  matchTemplate: "{environment}/{dataset}",
  label: "on",
};

const ENVIRONMENT_COLORS = [
  "",
  "blue",
  "green",
  "gold",
  "red",
  "purple",
  "lightBlue",
  "lightGreen",
  "lightGold",
  "lightRed",
  "lightPurple",
];

/** `GET /2/teams/{team}/environments` (management key) or `GET /1/auth`. */
export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "A Honeycomb environment (production, staging, …) holding its own datasets, triggers, SLOs and boards. Create, rename, recolor or delete it with a management key, connect it with a configuration key to see what is inside, and chart the events it stores.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("color", "Color", {
      kind: "enum",
      required: false,
      enumValues: ENVIRONMENT_COLORS,
      description: "The color Honeycomb shows the environment in.",
    }),
    f("deleteProtected", "Delete Protection", {
      kind: "boolean",
      required: false,
      description: "While on, the environment cannot be deleted. Turn it off before deleting.",
    }),
    f("configurationKey", "Configuration Key", {
      kind: "password",
      required: false,
      description:
        "A configuration key for this environment (Environment Settings, API Keys). Lets Infrawrench list and manage its datasets, triggers, SLOs, boards and markers. Or use Connect environment to create one with the management key.",
    }),
    f("slug", "Slug", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    f("connected", "Connected", { kind: "boolean", required: false, editable: false }),
    f("team", "Team", { required: false, editable: false }),
    REGION_FIELD,
  ],
  outputs: [o("slug", "Slug"), o("environmentId", "Environment ID"), o("url", "Honeycomb URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "layers",
});

/** `GET /1/datasets`, plus `GET /1/dataset_definitions/{dataset}`. */
export const DatasetResourceType = rt({
  name: "Dataset",
  id: "dataset",
  description:
    "A Honeycomb dataset: where one service's (or one source's) events land. Edit its description, JSON unpacking depth, delete protection and the columns Honeycomb treats as trace id, duration, error and so on, and chart event volume, latency percentiles and error rate.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("expandJsonDepth", "JSON Unpacking Depth", {
      kind: "number",
      required: false,
      description:
        "How many levels of nested JSON fields Honeycomb unpacks into columns (0 to 10).",
    }),
    f("deleteProtected", "Delete Protection", {
      kind: "boolean",
      required: false,
      description: "While on, the dataset cannot be deleted. Turn it off before deleting.",
    }),
    f("def_trace_id", "Trace ID Column", {
      required: false,
      description: "Column holding the trace id. Leave blank for Honeycomb's default.",
    }),
    f("def_span_id", "Span ID Column", { required: false }),
    f("def_parent_id", "Parent Span ID Column", { required: false }),
    f("def_name", "Span Name Column", { required: false }),
    f("def_service_name", "Service Name Column", { required: false }),
    f("def_duration_ms", "Duration Column", {
      required: false,
      description: "Column holding the span duration in milliseconds. Feeds the latency charts.",
    }),
    f("def_error", "Error Column", {
      required: false,
      description: "Column that is set when a span failed. Feeds the error rate chart.",
    }),
    f("def_status", "HTTP Status Column", { required: false }),
    f("def_route", "Route Column", { required: false }),
    f("def_user", "User Column", { required: false }),
    f("def_span_kind", "Span Kind Column", { required: false }),
    f("def_annotation_type", "Annotation Type Column", { required: false }),
    f("def_link_trace_id", "Link Trace ID Column", { required: false }),
    f("def_link_span_id", "Link Span ID Column", { required: false }),
    f("def_log_message", "Log Message Column", { required: false }),
    f("def_log_severity", "Log Severity Column", { required: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("datasetType", "Type", { required: false, editable: false }),
    f("columnCount", "Columns", { kind: "number", required: false, editable: false }),
    f("lastWrittenAt", "Last Event", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    ENVIRONMENT_FIELD,
    REGION_FIELD,
  ],
  outputs: [o("slug", "Slug"), o("url", "Honeycomb URL")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "database",
});

/** `GET /1/columns/{dataset}`. */
export const ColumnResourceType = rt({
  name: "Column",
  id: "column",
  description:
    "A column in a dataset. Change its type, description or visibility, add one before events carry it, or delete one nobody sends any more.",
  fields: [
    f("keyName", "Name", { editable: false }),
    f("type", "Type", {
      kind: "enum",
      required: false,
      enumValues: ["string", "integer", "float", "boolean", "histogram"],
      description: "histogram applies to metrics datasets only.",
    }),
    f("description", "Description", { required: false }),
    f("hidden", "Hidden", {
      kind: "boolean",
      required: false,
      description: "Hidden columns are left out of autocomplete and raw data views.",
    }),
    f("lastWrittenAt", "Last Written", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("keyName", "Column Name")],
  parentTypeId: "dataset",
  dependsOn: [ON_DATASET],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

/** `GET /1/derived_columns/{dataset}` (and `__all__` for environment-wide ones). */
export const DerivedColumnResourceType = rt({
  name: "Derived Column",
  id: "derived-column",
  description:
    "A calculated field: a formula Honeycomb evaluates on every event at query time. SLOs use one as their SLI. Edit its formula and description, or create one for a dataset or for the whole environment.",
  fields: [
    f("alias", "Alias", { editable: false }),
    f("expression", "Expression", {
      description: "Derived column formula, for example IF(EXISTS($error), 0, 1).",
    }),
    f("description", "Description", { required: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("alias", "Alias")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [ON_DATASET, IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "function",
});

/** `GET /1/triggers/{dataset}`. */
export const TriggerResourceType = rt({
  name: "Trigger",
  id: "trigger",
  description:
    "A Honeycomb trigger: a query run on a schedule that notifies recipients when its result crosses a threshold. Enable or disable it, change its threshold, frequency and alert behaviour, and chart the query against the threshold.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("thresholdOp", "Threshold Operator", {
      kind: "enum",
      required: false,
      enumValues: [">", ">=", "<", "<="],
    }),
    f("thresholdValue", "Threshold", { kind: "number", required: false }),
    f("exceededLimit", "Times Exceeded Before Alerting", {
      kind: "number",
      required: false,
      description: "How many consecutive evaluations must cross the threshold (1 to 5).",
    }),
    f("frequency", "Frequency (seconds)", {
      kind: "number",
      required: false,
      description:
        "How often the query runs, in seconds: a multiple of 60 between 60 and 86400, and no shorter than the query's time range allows.",
    }),
    f("alertType", "Alert When", {
      kind: "enum",
      required: false,
      enumValues: ["on_change", "on_true", "on_group_change"],
      description:
        "on_change notifies when the trigger fires and resolves, on_true on every evaluation that crosses the threshold, on_group_change per breakdown group.",
    }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("triggered", "Triggered", { kind: "boolean", required: false, editable: false }),
    f("query", "Query", { required: false, editable: false }),
    f("queryId", "Query ID", { required: false, editable: false }),
    f("recipients", "Recipients", { required: false, editable: false }),
    f("recipientIds", "Recipient IDs", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
    REGION_FIELD,
  ],
  outputs: [o("triggerId", "Trigger ID")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [
    ON_DATASET,
    IN_ENVIRONMENT,
    { fieldKey: "recipientIds", targetTypeId: "recipient", label: "notifies" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "bell",
});

/** `GET /1/slos/{dataset}`. */
export const SloResourceType = rt({
  name: "SLO",
  plural: "SLOs",
  id: "slo",
  description:
    "A Honeycomb service level objective: the share of events its SLI derived column marks as good, against a target over a rolling window. Edit the target, window and description, add burn alerts, and chart compliance and event counts hour by hour.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("targetPercent", "Target (%)", {
      kind: "number",
      required: false,
      description: "The share of qualifying events expected to succeed, for example 99.9.",
    }),
    f("timePeriodDays", "Window (days)", {
      kind: "number",
      required: false,
      description: "The rolling window the SLO is evaluated over, in days (1 to 90).",
    }),
    f("sli", "SLI Derived Column", { required: false, editable: false }),
    f("datasets", "Datasets", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("compliance", "Compliance (%)", { kind: "number", required: false, editable: false }),
    f("budgetRemaining", "Budget Remaining (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("tags", "Tags", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
    REGION_FIELD,
  ],
  outputs: [o("sloId", "SLO ID")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "dashboard",
});

/** `GET /1/burn_alerts/{dataset}?slo_id=`. */
export const BurnAlertResourceType = rt({
  name: "Burn Alert",
  id: "burn-alert",
  description:
    "An alert on an SLO's error budget: either when the budget will run out within a time, or when it burns faster than a rate. Edit its thresholds and description, or create one from its SLO.",
  fields: [
    f("alertType", "Kind", { editable: false }),
    f("exhaustionMinutes", "Exhaustion Time (minutes)", {
      kind: "number",
      required: false,
      description:
        "Exhaustion-time alerts: notify when the budget will run out within this many minutes.",
    }),
    f("budgetRateWindowMinutes", "Budget Rate Window (minutes)", {
      kind: "number",
      required: false,
      description: "Budget-rate alerts: the window the burn rate is measured over.",
    }),
    f("budgetRateDecreasePercent", "Budget Decrease (%)", {
      kind: "number",
      required: false,
      description:
        "Budget-rate alerts: notify when the budget drops by this much within the window.",
    }),
    f("description", "Description", { required: false }),
    f("triggered", "Triggered", { kind: "boolean", required: false, editable: false }),
    f("recipients", "Recipients", { required: false, editable: false }),
    f("recipientIds", "Recipient IDs", { required: false, editable: false }),
    f("sloId", "SLO ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("burnAlertId", "Burn Alert ID")],
  parentTypeId: "slo",
  dependsOn: [{ fieldKey: "recipientIds", targetTypeId: "recipient", label: "notifies" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell",
});

/** `GET /1/boards`. */
export const BoardResourceType = rt({
  name: "Board",
  id: "board",
  description:
    "A Honeycomb board: a collection of saved queries, SLOs and text panels. Rename it or change its description, create an empty one, manage its saved views, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("type", "Type", { required: false, editable: false }),
    f("panelCount", "Panels", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("boardId", "Board ID"), o("url", "Honeycomb URL")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /1/boards/{board}/views`. */
export const BoardViewResourceType = rt({
  name: "Board View",
  id: "board-view",
  description: "A saved view of a board: the board's queries with a set of filters applied.",
  fields: [
    f("name", "Name"),
    f("filters", "Filters", { required: false, editable: false }),
    f("boardId", "Board ID", { required: false, editable: false }),
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("viewId", "View ID")],
  parentTypeId: "board",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

/** `GET /1/markers/{dataset}`. */
export const MarkerResourceType = rt({
  name: "Marker",
  id: "marker",
  description:
    "A marker: a deploy, feature flag change or other event drawn on Honeycomb's graphs. Add one by hand, or edit its message, type and link.",
  fields: [
    f("message", "Message", { required: false }),
    f("type", "Type", {
      required: false,
      description: "Groups markers and picks their color, for example deploy.",
    }),
    f("url", "Link", { required: false }),
    f("startTime", "Start", { required: false, editable: false }),
    f("endTime", "End", { required: false, editable: false }),
    f("color", "Color", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("markerId", "Marker ID")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [ON_DATASET, IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "deployment",
});

/** `GET /1/marker_settings/{dataset}`. */
export const MarkerSettingResourceType = rt({
  name: "Marker Setting",
  id: "marker-setting",
  description:
    "The color Honeycomb draws one marker type in, for a dataset or the whole environment.",
  fields: [
    f("type", "Marker Type", { editable: false }),
    f("color", "Color", { description: "A hex color, for example #F96E10." }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [ON_DATASET, IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

/** `GET /1/query_annotations/{dataset}`. */
export const SavedQueryResourceType = rt({
  name: "Saved Query",
  plural: "Saved Queries",
  id: "saved-query",
  description:
    "A named Honeycomb query (a query annotation). Charts the query over the selected time range on the Metrics tab, and can be renamed, described, created from a simple query builder or deleted.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("query", "Query", { required: false, editable: false }),
    f("queryId", "Query ID", { required: false, editable: false }),
    f("source", "Source", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [o("queryId", "Query ID")],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [ON_DATASET, IN_ENVIRONMENT],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "search",
});

/** `GET /1/recipients`. Team-wide, read through any connected environment. */
export const RecipientResourceType = rt({
  name: "Recipient",
  id: "recipient",
  description:
    "Where triggers and burn alerts send notifications: an email address, Slack channel, PagerDuty service, Microsoft Teams workflow or webhook. Recipients are shared by every environment on the team.",
  fields: [
    f("type", "Type", { editable: false }),
    f("target", "Target", {
      required: false,
      description:
        "The email address, Slack channel (#name), PagerDuty integration name, webhook or Teams workflow name.",
    }),
    f("url", "URL", {
      required: false,
      description: "Webhook and Microsoft Teams recipients only: where notifications are posted.",
    }),
    f("secret", "Secret or Integration Key", {
      kind: "password",
      required: false,
      description:
        "Webhook recipients: the shared secret sent with each notification. PagerDuty recipients: the integration key. Leave blank to keep the current one.",
    }),
    f("triggerCount", "Triggers", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("recipientId", "Recipient ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "email",
});

/** `GET /1/signals`. */
export const SignalResourceType = rt({
  name: "Signal",
  id: "signal",
  description:
    "Anomaly detection on one service's error rate or presence, run by Honeycomb. Turn it on or off and change its sensitivity.",
  fields: [
    f("serviceName", "Service", { editable: false }),
    f("measuredSignal", "Watches", { required: false, editable: false }),
    f("sensitivity", "Sensitivity", {
      kind: "enum",
      required: false,
      enumValues: ["low", "medium", "high"],
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("currentlyAnomalous", "Anomalous Now", { kind: "boolean", required: false, editable: false }),
    f("lastAnomalyAt", "Last Anomaly", { required: false, editable: false }),
    DATASET_FIELD,
    ENVIRONMENT_FIELD,
  ],
  outputs: [],
  parentTypeId: "environment",
  showInSidebar: true,
  dependsOn: [ON_DATASET, IN_ENVIRONMENT],
  supportsUpdate: true,
  supportsDelete: false,
  pinnable: false,
  iconKey: "search",
});

/** `GET /2/teams/{team}/api-keys` (management key). Metadata only. */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An ingest or configuration key for one environment. Create one with exactly the permissions it needs (its secret is shown once, as the Key output), rename it, disable or enable it, or delete it.",
  fields: [
    f("name", "Name"),
    f("keyType", "Type", { required: false, editable: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
    f("environmentId", "Environment ID", { required: false, editable: false }),
    ENVIRONMENT_FIELD,
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("keyId", "Key ID"),
    o("key", "Key", {
      sensitive: true,
      description:
        "Only available for keys created from Infrawrench: Honeycomb shows a secret once.",
    }),
  ],
  dependsOn: [IN_ENVIRONMENT],
  expiryFields: [{ fieldKey: "createdAt", from: "created", kind: "api-token", label: "Key age" }],
  principalRole: { role: "key", createdKey: "createdAt" },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  EnvironmentResourceType,
  DatasetResourceType,
  ColumnResourceType,
  DerivedColumnResourceType,
  TriggerResourceType,
  SloResourceType,
  BurnAlertResourceType,
  BoardResourceType,
  BoardViewResourceType,
  MarkerResourceType,
  MarkerSettingResourceType,
  SavedQueryResourceType,
  RecipientResourceType,
  SignalResourceType,
  ApiKeyResourceType,
];
