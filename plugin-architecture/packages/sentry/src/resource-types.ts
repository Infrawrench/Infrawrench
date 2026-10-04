import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Sentry resource types. Everything is org-scoped: the organization picked in
 * the credentials. Field names follow Sentry's public API reference
 * (https://docs.sentry.io/api/, 2026-10).
 */

const orgField = f("organization", "Organization", { required: false, editable: false });

const projectRef = [
  f("projectSlug", "Project", { required: false, editable: false }),
  f("projectId", "Project ID", { required: false, editable: false }),
];

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The Sentry organization this connection reads. Shows month-to-date usage per data category (errors, spans, replays, attachments, profiles, logs, cron and uptime monitors) with what was accepted, filtered and rate limited, an estimated cost, and charts daily usage.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("monthToDate", "Estimated Month-to-Date Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("slug", "Organization slug"), o("url", "Sentry URL")],
  supportsMetrics: true,
  iconKey: "account",
});

export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A Sentry project. Shows its platform, teams, events accepted and dropped over the last 24 hours and its unresolved issues, and charts accepted, filtered and rate-limited events. Create one for a team, rename it, change its platform or delete it.",
  fields: [
    f("name", "Name"),
    f("platform", "Platform", { required: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("teams", "Teams", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("events24h", "Events Accepted (24h)", { kind: "number", required: false, editable: false }),
    f("dropped24h", "Events Dropped (24h)", { kind: "number", required: false, editable: false }),
    f("unresolvedIssues", "Unresolved Issues", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("firstEvent", "First Event", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("projectId", "Project ID", { required: false, editable: false }),
    orgField,
  ],
  outputs: [o("slug", "Project slug"), o("projectId", "Project ID"), o("url", "Sentry URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "app",
});

export const TeamResourceType = rt({
  name: "Team",
  id: "team",
  description:
    "A Sentry team: who owns which projects. Shows its members and projects. Create, rename or delete a team.",
  fields: [
    f("name", "Name"),
    f("slug", "Slug", { required: false, editable: false }),
    f("memberCount", "Members", { kind: "number", required: false, editable: false }),
    f("projects", "Projects", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("teamId", "Team ID", { required: false, editable: false }),
    orgField,
  ],
  outputs: [o("slug", "Team slug")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "users",
});

export const ReleaseResourceType = rt({
  name: "Release",
  id: "release",
  description:
    "A release of your code, as reported to Sentry. Shows when it was created and released, its projects, new issues it introduced, commits and its last deploy. The 100 most recent releases are listed.",
  fields: [
    f("version", "Version", { editable: false }),
    f("shortVersion", "Short Version", { required: false, editable: false }),
    f("projects", "Projects", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("dateReleased", "Released", { required: false, editable: false }),
    f("newGroups", "New Issues", { kind: "number", required: false, editable: false }),
    f("commitCount", "Commits", { kind: "number", required: false, editable: false }),
    f("deployCount", "Deploys", { kind: "number", required: false, editable: false }),
    f("lastDeployEnvironment", "Last Deploy Environment", { required: false, editable: false }),
    f("lastDeployAt", "Last Deployed", { required: false, editable: false }),
    f("ref", "Ref", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
  ],
  outputs: [o("version", "Version")],
  iconKey: "tag",
});

export const IssueResourceType = rt({
  name: "Issue",
  id: "issue",
  parentTypeId: "project",
  showInSidebar: true,
  description:
    "An unresolved Sentry issue. The 100 issues with the most events in the last 14 days are listed. Resolve it, archive it until it escalates or for good, or reopen it, and chart its events.",
  fields: [
    f("title", "Title", { editable: false }),
    f("shortId", "Short ID", { required: false, editable: false }),
    f("culprit", "Culprit", { required: false, editable: false }),
    f("level", "Level", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("substatus", "Substatus", { required: false, editable: false }),
    f("priority", "Priority", { required: false, editable: false }),
    f("count", "Events", { kind: "number", required: false, editable: false }),
    f("userCount", "Users", { kind: "number", required: false, editable: false }),
    f("firstSeen", "First Seen", { required: false, editable: false }),
    f("lastSeen", "Last Seen", { required: false, editable: false }),
    f("assignedTo", "Assignee", { required: false, editable: false }),
    f("issueType", "Type", { required: false, editable: false }),
    ...projectRef,
  ],
  outputs: [o("shortId", "Short ID"), o("url", "Sentry URL")],
  supportsMetrics: true,
  iconKey: "alert",
});

export const ClientKeyResourceType = rt({
  name: "Client Key (DSN)",
  plural: "Client Keys (DSN)",
  id: "client-key",
  parentTypeId: "project",
  description:
    "A project's client key: the DSN your SDKs send events with. Shows whether it is enabled and its rate limit. Create one, rename it, change its rate limit, enable or disable it, or delete it.",
  fields: [
    f("name", "Name"),
    f("rateLimitCount", "Rate Limit (events)", {
      kind: "number",
      required: false,
      description: "Events accepted per window through this key. Leave empty for no limit.",
    }),
    f("rateLimitWindow", "Rate Limit Window (seconds)", {
      kind: "number",
      required: false,
      description: "Length of the rate-limit window in seconds, e.g. 60 or 3600.",
    }),
    f("isActive", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("dsn", "DSN", { required: false, editable: false }),
    f("publicKey", "Public Key", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("keyId", "Key ID", { required: false, editable: false }),
    orgField,
    ...projectRef,
  ],
  outputs: [o("dsn", "DSN"), o("publicKey", "Public key")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const AlertResourceType = rt({
  name: "Alert",
  id: "alert",
  description:
    "A Sentry alert: when its triggers fire and its filters match, Sentry runs its actions (email, Slack, PagerDuty and so on). Shows its triggers, actions, connected monitors and when it last fired. Enable or disable it, rename it, change how often it can fire, or delete it.",
  fields: [
    f("name", "Name"),
    f("frequency", "Action Interval (minutes)", {
      kind: "number",
      required: false,
      description:
        "Minimum minutes between two runs of the alert's actions for the same issue, e.g. 5, 30, 60 or 1440.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("triggers", "Triggers", { required: false, editable: false }),
    f("filters", "Filters", { required: false, editable: false }),
    f("actions", "Actions", { required: false, editable: false }),
    f("monitorCount", "Connected Monitors", { kind: "number", required: false, editable: false }),
    f("lastTriggered", "Last Triggered", { required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("alertId", "Alert ID", { required: false, editable: false }),
  ],
  outputs: [o("alertId", "Alert ID")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "bell",
});

export const MonitorResourceType = rt({
  name: "Monitor",
  id: "monitor",
  description:
    "A Sentry monitor (detector) that opens issues: error grouping, a metric threshold on errors, spans or sessions, or an issue stream. Shows its type, query and thresholds, the alerts it feeds and its latest issue. Enable, disable or delete it. Cron and uptime monitors are listed as their own types.",
  fields: [
    f("name", "Name", { editable: false }),
    f("monitorType", "Type", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("aggregate", "Aggregate", { required: false, editable: false }),
    f("query", "Filter", { required: false, editable: false }),
    f("timeWindow", "Time Window (minutes)", { kind: "number", required: false, editable: false }),
    f("thresholds", "Thresholds", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("alertCount", "Connected Alerts", { kind: "number", required: false, editable: false }),
    f("latestIssue", "Latest Issue", { required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("dateCreated", "Created", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    ...projectRef,
  ],
  outputs: [o("monitorId", "Monitor ID")],
  supportsDelete: true,
  iconKey: "search",
});

export const CronMonitorResourceType = rt({
  name: "Cron Monitor",
  id: "cron-monitor",
  description:
    "A Sentry cron monitor: a scheduled job that checks in. Shows its schedule and the status of each environment. Pause or resume it, mute or unmute its alerts, edit its name, schedule and margins, delete it, and chart check-in durations.",
  fields: [
    f("name", "Name"),
    f("schedule", "Schedule", {
      required: false,
      description:
        "A crontab expression such as 0 * * * *, or an interval such as 10 minute (units: minute, hour, day, week, month, year).",
    }),
    f("timezone", "Timezone", {
      required: false,
      description: "IANA timezone the crontab is evaluated in, e.g. UTC or Europe/Berlin.",
    }),
    f("checkinMargin", "Check-in Margin (minutes)", {
      kind: "number",
      required: false,
      description: "How late a check-in may arrive before it counts as missed.",
    }),
    f("maxRuntime", "Max Runtime (minutes)", {
      kind: "number",
      required: false,
      description: "How long a job may run before it counts as timed out.",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("health", "Health", { required: false, editable: false }),
    f("isMuted", "Muted", { kind: "boolean", required: false, editable: false }),
    f("environments", "Environments", { required: false, editable: false }),
    f("lastCheckIn", "Last Check-in", { required: false, editable: false }),
    f("nextCheckIn", "Next Check-in", { required: false, editable: false }),
    f("slug", "Slug", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    ...projectRef,
  ],
  outputs: [o("slug", "Monitor slug")],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "clock",
});

export const UptimeMonitorResourceType = rt({
  name: "Uptime Monitor",
  id: "uptime-monitor",
  description:
    "A Sentry uptime monitor: an HTTP check Sentry runs against a URL. Shows whether the URL is up, the check interval and timeout. Pause or resume it, edit its name, URL, interval and timeout, delete it, and chart check results.",
  fields: [
    f("name", "Name"),
    f("checkUrl", "URL", { required: false }),
    f("intervalSeconds", "Interval (seconds)", {
      kind: "enum",
      required: false,
      enumValues: ["60", "300", "600", "1200", "1800", "3600"],
      description: "How often Sentry checks the URL.",
    }),
    f("timeoutMs", "Timeout (ms)", {
      kind: "number",
      required: false,
      description: "How long a check waits for a response before it fails, up to 60000 ms.",
    }),
    f("method", "Method", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("uptimeStatus", "Uptime", { required: false, editable: false }),
    f("environment", "Environment", { required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    ...projectRef,
  ],
  outputs: [o("checkUrl", "URL")],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "network",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  ProjectResourceType,
  TeamResourceType,
  ReleaseResourceType,
  IssueResourceType,
  ClientKeyResourceType,
  AlertResourceType,
  MonitorResourceType,
  CronMonitorResourceType,
  UptimeMonitorResourceType,
];
