import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Better Stack resource types: Uptime (monitors, heartbeats, status pages,
 * on-call, incidents, escalation policies) and Telemetry (sources, source
 * groups, dashboards, alerts), plus the organization's team members. Each
 * type names the endpoint it lists from.
 */

const TEAM = f("team", "Team", { required: false, editable: false });
const MONITOR_TYPES = [
  "status",
  "expected_status_code",
  "keyword",
  "keyword_absence",
  "ping",
  "tcp",
  "udp",
  "smtp",
  "pop",
  "imap",
  "dns",
  "playwright",
];

/** `GET /api/v2/monitors`. */
export const MonitorResourceType = rt({
  name: "Monitor",
  id: "monitor",
  description:
    "A Better Stack Uptime monitor: an HTTP, keyword, ping, port, DNS or Playwright check run from up to four regions. Pause or resume it, edit what it checks and how often, and chart response times per region.",
  fields: [
    f("name", "Name", { description: "Used when Better Stack calls you about it." }),
    f("url", "URL or Host", { required: false }),
    f("monitorType", "Check", { kind: "enum", required: false, enumValues: MONITOR_TYPES }),
    f("checkFrequency", "Check Every (seconds)", { kind: "number", required: false }),
    f("requestTimeout", "Timeout", {
      kind: "number",
      required: false,
      description:
        "Seconds for HTTP checks (2 to 60), milliseconds for server and port checks (500 to 5000).",
    }),
    f("requiredKeyword", "Keyword", { required: false, description: "Keyword checks only." }),
    f("verifySsl", "Verify SSL", { kind: "boolean", required: false }),
    f("confirmationPeriod", "Confirmation Period (seconds)", { kind: "number", required: false }),
    f("recoveryPeriod", "Recovery Period (seconds)", { kind: "number", required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("regions", "Regions", { required: false, editable: false }),
    f("lastCheckedAt", "Last Checked", { required: false, editable: false }),
    f("policyId", "Escalation Policy ID", { required: false, editable: false }),
    f("monitorGroupId", "Monitor Group ID", { required: false, editable: false }),
    f("availability", "Availability, 30 days (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    TEAM,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("monitorId", "Monitor ID"), o("url", "URL")],
  dependsOn: [
    { fieldKey: "policyId", targetTypeId: "escalation-policy", label: "escalates via" },
    { fieldKey: "monitorGroupId", targetTypeId: "monitor-group", label: "in" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "network",
});

/** `GET /api/v2/monitor-groups`. */
export const MonitorGroupResourceType = rt({
  name: "Monitor Group",
  id: "monitor-group",
  description: "A group of monitors. Rename it, or pause and resume every monitor in it.",
  fields: [
    f("name", "Name"),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    TEAM,
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "folder",
});

/** `GET /api/v2/heartbeats`. */
export const HeartbeatResourceType = rt({
  name: "Heartbeat",
  id: "heartbeat",
  description:
    "A heartbeat: a URL your cron job or worker calls on a schedule, alerting when the calls stop. Pause or resume it and change the expected period and grace time. The ping URL is an output you can hand to the job.",
  fields: [
    f("name", "Name"),
    f("period", "Expected Every (seconds)", {
      kind: "number",
      required: false,
      description: "At least 30.",
    }),
    f("grace", "Grace (seconds)", { kind: "number", required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("heartbeatGroupId", "Heartbeat Group ID", { required: false, editable: false }),
    f("availability", "Availability, 30 days (%)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    TEAM,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("pingUrl", "Ping URL", { sensitive: true })],
  dependsOn: [{ fieldKey: "heartbeatGroupId", targetTypeId: "heartbeat-group", label: "in" }],
  secretExportTemplates: [
    {
      id: "heartbeat-url",
      displayName: "Heartbeat URL",
      entries: [{ envKey: "BETTERSTACK_HEARTBEAT_URL", outputKey: "pingUrl" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "job",
});

/** `GET /api/v2/heartbeat-groups`. */
export const HeartbeatGroupResourceType = rt({
  name: "Heartbeat Group",
  id: "heartbeat-group",
  description: "A group of heartbeats. Rename it, or pause and resume every heartbeat in it.",
  fields: [
    f("name", "Name"),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    TEAM,
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "folder",
});

/** `GET /api/v2/status-pages`. */
export const StatusPageResourceType = rt({
  name: "Status Page",
  id: "status-page",
  description:
    "A public (or password-protected) status page. Edit its company name, subdomain, custom domain, time zone, history length and whether it is published, and manage its sections and the monitors it shows.",
  fields: [
    f("companyName", "Company Name"),
    f("subdomain", "Subdomain", {
      description: "Unique across Better Stack: <subdomain>.betteruptime.com.",
    }),
    f("customDomain", "Custom Domain", {
      required: false,
      description: "CNAME it to statuspage.betteruptime.com. Clear it to remove.",
    }),
    f("companyUrl", "Company URL", { required: false }),
    f("timezone", "Time Zone", {
      required: false,
      description: "A Rails time zone name, for example London or Pacific Time (US & Canada).",
    }),
    f("history", "History (days)", { kind: "number", required: false, description: "7 to 365." }),
    f("published", "Published", { kind: "boolean", required: false }),
    f("aggregateState", "State", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("passwordEnabled", "Password Protected", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("subscribable", "Subscribable", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("url", "Status Page URL")],
  dnsServiceHosts: [
    {
      id: "status-page-subdomain",
      label: "Better Stack status page",
      // statuspage.betteruptime.com is the shared custom-domain target, not a page.
      hostPattern: "(?!statuspage\\.)([a-z0-9-]+)\\.betteruptime\\.com",
      labelIs: "opaque",
      hostKeys: ["url"],
      reason:
        "Anyone can create a Better Stack status page with an unused subdomain, so a record pointing at one that no longer exists can be taken over to serve their page on your domain.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /api/v2/status-pages/{id}/sections`. */
export const StatusPageSectionResourceType = rt({
  name: "Status Page Section",
  id: "status-page-section",
  description: "A section of a status page grouping its resources. Rename or reorder it.",
  fields: [
    f("name", "Name"),
    f("position", "Position", { kind: "number", required: false, description: "0 is the top." }),
    f("statusPageId", "Status Page ID", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "status-page",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "layers",
});

/** `GET /api/v2/status-pages/{id}/resources`. */
export const StatusPageResourceResourceType = rt({
  name: "Status Page Resource",
  id: "status-page-resource",
  description:
    "A monitor, heartbeat or other item shown on a status page. Change its public name, explanation and widget, or remove it from the page.",
  fields: [
    f("publicName", "Public Name"),
    f("explanation", "Explanation", { required: false }),
    f("widgetType", "Widget", {
      kind: "enum",
      required: false,
      enumValues: [
        "plain",
        "history",
        "intraday_history",
        "response_times",
        "intraday_response_times",
        "chart_only",
      ],
    }),
    f("resourceType", "Shows", { required: false, editable: false }),
    f("resourceId", "Item ID", { required: false, editable: false }),
    f("sectionId", "Section ID", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("availability", "Availability (%)", { kind: "number", required: false, editable: false }),
    f("statusPageId", "Status Page ID", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "status-page",
  dependsOn: [{ fieldKey: "resourceId", targetTypeId: "monitor", label: "shows" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "network",
});

/** `GET /api/v2/status-pages/{id}/status-reports`. */
export const StatusReportResourceType = rt({
  name: "Status Report",
  id: "status-report",
  description: "An incident or maintenance report published on a status page.",
  fields: [
    f("title", "Title", { editable: false }),
    f("reportType", "Type", { required: false, editable: false }),
    f("aggregateState", "State", { required: false, editable: false }),
    f("startsAt", "Starts", { required: false, editable: false }),
    f("endsAt", "Ends", { required: false, editable: false }),
    f("statusPageId", "Status Page ID", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "status-page",
  supportsDelete: false,
  pinnable: false,
  iconKey: "file",
});

/** `GET /api/v2/on-calls`. */
export const OnCallCalendarResourceType = rt({
  name: "On-Call Calendar",
  id: "on-call-calendar",
  description:
    "An on-call calendar: who is on call now, and the shifts coming up. Rename it, create one, or delete one.",
  fields: [
    f("name", "Name"),
    f("onCallNow", "On Call Now", { required: false, editable: false }),
    f("defaultCalendar", "Default", { kind: "boolean", required: false, editable: false }),
    TEAM,
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

/** `GET /api/v3/incidents` (last 30 days). */
export const IncidentResourceType = rt({
  name: "Incident",
  id: "incident",
  description:
    "An incident from a monitor, heartbeat, integration or opened by hand in the last 30 days. Acknowledge, resolve or delete it, or open one yourself.",
  fields: [
    f("name", "Name", { editable: false }),
    f("cause", "Cause", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("startedAt", "Started", { required: false, editable: false }),
    f("acknowledgedAt", "Acknowledged", { required: false, editable: false }),
    f("acknowledgedBy", "Acknowledged By", { required: false, editable: false }),
    f("resolvedAt", "Resolved", { required: false, editable: false }),
    f("resolvedBy", "Resolved By", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    f("heartbeatId", "Heartbeat ID", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    TEAM,
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "monitorId", targetTypeId: "monitor", label: "from" },
    { fieldKey: "heartbeatId", targetTypeId: "heartbeat", label: "from" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell",
});

/** `GET /api/v3/policies`. */
export const EscalationPolicyResourceType = rt({
  name: "Escalation Policy",
  id: "escalation-policy",
  description:
    "Who gets alerted, in which order, when an incident is not acknowledged. Rename it and change how often it repeats; create a simple one that alerts whoever is on call.",
  fields: [
    f("name", "Name"),
    f("repeatCount", "Repeat Count", { kind: "number", required: false }),
    f("repeatDelay", "Repeat Delay (seconds)", { kind: "number", required: false }),
    f("steps", "Steps", { required: false, editable: false }),
    TEAM,
  ],
  outputs: [o("policyId", "Policy ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

/** `GET /api/v2/sources` (Telemetry). */
export const SourceResourceType = rt({
  name: "Source",
  id: "source",
  description:
    "A Telemetry source receiving logs, metrics or traces. Pause or resume ingesting, change its name and retention, tail its newest logs, query it with SQL and chart events per hour (once SQL access is connected). Its ingesting host and token are outputs.",
  fields: [
    f("name", "Name"),
    f("logsRetention", "Log Retention (days)", { kind: "number", required: false }),
    f("metricsRetention", "Metrics Retention (days)", { kind: "number", required: false }),
    f("platform", "Platform", { required: false, editable: false }),
    f("ingestingPaused", "Ingesting Paused", { kind: "boolean", required: false, editable: false }),
    f("dataRegion", "Data Region", { required: false, editable: false }),
    f("tableName", "Table", { required: false, editable: false }),
    f("sourceGroupId", "Source Group ID", { required: false, editable: false }),
    f("teamId", "Team ID", { required: false, editable: false }),
    TEAM,
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("ingestingHost", "Ingesting Host"),
    o("sourceToken", "Source Token", { sensitive: true }),
  ],
  secretExportTemplates: [
    {
      id: "source-token",
      displayName: "Better Stack source",
      entries: [
        { envKey: "BETTER_STACK_SOURCE_TOKEN", outputKey: "sourceToken" },
        { envKey: "BETTER_STACK_INGESTING_HOST", outputKey: "ingestingHost" },
      ],
    },
  ],
  dependsOn: [{ fieldKey: "sourceGroupId", targetTypeId: "source-group", label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "logs",
});

/** `GET /api/v1/source-groups` (Telemetry). */
export const SourceGroupResourceType = rt({
  name: "Source Group",
  id: "source-group",
  description: "A group of Telemetry sources. Rename it, create one, or delete one.",
  fields: [f("name", "Name"), TEAM],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "folder",
});

/** `GET /api/v2/dashboards` (Telemetry). */
export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description:
    "A Telemetry dashboard. Rename it, change its refresh interval, create an empty one, or delete one.",
  fields: [
    f("name", "Name"),
    f("refreshInterval", "Refresh Every (seconds)", { kind: "number", required: false }),
    f("dateRangeFrom", "Default Range From", {
      required: false,
      description: "For example now-3h.",
    }),
    f("dateRangeTo", "Default Range To", { required: false }),
    f("dashboardGroupId", "Dashboard Group ID", { required: false, editable: false }),
    TEAM,
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /api/v2/alerts` (Telemetry). */
export const TelemetryAlertResourceType = rt({
  name: "Telemetry Alert",
  id: "telemetry-alert",
  description:
    "An alert on a dashboard chart or exploration query. Rename it and change its threshold and check period, or delete it.",
  fields: [
    f("name", "Name"),
    f("operator", "Operator", { required: false }),
    f("value", "Threshold", { kind: "number", required: false }),
    f("checkPeriod", "Check Period (seconds)", { kind: "number", required: false }),
    f("alertType", "Type", { required: false, editable: false }),
  ],
  outputs: [],
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell",
});

/** `GET https://betterstack.com/api/v2/team-members` (global token). */
export const TeamMemberResourceType = rt({
  name: "Team Member",
  id: "team-member",
  description: "A member of a Better Stack team, with their role. Remove them from the team here.",
  fields: [
    f("name", "Name", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("role", "Role", { required: false, editable: false }),
    TEAM,
  ],
  outputs: [o("email", "Email")],
  principalRole: {
    role: "user",
    adminIndicatorKey: "role",
    adminValues: ["admin", "owner", "Admin", "Owner"],
  },
  supportsDelete: true,
  pinnable: false,
  iconKey: "user",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  MonitorResourceType,
  MonitorGroupResourceType,
  HeartbeatResourceType,
  HeartbeatGroupResourceType,
  StatusPageResourceType,
  StatusPageSectionResourceType,
  StatusPageResourceResourceType,
  StatusReportResourceType,
  OnCallCalendarResourceType,
  IncidentResourceType,
  EscalationPolicyResourceType,
  SourceResourceType,
  SourceGroupResourceType,
  DashboardResourceType,
  TelemetryAlertResourceType,
  TeamMemberResourceType,
];
