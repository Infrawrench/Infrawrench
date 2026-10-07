import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Splunk Observability Cloud resource types, all from the REST API v2. */

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The Splunk Observability Cloud organization the token belongs to: account type and status, renewal, the data-points-per-minute limit and tokens about to expire. The Metrics tab charts usage (active metric time series against the limit, data points received, hosts and containers monitored).",
  fields: [
    f("organizationName", "Name", { editable: false }),
    f("orgId", "Organization ID", { editable: false }),
    f("realm", "Realm", { editable: false }),
    f("accountType", "Account Type", { required: false, editable: false }),
    f("accountStatus", "Account Status", { required: false, editable: false }),
    f("accountRenews", "Renews", { required: false, editable: false }),
    f("accountValidUntil", "Valid Until", { required: false, editable: false }),
    f("dpmLimit", "Data Points per Minute Limit", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("tokensExpiringSoon", "Tokens Expiring in 7 Days", { required: false, editable: false }),
    f("tokensExpiringMonth", "Tokens Expiring in 30 Days", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("orgId", "Organization ID"), o("realm", "Realm"), o("appUrl", "App URL")],
  accountRoot: true,
  supportsMetrics: true,
  iconKey: "account",
});

export const DetectorResourceType = rt({
  name: "Detector",
  id: "detector",
  description:
    "A detector: a SignalFlow program whose detect() blocks raise alerts through rules. Edit its name, description, tags and program, turn its rules off and on, and chart the signals it publishes.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated." }),
    f("programText", "SignalFlow Program", {
      required: false,
      description:
        "The detector's SignalFlow program. Every detect label must keep a matching rule.",
    }),
    f("rules", "Rules", { required: false, editable: false }),
    f("rulesJson", "Rules (JSON)", { required: false, editable: false }),
    f("ruleCount", "Rule Count", { kind: "number", required: false, editable: false }),
    f("disabledRules", "Disabled Rules", { kind: "number", required: false, editable: false }),
    f("teams", "Teams", { required: false, editable: false }),
    f("locked", "Locked", { kind: "boolean", required: false, editable: false }),
    f("overMTSLimit", "Over MTS Limit", { kind: "boolean", required: false, editable: false }),
    f("creator", "Creator", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [o("detectorId", "Detector ID"), o("url", "Detector URL")],
  dependsOn: [
    { fieldKey: "teams", targetTypeId: "team", matchTemplate: "{teams}", label: "owned by" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "bell",
});

export const IncidentResourceType = rt({
  name: "Alert",
  id: "incident",
  description: "An active alert (incident) raised by a detector rule. Clear it once it is handled.",
  fields: [
    f("detectorName", "Detector", { editable: false }),
    f("detectorId", "Detector ID", { required: false, editable: false }),
    f("detectLabel", "Rule", { required: false, editable: false }),
    f("severity", "Severity", { required: false, editable: false }),
    f("anomalyState", "State", { required: false, editable: false }),
    f("active", "Active", { kind: "boolean", required: false, editable: false }),
    f("isMuted", "Muted", { kind: "boolean", required: false, editable: false }),
    f("triggeredAt", "Triggered", { required: false, editable: false }),
    f("inputs", "Inputs", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "detectorId", targetTypeId: "detector", label: "raised by" }],
  pinnable: false,
  iconKey: "alert",
});

export const MutingRuleResourceType = rt({
  name: "Muting Rule",
  id: "muting-rule",
  description:
    "Silences alert notifications that match a set of dimension filters for a period, optionally recurring. Create one, edit its description, end it early, or delete it.",
  fields: [
    f("description", "Description"),
    f("filters", "Filters", { required: false, editable: false }),
    f("startTime", "Starts", { required: false, editable: false }),
    f("stopTime", "Ends", { required: false, editable: false }),
    f("recurrence", "Recurrence", { required: false, editable: false }),
    f("sendAlertsAfter", "Alert When It Ends", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("creator", "Creator", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "bell-off",
});

export const DashboardGroupResourceType = rt({
  name: "Dashboard Group",
  id: "dashboard-group",
  description: "A group of dashboards. Create, rename and delete groups.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("dashboardCount", "Dashboards", { kind: "number", required: false, editable: false }),
    f("teams", "Teams", { required: false, editable: false }),
    f("creator", "Creator", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [o("url", "Dashboard Group URL")],
  dependsOn: [
    { fieldKey: "teams", targetTypeId: "team", matchTemplate: "{teams}", label: "owned by" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description:
    "A dashboard of charts inside a dashboard group. Rename it, change its description, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("groupId", "Dashboard Group", { required: false, editable: false }),
    f("chartCount", "Charts", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("creator", "Creator", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [o("url", "Dashboard URL")],
  parentTypeId: "dashboard-group",
  showInSidebar: true,
  dependsOn: [{ fieldKey: "groupId", targetTypeId: "dashboard-group", label: "in" }],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

export const ChartResourceType = rt({
  name: "Chart",
  id: "chart",
  description:
    "A chart on a dashboard: a SignalFlow program and how to draw it. Edit its name, description and program, chart it here, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("programText", "SignalFlow Program", { required: false }),
    f("chartType", "Type", { required: false, editable: false }),
    f("dashboardId", "Dashboard", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "dashboard",
  dependsOn: [{ fieldKey: "dashboardId", targetTypeId: "dashboard", label: "on" }],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  pinnable: false,
  iconKey: "chart",
});

export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "A team of users that owns detectors and dashboards and has its own alert notification policy. Create, rename and delete teams.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("memberCount", "Members", { kind: "number", required: false, editable: false }),
    f("notificationPolicies", "Notification Policy", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [o("teamId", "Team ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const MemberResourceType = rt({
  name: "Member",
  id: "member",
  description: "A user in the organization. Invite users, grant or revoke admin, or remove them.",
  fields: [
    f("admin", "Admin", { kind: "boolean", required: false }),
    f("email", "Email", { required: false, editable: false }),
    f("fullName", "Name", { required: false, editable: false }),
    f("title", "Title", { required: false, editable: false }),
    f("roles", "Roles", { required: false, editable: false }),
    f("created", "Joined", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "user",
});

export const IntegrationResourceType = rt({
  name: "Integration",
  id: "integration",
  description:
    "A notification, cloud or SSO integration (Slack, PagerDuty, webhook, AWS, GCP, Azure, …). Turn it off and on, validate it, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [o("integrationId", "Integration ID")],
  supportsDelete: true,
  iconKey: "plug",
});

export const OrgTokenResourceType = rt({
  name: "Access Token",
  id: "org-token",
  description:
    "An organization access token for ingest, API or RUM. Edit its description, turn it off and on, rotate its secret (shown once), or delete it.",
  fields: [
    f("description", "Description", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("authScopes", "Scopes", { required: false, editable: false }),
    f("expiry", "Expires", { required: false, editable: false }),
    f("latestRotation", "Last Rotated", { required: false, editable: false }),
    f("dpmQuota", "DPM Quota", { kind: "number", required: false, editable: false }),
    f("exceedingLimits", "Exceeding Limits", { kind: "boolean", required: false, editable: false }),
    f("creator", "Creator", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  expiryFields: [{ fieldKey: "expiry", from: "expiry", kind: "api-token", label: "Token expires" }],
  credentialFormats: [
    {
      id: "rotate",
      label: "Rotate and show secret",
      description:
        "Issues a new secret for this token and shows it once. The old secret stops working immediately.",
      mediaType: "text",
      filenameTemplate: "{resource}.token",
    },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const SloResourceType = rt({
  name: "Service-Level Objective",
  id: "slo",
  description:
    "A service-level objective with its target and compliance window. Delete it here; define it in Splunk.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("target", "Target (%)", { kind: "number", required: false, editable: false }),
    f("compliancePeriod", "Compliance Period", { required: false, editable: false }),
    f("targetType", "Window", { required: false, editable: false }),
    f("alertRules", "Alert Rules", { required: false, editable: false }),
    f("metadata", "Scope", { required: false, editable: false }),
    f("lastUpdated", "Last Updated", { required: false, editable: false }),
  ],
  outputs: [],
  supportsDelete: true,
  iconKey: "target",
});

export const SyntheticTestResourceType = rt({
  name: "Synthetic Test",
  id: "synthetic-test",
  description:
    "A browser, API, HTTP, SSL or port test. Pause and resume it, run it now, see recent runs, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("active", "Active", { kind: "boolean", required: false, editable: false }),
    f("frequency", "Frequency (min)", { kind: "number", required: false, editable: false }),
    f("locations", "Locations", { required: false, editable: false }),
    f("lastRunStatus", "Last Run", { required: false, editable: false }),
    f("lastRunAt", "Last Run At", { required: false, editable: false }),
    f("schedulingStrategy", "Scheduling", { required: false, editable: false }),
    f("testId", "Test ID", { required: false, editable: false }),
  ],
  outputs: [],
  supportsDelete: true,
  iconKey: "search",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  DetectorResourceType,
  IncidentResourceType,
  MutingRuleResourceType,
  DashboardGroupResourceType,
  DashboardResourceType,
  ChartResourceType,
  TeamResourceType,
  MemberResourceType,
  IntegrationResourceType,
  OrgTokenResourceType,
  SloResourceType,
  SyntheticTestResourceType,
];
