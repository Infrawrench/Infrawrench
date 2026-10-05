import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Grafana Cloud resource types. Org-level types come from the Cloud API with
 * the account's access policy token; the stack-level types (dashboards, alert
 * rules, contact points, data sources, synthetic checks) come from each
 * stack's own APIs and only list for stacks that have been connected (see
 * the Stack type's description).
 */

/** `GET /api/orgs/{slug}`, plus the current month from billed usage. */
export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description:
    "The Grafana Cloud organization the access policy token belongs to: its plan and this month's bill by product and by stack. The Metrics tab charts the monthly bill by product.",
  fields: [
    f("name", "Name", { editable: false }),
    f("slug", "Slug", { editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("trial", "Trial", { kind: "boolean", required: false, editable: false }),
    f("trialEndsAt", "Trial Ends", { required: false, editable: false }),
    f("contractType", "Contract", { required: false, editable: false }),
    f("monthToDate", "Billed This Month (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("stackCount", "Stacks", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("slug", "Organization Slug"), o("orgId", "Organization ID")],
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /api/orgs/{slug}/instances`. */
export const StackResourceType = rt({
  name: "Stack",
  id: "stack",
  description:
    "A Grafana Cloud stack: a hosted Grafana with metrics, logs, traces and profiles backends in one region. Create, rename, relabel, restart or delete it, and chart active series, ingest and discarded samples. Connect it with a service account token to list dashboards, alert rules, contact points and data sources; add a Synthetic Monitoring token to list checks.",
  fields: [
    f("name", "Name", { description: "Display name of the stack." }),
    f("description", "Description", { required: false }),
    f("labels", "Labels", {
      required: false,
      description:
        "Comma-separated key=value pairs, for example team=platform, env=prod. Up to 10.",
    }),
    f("deleteProtection", "Delete Protection", {
      kind: "boolean",
      required: false,
      description: "While on, the stack cannot be deleted.",
    }),
    f("serviceAccountToken", "Service Account Token", {
      kind: "password",
      required: false,
      description:
        "A service account token (glsa_…) from this stack's Administration, Service accounts page. Lets Infrawrench list the stack's dashboards, alert rules, contact points and data sources. Admin role for everything, Viewer for dashboards and data sources only. Or use Connect stack to create one.",
    }),
    f("syntheticMonitoringToken", "Synthetic Monitoring Access Token", {
      kind: "password",
      required: false,
      description:
        "An access token from this stack's Testing & synthetics, Synthetics, Config page. Lets Infrawrench list and toggle the stack's synthetic checks.",
    }),
    f("slug", "Slug", { editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("regionName", "Region Name", { required: false, editable: false }),
    f("provider", "Cloud Provider", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("version", "Grafana Version", { required: false, editable: false }),
    f("dashboards", "Dashboards", { kind: "number", required: false, editable: false }),
    f("alerts", "Alerts", { kind: "number", required: false, editable: false }),
    f("activeUsers", "Active Users", { kind: "number", required: false, editable: false }),
    f("activeSeries", "Active Series", { kind: "number", required: false, editable: false }),
    f("logsUsage", "Logs Usage (GB)", { kind: "number", required: false, editable: false }),
    f("tracesUsage", "Traces Usage (GB)", { kind: "number", required: false, editable: false }),
    f("profilesUsage", "Profiles Usage (GB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("connected", "Connected", { kind: "boolean", required: false, editable: false }),
    f("stackId", "Stack ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("url", "Grafana URL"),
    o("prometheusUrl", "Prometheus URL"),
    o("prometheusUser", "Prometheus User ID"),
    o("lokiUrl", "Loki URL"),
    o("lokiUser", "Loki User ID"),
    o("tempoUrl", "Tempo URL"),
    o("tempoUser", "Tempo User ID"),
    o("pyroscopeUrl", "Pyroscope URL"),
    o("alertmanagerUrl", "Alertmanager URL"),
    o("stackId", "Stack ID"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "server",
});

/** `GET /api/instances/{stack}/plugins`. */
export const StackPluginResourceType = rt({
  name: "Installed Plugin",
  id: "stack-plugin",
  description:
    "A plugin installed on a stack from the Grafana catalog. Update it to the latest version or uninstall it.",
  fields: [
    f("pluginName", "Plugin", { editable: false }),
    f("pluginSlug", "Plugin ID", { editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("latestVersion", "Latest Version", { required: false, editable: false }),
    f("updateAvailable", "Update Available", { kind: "boolean", required: false, editable: false }),
    f("stack", "Stack", { editable: false }),
    f("installedAt", "Installed", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "stack",
  showInSidebar: true,
  dependsOn: [{ fieldKey: "stack", targetTypeId: "stack", label: "installed on" }],
  supportsDelete: true,
  iconKey: "layers",
});

/** `GET /api/v1/accesspolicies?region=`, fanned out over the org's regions. */
export const AccessPolicyResourceType = rt({
  name: "Access Policy",
  plural: "Access Policies",
  id: "access-policy",
  description:
    "A Grafana Cloud access policy: a named set of scopes on the org or on particular stacks, which tokens are minted from. Rename it, turn it off and on, or delete it with its tokens.",
  fields: [
    f("displayName", "Display Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "inactive"],
      required: false,
      description: "An inactive policy's tokens are rejected until it is turned back on.",
    }),
    f("name", "Name", { editable: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("realms", "Applies To", { required: false, editable: false }),
    f("allowedSubnets", "Allowed Subnets", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("policyId", "Policy ID")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

/** `GET /api/v1/tokens?region=`. */
export const AccessPolicyTokenResourceType = rt({
  name: "Access Policy Token",
  id: "access-policy-token",
  description:
    "A token minted from an access policy. Grafana only shows the secret once, so this is metadata: expiry, first and last use. Rename it or revoke it.",
  fields: [
    f("displayName", "Display Name"),
    f("name", "Name", { editable: false }),
    f("policyName", "Access Policy", { required: false, editable: false }),
    f("policyId", "Access Policy ID", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("firstUsedAt", "First Used", { required: false, editable: false }),
    f("lastUsedAt", "Last Used", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "policyId", targetTypeId: "access-policy", label: "minted from" }],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Token expires" },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "secret",
});

/** `GET /api/orgs/{slug}/members`. */
export const MemberResourceType = rt({
  name: "Member",
  id: "member",
  description: "A member of the Grafana Cloud organization. Change their org role or remove them.",
  fields: [
    f("role", "Role", {
      kind: "enum",
      enumValues: ["Admin", "Editor", "Viewer", "None"],
      description: "Org role on grafana.com. Stack roles are managed inside each stack.",
    }),
    f("name", "Name", { required: false, editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("username", "Username", { required: false, editable: false }),
    f("mfaEnabled", "MFA", { kind: "boolean", required: false, editable: false }),
    f("joinedAt", "Joined", { required: false, editable: false }),
  ],
  outputs: [],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

const STACK_FIELD = f("stack", "Stack", { editable: false });
const STACK_DEPENDENCY = { fieldKey: "stack", targetTypeId: "stack", label: "in" };

/** Stack `GET /api/search?type=dash-db`. */
export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description: "A dashboard on a connected stack. Open it in Grafana or delete it.",
  fields: [
    f("title", "Title", { editable: false }),
    f("folder", "Folder", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("starred", "Starred", { kind: "boolean", required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("uid", "UID", { required: false, editable: false }),
    STACK_FIELD,
  ],
  outputs: [o("url", "Dashboard URL")],
  parentTypeId: "stack",
  showInSidebar: true,
  dependsOn: [STACK_DEPENDENCY],
  supportsDelete: true,
  iconKey: "dashboard",
});

/** Stack `GET /api/v1/provisioning/alert-rules`. */
export const AlertRuleResourceType = rt({
  name: "Alert Rule",
  id: "alert-rule",
  description:
    "A Grafana-managed alert rule on a connected stack. Pause and resume it, or delete it.",
  fields: [
    f("title", "Title", { editable: false }),
    f("folder", "Folder", { required: false, editable: false }),
    f("ruleGroup", "Evaluation Group", { required: false, editable: false }),
    f("paused", "Paused", { kind: "boolean", required: false, editable: false }),
    f("pendingPeriod", "Pending Period", { required: false, editable: false }),
    f("noDataState", "No Data State", { required: false, editable: false }),
    f("execErrState", "Error State", { required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("summary", "Summary", { required: false, editable: false }),
    f("provenance", "Provisioned By", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("uid", "UID", { required: false, editable: false }),
    STACK_FIELD,
  ],
  outputs: [],
  parentTypeId: "stack",
  showInSidebar: true,
  dependsOn: [STACK_DEPENDENCY],
  supportsDelete: true,
  iconKey: "search",
});

/** Stack `GET /api/v1/provisioning/contact-points`. */
export const ContactPointResourceType = rt({
  name: "Contact Point",
  id: "contact-point",
  description:
    "Where a connected stack's alert notifications go: an integration such as email, Slack, PagerDuty or a webhook. One row per integration.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Integration", { required: false, editable: false }),
    f("disableResolveMessage", "Resolved Messages Off", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("provenance", "Provisioned By", { required: false, editable: false }),
    f("uid", "UID", { required: false, editable: false }),
    STACK_FIELD,
  ],
  outputs: [],
  parentTypeId: "stack",
  showInSidebar: true,
  dependsOn: [STACK_DEPENDENCY],
  supportsDelete: true,
  iconKey: "webhook",
});

/** Stack `GET /api/datasources`. */
export const DatasourceResourceType = rt({
  name: "Data Source",
  id: "datasource",
  description:
    "A data source configured on a connected stack. Test its connection, open it in Grafana, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("access", "Access", { required: false, editable: false }),
    f("isDefault", "Default", { kind: "boolean", required: false, editable: false }),
    f("readOnly", "Read-Only", { kind: "boolean", required: false, editable: false }),
    f("grafanaUrl", "Grafana URL", { required: false, editable: false }),
    f("uid", "UID", { required: false, editable: false }),
    STACK_FIELD,
  ],
  outputs: [],
  parentTypeId: "stack",
  showInSidebar: true,
  dependsOn: [STACK_DEPENDENCY],
  supportsDelete: true,
  iconKey: "database",
});

/** Synthetic Monitoring `GET /api/v1/check`. */
export const SyntheticCheckResourceType = rt({
  name: "Synthetic Check",
  id: "synthetic-check",
  description:
    "A Synthetic Monitoring check on a stack that has a Synthetic Monitoring access token. Turn it off and on, or delete it.",
  fields: [
    f("job", "Job", { editable: false }),
    f("target", "Target", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("frequencySeconds", "Frequency (s)", { kind: "number", required: false, editable: false }),
    f("timeoutSeconds", "Timeout (s)", { kind: "number", required: false, editable: false }),
    f("probes", "Probes", { required: false, editable: false }),
    f("labels", "Labels", { required: false, editable: false }),
    f("checkId", "Check ID", { required: false, editable: false }),
    STACK_FIELD,
  ],
  outputs: [],
  parentTypeId: "stack",
  showInSidebar: true,
  dependsOn: [STACK_DEPENDENCY],
  supportsDelete: true,
  iconKey: "search",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  OrganizationResourceType,
  StackResourceType,
  StackPluginResourceType,
  AccessPolicyResourceType,
  AccessPolicyTokenResourceType,
  MemberResourceType,
  DashboardResourceType,
  AlertRuleResourceType,
  ContactPointResourceType,
  DatasourceResourceType,
  SyntheticCheckResourceType,
];

/** Types read through a stack's own APIs rather than the Cloud API. */
export const STACK_SCOPED_TYPES = new Set([
  "dashboard",
  "alert-rule",
  "contact-point",
  "datasource",
  "synthetic-check",
]);
