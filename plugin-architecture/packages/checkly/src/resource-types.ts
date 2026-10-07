import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Checkly resource types, one account (`X-Checkly-Account`) per Infrawrench
 * account. Each type names the endpoint it lists from.
 */

export const FREQUENCIES = [
  "0",
  "1",
  "2",
  "5",
  "10",
  "15",
  "30",
  "60",
  "120",
  "180",
  "360",
  "720",
  "1440",
];

/** `GET /v1/checks`, joined with `GET /v1/check-statuses`. */
export const CheckResourceType = rt({
  name: "Check",
  id: "check",
  description:
    "A Checkly check or monitor of any type: API, browser, multistep, Playwright suite, URL, TCP, ICMP, DNS, SSL, gRPC, traceroute or heartbeat. Activate or deactivate it, mute it, run it now, edit its name, frequency, tags and response time limits, and chart response times and failures per location from its results.",
  fields: [
    f("name", "Name"),
    f("frequency", "Frequency (minutes)", {
      kind: "enum",
      required: false,
      enumValues: FREQUENCIES,
      description: "0 is high frequency (every 10 to 30 seconds, API and URL checks only).",
    }),
    f("tags", "Tags", { required: false, description: "Comma-separated." }),
    f("degradedResponseTime", "Degraded After (ms)", { kind: "number", required: false }),
    f("maxResponseTime", "Failing After (ms)", { kind: "number", required: false }),
    f("description", "Description", { required: false }),
    f("checkType", "Type", { required: false, editable: false }),
    f("target", "Target", { required: false, editable: false }),
    f("activated", "Activated", { kind: "boolean", required: false, editable: false }),
    f("muted", "Muted", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("locations", "Locations", { required: false, editable: false }),
    f("privateLocations", "Private Locations", { required: false, editable: false }),
    f("groupId", "Group ID", { required: false, editable: false }),
    f("lastRunLocation", "Last Run Location", { required: false, editable: false }),
    f("sslDaysRemaining", "SSL Days Remaining", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("sslExpiresAt", "SSL Certificate Expires", { required: false, editable: false }),
    f("runtimeId", "Runtime", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("checkId", "Check ID"),
    o("pingUrl", "Heartbeat Ping URL", {
      sensitive: true,
      description: "Heartbeat monitors only.",
    }),
  ],
  dependsOn: [
    { fieldKey: "groupId", targetTypeId: "check-group", label: "in" },
    {
      fieldKey: "privateLocations",
      targetTypeId: "private-location",
      targetKey: "slugName",
      label: "runs on",
    },
  ],
  expiryFields: [
    { fieldKey: "sslExpiresAt", from: "expiry", kind: "tls-cert", label: "SSL certificate" },
  ],
  secretExportTemplates: [
    {
      id: "heartbeat-ping-url",
      displayName: "Heartbeat ping URL",
      entries: [{ envKey: "CHECKLY_HEARTBEAT_URL", outputKey: "pingUrl" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "network",
});

/** `GET /v1/check-groups`. */
export const CheckGroupResourceType = rt({
  name: "Check Group",
  id: "check-group",
  description:
    "A group of checks sharing locations, defaults and alerting. Activate or deactivate every check in it, mute it, run all its checks now, and edit its name, tags and concurrency.",
  fields: [
    f("name", "Name"),
    f("tags", "Tags", { required: false, description: "Comma-separated." }),
    f("concurrency", "Concurrency", {
      kind: "number",
      required: false,
      description: "How many of its checks run at once when the group is triggered from CI.",
    }),
    f("activated", "Activated", { kind: "boolean", required: false, editable: false }),
    f("muted", "Muted", { kind: "boolean", required: false, editable: false }),
    f("locations", "Locations", { required: false, editable: false }),
    f("checkCount", "Checks", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

/** `GET /v1/alert-channels`. */
export const AlertChannelResourceType = rt({
  name: "Alert Channel",
  id: "alert-channel",
  description:
    "Where Checkly sends alerts: email, Slack, a webhook, SMS, a phone call, PagerDuty or Opsgenie. Choose which events it receives (failure, recovery, degraded, SSL expiry).",
  fields: [
    f("sendFailure", "Send Failures", { kind: "boolean", required: false }),
    f("sendRecovery", "Send Recoveries", { kind: "boolean", required: false }),
    f("sendDegraded", "Send Degraded", { kind: "boolean", required: false }),
    f("sslExpiry", "Send SSL Expiry", { kind: "boolean", required: false }),
    f("sslExpiryThreshold", "SSL Expiry Warning (days)", { kind: "number", required: false }),
    f("autoSubscribe", "Subscribe New Checks", { kind: "boolean", required: false }),
    f("type", "Type", { required: false, editable: false }),
    f("target", "Target", { required: false, editable: false }),
    f("subscriptionCount", "Subscribed Checks and Groups", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("channelId", "Alert Channel ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell",
});

/** `GET /v1/maintenance-windows`. */
export const MaintenanceWindowResourceType = rt({
  name: "Maintenance Window",
  id: "maintenance-window",
  description:
    "A one-off or recurring window during which checks with its tags do not run. Rename it, change its tags and description, schedule a new one, or delete one.",
  fields: [
    f("name", "Name"),
    f("tags", "Tags", {
      required: false,
      description: "Comma-separated check and group tags it applies to.",
    }),
    f("description", "Description", { required: false }),
    f("startsAt", "Starts", { required: false, editable: false }),
    f("endsAt", "Ends", { required: false, editable: false }),
    f("repeatUnit", "Repeats", { required: false, editable: false }),
    f("repeatInterval", "Every", { kind: "number", required: false, editable: false }),
    f("repeatEndsAt", "Repeats Until", { required: false, editable: false }),
    f("timezone", "Time Zone", { required: false, editable: false }),
    f("active", "In Progress", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "sliders",
});

/** `GET /v1/private-locations`. */
export const PrivateLocationResourceType = rt({
  name: "Private Location",
  id: "private-location",
  description:
    "A private location: Checkly agents you run in your own network so checks can reach internal services. Rename it, set its proxy, see how many agents are connected and whether they are outdated, and generate an agent API key.",
  fields: [
    f("name", "Name"),
    f("proxyUrl", "Proxy URL", {
      required: false,
      description: "Proxy for outgoing API check HTTP calls.",
    }),
    f("slugName", "Slug", { editable: false }),
    f("agentCount", "Agents", { kind: "number", required: false, editable: false }),
    f("agentVersions", "Agent Versions", { required: false, editable: false }),
    f("outdatedAgents", "Outdated Agents", { kind: "number", required: false, editable: false }),
    f("lastSeen", "Last Seen", { required: false, editable: false }),
    f("keyCount", "API Keys", { kind: "number", required: false, editable: false }),
  ],
  outputs: [
    o("slugName", "Slug"),
    o("agentKey", "Agent API Key", {
      sensitive: true,
      description: "Only for a key generated from Infrawrench (Generate agent key).",
    }),
  ],
  secretExportTemplates: [
    {
      id: "checkly-agent",
      displayName: "Checkly agent",
      entries: [{ envKey: "API_KEY", outputKey: "agentKey" }],
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "server",
});

/** `GET /v1/dashboards`. */
export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description:
    "A public or private Checkly dashboard showing the checks with its tags. Edit its header, description, subdomain, custom domain, tags and refresh rate.",
  fields: [
    f("header", "Header"),
    f("description", "Description", { required: false }),
    f("customUrl", "Subdomain", {
      required: false,
      description: "<subdomain>.checklyhq.com; unique across Checkly.",
    }),
    f("customDomain", "Custom Domain", { required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated: the checks it shows." }),
    f("refreshRate", "Refresh Every (seconds)", {
      kind: "enum",
      required: false,
      enumValues: ["60", "300", "600"],
    }),
    f("isPrivate", "Private", { kind: "boolean", required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
  ],
  outputs: [o("url", "Dashboard URL")],
  dnsServiceHosts: [
    {
      id: "dashboard-subdomain",
      label: "Checkly dashboard",
      hostPattern: "(?!(?:www|app|api)\\.)([a-z0-9-]+)\\.checklyhq\\.com",
      labelIs: "opaque",
      hostKeys: ["url"],
      reason:
        "Anyone can create a Checkly dashboard on an unused subdomain, so a record pointing at one that no longer exists can be taken over to serve their page on your domain.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /v3/status-pages`. */
export const StatusPageResourceType = rt({
  name: "Status Page",
  id: "status-page",
  description: "A Checkly status page. Rename it or change its description, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("url", "URL", { required: false, editable: false }),
    f("customDomain", "Custom Domain", { required: false, editable: false }),
    f("isPrivate", "Private", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("url", "Status Page URL")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /v1/variables`. */
export const VariableResourceType = rt({
  name: "Environment Variable",
  id: "variable",
  description:
    "An account-level environment variable available to every check. Change its value; secret values are write-only and never shown.",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description: "Leave blank to keep the current value.",
    }),
    f("locked", "Locked", { kind: "boolean", required: false }),
    f("secret", "Secret", { kind: "boolean", required: false, editable: false }),
    f("visibleValue", "Current Value", { required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "secret",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  CheckResourceType,
  CheckGroupResourceType,
  AlertChannelResourceType,
  MaintenanceWindowResourceType,
  PrivateLocationResourceType,
  DashboardResourceType,
  StatusPageResourceType,
  VariableResourceType,
];
