import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Datadog resource types. Field names follow the API responses verified in
 * Datadog's published OpenAPI documents (v1 and v2, 2026-10); each type
 * names the endpoint it lists from.
 */

/**
 * `view=sub-org` on the cost endpoints, enriched by `GET /api/v1/org` where
 * the key may read it. A standalone organization is one row; a parent shows
 * itself and every child.
 */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "A Datadog organization (the parent, or each child on a multi-organization account). Shows month-to-date and projected cost by product, cost attribution by tag, and hourly usage.",
  fields: [
    f("name", "Name", { editable: false }),
    f("publicId", "Public ID", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("monthToDate", "Month-to-Date Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("projectedCost", "Projected Month-End Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("plan", "Plan", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("publicId", "Public ID")],
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /api/v1/monitor` (paged with `page` / `page_size`). */
export const MonitorResourceType = rt({
  name: "Monitor",
  id: "monitor",
  description:
    "A Datadog monitor. Edit its name, notification message, priority and tags, mute it for a while or until you unmute it, and chart the metric a metric or query alert watches.",
  fields: [
    f("name", "Name"),
    f("message", "Notification Message", {
      required: false,
      description:
        "Sent with every notification. Mention recipients with @-handles, exactly as in Datadog.",
    }),
    f("priority", "Priority", {
      kind: "enum",
      required: false,
      enumValues: ["", "1", "2", "3", "4", "5"],
      description: "1 is the most severe, 5 the least. Leave blank for no priority.",
    }),
    f("tags", "Tags", {
      required: false,
      description: "Comma-separated, for example team:payments, env:prod.",
    }),
    f("type", "Type", { required: false, editable: false }),
    f("query", "Query", { required: false, editable: false }),
    f("overallState", "State", { required: false, editable: false }),
    f("muted", "Muted", { kind: "boolean", required: false, editable: false }),
    f("thresholds", "Thresholds", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("modifiedAt", "Modified", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
  ],
  outputs: [o("monitorId", "Monitor ID"), o("url", "Datadog URL")],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "search",
});

/** `GET /api/v2/downtime`. Created against a monitor picked from the list. */
export const DowntimeResourceType = rt({
  name: "Downtime",
  id: "downtime",
  description:
    "A scheduled Datadog downtime that silences monitors for a scope and a time window. Create one for a monitor you pick or for every monitor in a scope, change its message or scope, or cancel it.",
  fields: [
    f("scope", "Scope", {
      description: "Which groups are silenced: * for everything, or tags like env:prod.",
    }),
    f("message", "Message", { required: false }),
    f("monitorName", "Monitor", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("start", "Starts", { required: false, editable: false }),
    f("end", "Ends", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("downtimeId", "Downtime ID")],
  dependsOn: [{ fieldKey: "monitorId", targetTypeId: "monitor", label: "silences" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "sliders",
});

/** `GET /api/v1/dashboard` (paged with `start` / `count`). */
export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description: "A Datadog dashboard. Open it in Datadog or delete it.",
  fields: [
    f("title", "Title", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("layoutType", "Layout", { required: false, editable: false }),
    f("author", "Author", { required: false, editable: false }),
    f("readOnly", "Read-Only", { kind: "boolean", required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("modifiedAt", "Modified", { required: false, editable: false }),
  ],
  outputs: [o("dashboardId", "Dashboard ID"), o("url", "Datadog URL")],
  supportsDelete: true,
  iconKey: "dashboard",
});

/** `GET /api/v1/slo` (paged with `limit` / `offset`). */
export const SloResourceType = rt({
  name: "SLO",
  plural: "SLOs",
  id: "slo",
  description:
    "A Datadog service level objective. Charts the SLI and the remaining error budget over the selected window.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("target", "Target (%)", { kind: "number", required: false, editable: false }),
    f("warning", "Warning (%)", { kind: "number", required: false, editable: false }),
    f("timeframe", "Timeframe", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("monitorIds", "Monitors", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("sloId", "SLO ID"), o("url", "Datadog URL")],
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "dashboard",
});

/** `GET /api/v1/synthetics/tests` (paged with `page_size` / `page_number`). */
export const SyntheticsTestResourceType = rt({
  name: "Synthetic Test",
  id: "synthetics-test",
  description:
    "A Datadog Synthetic Monitoring test: API, browser, mobile or network. Pause or resume it, run it now from every configured location, and chart response time and failures from recent results.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("subtype", "Subtype", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("target", "Target", { required: false, editable: false }),
    f("locations", "Locations", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    f("creator", "Created By", { required: false, editable: false }),
  ],
  outputs: [o("publicId", "Public ID"), o("url", "Datadog URL")],
  dependsOn: [{ fieldKey: "monitorId", targetTypeId: "monitor", label: "alerts via" }],
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "network",
});

/** `GET /api/v1/hosts` (paged with `start` / `count`). */
export const HostResourceType = rt({
  name: "Host",
  id: "host",
  description:
    "A host reporting to Datadog, usually through the Datadog Agent. Shows the Agent version, platform and integrations, mutes or unmutes it, and charts CPU, load, memory and network.",
  fields: [
    f("hostName", "Host Name", { editable: false }),
    f("up", "Up", { kind: "boolean", required: false, editable: false }),
    f("muted", "Muted", { kind: "boolean", required: false, editable: false }),
    f("agentVersion", "Agent Version", { required: false, editable: false }),
    f("platform", "Platform", { required: false, editable: false }),
    f("cpuCores", "CPU Cores", { kind: "number", required: false, editable: false }),
    f("cpu", "CPU (%)", { kind: "number", required: false, editable: false }),
    f("iowait", "I/O Wait (%)", { kind: "number", required: false, editable: false }),
    f("load", "Load (15m)", { kind: "number", required: false, editable: false }),
    f("apps", "Integrations", { required: false, editable: false }),
    f("sources", "Sources", { required: false, editable: false }),
    f("aliases", "Aliases", { required: false, editable: false }),
    f("lastReportedAt", "Last Reported", { required: false, editable: false }),
  ],
  outputs: [o("hostName", "Host Name")],
  supportsMetrics: true,
  iconKey: "server",
});

/** `GET /api/v2/users`. */
export const UserResourceType = rt({
  name: "User",
  id: "user",
  description:
    "A member of the Datadog organization, including service accounts. Shows roles, MFA and last login, and disables a user.",
  fields: [
    f("name", "Name", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("handle", "Handle", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("roles", "Roles", { required: false, editable: false }),
    f("title", "Title", { required: false, editable: false }),
    f("mfaEnabled", "MFA", { kind: "boolean", required: false, editable: false }),
    f("serviceAccount", "Service Account", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("disabled", "Disabled", { kind: "boolean", required: false, editable: false }),
    f("lastLoginAt", "Last Login", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  principalRole: {
    role: "user",
    lastUsedKey: "lastLoginAt",
    createdKey: "createdAt",
    adminIndicatorKey: "roles",
    adminValues: ["Datadog Admin Role"],
    mfaKey: "mfaEnabled",
    revokeActionId: "disable",
  },
  iconKey: "user",
});

/** `GET /api/v2/api_keys`. Metadata only: Datadog never returns the key again. */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "A Datadog API key: the organization-level credential Agents and integrations send data with. Listed by name, last four characters, creator and last use; the key itself is never shown again after creation.",
  fields: [
    f("name", "Name", { editable: false }),
    f("last4", "Last 4", { required: false, editable: false }),
    f("category", "Category", { required: false, editable: false }),
    f("remoteConfig", "Remote Configuration", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  expiryFields: [{ fieldKey: "createdAt", from: "created", kind: "api-token", label: "Key age" }],
  principalRole: { role: "key", lastUsedKey: "lastUsedAt", createdKey: "createdAt" },
  supportsDelete: true,
  iconKey: "key",
});

/** `GET /api/v2/application_keys`. Metadata only, including scopes. */
export const ApplicationKeyResourceType = rt({
  name: "Application Key",
  id: "application-key",
  description:
    "A Datadog application key: a user's or service account's credential for the API, optionally narrowed to scopes. Listed with owner, scopes and last use.",
  fields: [
    f("name", "Name", { editable: false }),
    f("last4", "Last 4", { required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  expiryFields: [{ fieldKey: "createdAt", from: "created", kind: "api-token", label: "Key age" }],
  principalRole: {
    role: "key",
    lastUsedKey: "lastUsedAt",
    createdKey: "createdAt",
    parentKey: "owner",
  },
  supportsDelete: true,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  MonitorResourceType,
  DowntimeResourceType,
  DashboardResourceType,
  SloResourceType,
  SyntheticsTestResourceType,
  HostResourceType,
  UserResourceType,
  ApiKeyResourceType,
  ApplicationKeyResourceType,
];
