import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Config API route, list key and body key behind each slug-addressed type. */
export const CONFIG: Record<string, { plural: string; listKey: string; singular: string }> = {
  monitor: { plural: "monitors", listKey: "monitors", singular: "monitor" },
  "notification-policy": {
    plural: "notification-policies",
    listKey: "notification_policies",
    singular: "notification_policy",
  },
  notifier: { plural: "notifiers", listKey: "notifiers", singular: "notifier" },
  collection: { plural: "collections", listKey: "collections", singular: "collection" },
  bucket: { plural: "buckets", listKey: "buckets", singular: "bucket" },
  team: { plural: "teams", listKey: "teams", singular: "team" },
  dashboard: { plural: "dashboards", listKey: "dashboards", singular: "dashboard" },
  slo: { plural: "slos", listKey: "slos", singular: "slo" },
  "rollup-rule": { plural: "rollup-rules", listKey: "rollup_rules", singular: "rollup_rule" },
  "drop-rule": { plural: "drop-rules", listKey: "drop_rules", singular: "drop_rule" },
  "recording-rule": {
    plural: "recording-rules",
    listKey: "recording_rules",
    singular: "recording_rule",
  },
  "muting-rule": { plural: "muting-rules", listKey: "muting_rules", singular: "muting_rule" },
  "service-account": {
    plural: "service-accounts",
    listKey: "service_accounts",
    singular: "service_account",
  },
  service: { plural: "services", listKey: "services", singular: "service" },
};

const SLUG = f("slug", "Slug", { editable: false });
const TEAM = f("teamSlug", "Team", { required: false, editable: false });
const UPDATED = f("updatedAt", "Updated", { required: false, editable: false });
const TEAM_DEP = { fieldKey: "teamSlug", targetTypeId: "team", label: "owned by" };
const POLICY_DEP = {
  fieldKey: "notificationPolicySlug",
  targetTypeId: "notification-policy",
  label: "notifies through",
};

export const TenantResourceType = rt({
  name: "Tenant",
  id: "tenant",
  description:
    "The Chronosphere tenant the token belongs to, with counts of what it holds. The Query tab runs PromQL against it.",
  fields: [
    f("org", "Organization", { editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("monitorCount", "Monitors", { kind: "number", required: false, editable: false }),
    f("collectionCount", "Collections", { kind: "number", required: false, editable: false }),
    f("dashboardCount", "Dashboards", { kind: "number", required: false, editable: false }),
    f("sloCount", "SLOs", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("url", "Tenant URL"), o("promUrl", "Prometheus API URL")],
  accountRoot: true,
  supportsRestQuery: true,
  iconKey: "account",
});

export const MonitorResourceType = rt({
  name: "Monitor",
  id: "monitor",
  description:
    "An alerting monitor: a PromQL (or Graphite/log) query with warn and critical conditions. Create, edit the name, description, query and interval, delete, and chart its query.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("query", "PromQL Query", {
      required: false,
      description: "Only PromQL monitors can be edited here.",
    }),
    f("intervalSecs", "Interval (s)", { kind: "number", required: false }),
    f("queryType", "Query Type", { required: false, editable: false }),
    f("conditions", "Conditions", { required: false, editable: false }),
    f("collectionSlug", "Collection", { required: false, editable: false }),
    f("bucketSlug", "Bucket", { required: false, editable: false }),
    f("notificationPolicySlug", "Notification Policy", { required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("signalGrouping", "Signals", { required: false, editable: false }),
    f("scheduled", "Has Schedule", { kind: "boolean", required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "Monitor Slug")],
  dependsOn: [
    { fieldKey: "collectionSlug", targetTypeId: "collection", label: "in" },
    { fieldKey: "bucketSlug", targetTypeId: "bucket", label: "in" },
    POLICY_DEP,
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "bell",
});

export const NotificationPolicyResourceType = rt({
  name: "Notification Policy",
  id: "notification-policy",
  plural: "Notification Policies",
  description:
    "Routes alert signals to notifiers by severity, with optional per-label overrides. Rename or delete it.",
  fields: [
    f("name", "Name"),
    f("warnRoute", "Warn Routes To", { required: false, editable: false }),
    f("criticalRoute", "Critical Routes To", { required: false, editable: false }),
    f("overrideCount", "Overrides", { kind: "number", required: false, editable: false }),
    TEAM,
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "Notification Policy Slug")],
  dependsOn: [TEAM_DEP],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "route",
});

export const NotifierResourceType = rt({
  name: "Notifier",
  id: "notifier",
  description:
    "Where notifications go: Slack, PagerDuty, OpsGenie, VictorOps, email, webhook or discard. Rename it, change whether resolves are sent, or delete it.",
  fields: [
    f("name", "Name"),
    f("skipResolved", "Skip Resolved", { kind: "boolean", required: false }),
    f("type", "Type", { required: false, editable: false }),
    f("target", "Target", { required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "Notifier Slug")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "webhook",
});

export const CollectionResourceType = rt({
  name: "Collection",
  id: "collection",
  description:
    "Groups monitors and dashboards under a team, with a default notification policy. Create, edit and delete collections.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    TEAM,
    f("notificationPolicySlug", "Default Notification Policy", {
      required: false,
      editable: false,
    }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "Collection Slug")],
  dependsOn: [TEAM_DEP, POLICY_DEP],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const BucketResourceType = rt({
  name: "Bucket",
  id: "bucket",
  description:
    "The older way to group monitors and dashboards, superseded by collections. Create, edit and delete buckets.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    TEAM,
    f("notificationPolicySlug", "Default Notification Policy", {
      required: false,
      editable: false,
    }),
    f("labels", "Labels", { required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "Bucket Slug")],
  dependsOn: [TEAM_DEP, POLICY_DEP],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "archive",
});

export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "A team and its members. Create teams, rename them, change the description or member list, or delete them.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("userEmails", "Members", {
      required: false,
      description: "Comma-separated email addresses.",
    }),
    f("memberCount", "Member Count", { kind: "number", required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "Team Slug")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description: "A dashboard in a collection. Rename it or delete it.",
  fields: [
    f("name", "Name"),
    f("collectionSlug", "Collection", { required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("url", "Dashboard URL")],
  dependsOn: [{ fieldKey: "collectionSlug", targetTypeId: "collection", label: "in" }],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

export const SloResourceType = rt({
  name: "Service-Level Objective",
  id: "slo",
  description:
    "An SLO: an objective over a time window, measured by a good/bad or timeslice PromQL indicator, with optional burn-rate alerting. Edit its name, description and objective, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("objective", "Objective (%)", { kind: "number", required: false }),
    f("timeWindow", "Window", { required: false, editable: false }),
    f("indicator", "Indicator", { required: false, editable: false }),
    f("burnRateAlerting", "Burn-Rate Alerting", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("collectionSlug", "Collection", { required: false, editable: false }),
    f("notificationPolicySlug", "Notification Policy", { required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [o("slug", "SLO Slug")],
  dependsOn: [{ fieldKey: "collectionSlug", label: "in" }, POLICY_DEP],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "target",
});

export const RollupRuleResourceType = rt({
  name: "Rollup Rule",
  id: "rollup-rule",
  description:
    "Aggregates matching series into a new metric at ingest to cut cardinality. Switch between enabled and preview, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("mode", "Mode", { required: false, editable: false }),
    f("metricName", "Output Metric", { required: false, editable: false }),
    f("aggregation", "Aggregation", { required: false, editable: false }),
    f("filters", "Matches", { required: false, editable: false }),
    f("dropRaw", "Drops Raw Series", { kind: "boolean", required: false, editable: false }),
    f("bucketSlug", "Bucket", { required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [],
  supportsDelete: true,
  iconKey: "funnel",
});

export const DropRuleResourceType = rt({
  name: "Drop Rule",
  id: "drop-rule",
  description: "Drops matching series at ingest. Turn it on, off or into preview, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("mode", "Mode", { required: false, editable: false }),
    f("filters", "Matches", { required: false, editable: false }),
    f("conditional", "Conditional", { kind: "boolean", required: false, editable: false }),
    f("dropNaN", "Drops NaN", { kind: "boolean", required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [],
  supportsDelete: true,
  iconKey: "trash",
});

export const RecordingRuleResourceType = rt({
  name: "Recording Rule",
  id: "recording-rule",
  description:
    "Precomputes a PromQL expression into a new metric. Edit the expression or interval, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("metricName", "Metric", { required: false, editable: false }),
    f("expr", "PromQL Expression", { required: false }),
    f("intervalSecs", "Interval (s)", { kind: "number", required: false }),
    f("executionGroup", "Execution Group", { required: false, editable: false }),
    f("bucketSlug", "Bucket", { required: false, editable: false }),
    SLUG,
    UPDATED,
  ],
  outputs: [],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "function",
});

export const MutingRuleResourceType = rt({
  name: "Muting Rule",
  id: "muting-rule",
  description:
    "Silences alerts whose labels match, between a start and an end. Create one, end it now, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("matchers", "Matches", { required: false, editable: false }),
    f("startsAt", "Starts", { required: false, editable: false }),
    f("endsAt", "Ends", { required: false, editable: false }),
    f("comment", "Comment", { required: false }),
    SLUG,
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "bell-off",
});

export const ServiceAccountResourceType = rt({
  name: "Service Account",
  id: "service-account",
  description:
    "A service account whose token authenticates automation. Delete it to revoke the token.",
  fields: [
    f("name", "Name", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("unrestricted", "Unrestricted", { kind: "boolean", required: false, editable: false }),
    f("restriction", "Metrics Restriction", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    SLUG,
  ],
  outputs: [],
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "api-token", label: "Token due for rotation" },
  ],
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description: "A service Chronosphere discovered from traces and metrics, with its owning team.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    TEAM,
    f("notificationPolicySlug", "Notification Policy", { required: false, editable: false }),
    SLUG,
  ],
  outputs: [],
  dependsOn: [TEAM_DEP, POLICY_DEP],
  iconKey: "function",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  TenantResourceType,
  MonitorResourceType,
  NotificationPolicyResourceType,
  NotifierResourceType,
  CollectionResourceType,
  BucketResourceType,
  TeamResourceType,
  DashboardResourceType,
  SloResourceType,
  RollupRuleResourceType,
  DropRuleResourceType,
  RecordingRuleResourceType,
  MutingRuleResourceType,
  ServiceAccountResourceType,
  ServiceResourceType,
];
