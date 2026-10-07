import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Dynatrace resource types. Everything comes from the Environment API v2 with
 * the account's access token, except synthetic monitors (Environment API v1,
 * still the only CRUD surface for them) and DQL, which runs on the platform
 * (Grail) with the optional platform token.
 */

const MZ = f("managementZones", "Management Zones", { required: false, editable: false });
const TAGS = f("tags", "Tags", { required: false, editable: false });
const SEEN = [
  f("firstSeen", "First Seen", { required: false, editable: false }),
  f("lastSeen", "Last Seen", { required: false, editable: false }),
];

/** The environment itself: counts, version, the DQL editor and the bill. */
export const EnvironmentResourceType = rt({
  name: "Environment",
  id: "environment",
  description:
    "The Dynatrace environment the access token belongs to: its version, how many hosts, services and open problems it has, and this month's platform subscription cost. Run DQL against Grail from the Query tab when a platform token is set.",
  fields: [
    f("environmentId", "Environment ID", { editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("platformUrl", "Platform URL", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("hostCount", "Hosts", { kind: "number", required: false, editable: false }),
    f("serviceCount", "Services", { kind: "number", required: false, editable: false }),
    f("applicationCount", "Applications", { kind: "number", required: false, editable: false }),
    f("openProblems", "Open Problems", { kind: "number", required: false, editable: false }),
    f("grail", "DQL Available", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [
    o("url", "Environment URL"),
    o("platformUrl", "Platform URL"),
    o("environmentId", "Environment ID"),
  ],
  accountRoot: true,
  supportsRestQuery: true,
  iconKey: "account",
});

/** `GET /api/v2/entities?entitySelector=type("HOST")`. */
export const HostResourceType = rt({
  name: "Host",
  id: "host",
  description:
    "A host monitored by OneAgent: OS, size, monitoring mode and network addresses. Charts CPU, memory, disk and network, and reads its logs.",
  fields: [
    f("osType", "OS", { required: false, editable: false }),
    f("osVersion", "OS Version", { required: false, editable: false }),
    f("cpuCores", "CPU Cores", { kind: "number", required: false, editable: false }),
    f("memoryBytes", "Memory (bytes)", { kind: "number", required: false, editable: false }),
    f("monitoringMode", "Monitoring Mode", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("ipAddresses", "IP Addresses", { required: false, editable: false }),
    f("cloudType", "Cloud", { required: false, editable: false }),
    f("hostGroup", "Host Group", { required: false, editable: false }),
    f("oneAgentVersion", "OneAgent Version", { required: false, editable: false }),
    f("entityId", "Entity ID", { editable: false }),
    TAGS,
    MZ,
    ...SEEN,
  ],
  outputs: [o("entityId", "Entity ID")],
  supportsMetrics: true,
  iconKey: "server",
});

/** `GET /api/v2/entities?entitySelector=type("PROCESS_GROUP")`. */
export const ProcessGroupResourceType = rt({
  name: "Process Group",
  id: "process-group",
  description:
    "A group of processes Dynatrace treats as one workload (for example all JVMs of one app), with its technologies and the hosts it runs on.",
  fields: [
    f("technologies", "Technologies", { required: false, editable: false }),
    f("runsOn", "Hosts", { required: false, editable: false }),
    f("entityId", "Entity ID", { editable: false }),
    TAGS,
    MZ,
    ...SEEN,
  ],
  outputs: [o("entityId", "Entity ID")],
  dependsOn: [
    { fieldKey: "runsOn", targetTypeId: "host", matchTemplate: "{runsOn}", label: "runs on" },
  ],
  iconKey: "layers",
});

/** `GET /api/v2/entities?entitySelector=type("SERVICE")`. */
export const ServiceResourceType = rt({
  name: "Service",
  id: "service",
  description:
    "A service Dynatrace detected from traces: web requests, databases, queues. Charts response time, request rate and failure rate, and reads its logs.",
  fields: [
    f("serviceType", "Service Type", { required: false, editable: false }),
    f("technology", "Technology", { required: false, editable: false }),
    f("webServer", "Web Server", { required: false, editable: false }),
    f("runsOn", "Process Groups", { required: false, editable: false }),
    f("entityId", "Entity ID", { editable: false }),
    TAGS,
    MZ,
    ...SEEN,
  ],
  outputs: [o("entityId", "Entity ID")],
  dependsOn: [
    {
      fieldKey: "runsOn",
      targetTypeId: "process-group",
      matchTemplate: "{runsOn}",
      label: "runs on",
    },
  ],
  supportsMetrics: true,
  iconKey: "function",
});

/** `GET /api/v2/entities?entitySelector=type("APPLICATION")`. */
export const ApplicationResourceType = rt({
  name: "Web Application",
  id: "application",
  description:
    "A web application monitored with Real User Monitoring. Charts user actions, errors and Apdex.",
  fields: [
    f("applicationType", "Application Type", { required: false, editable: false }),
    f("entityId", "Entity ID", { editable: false }),
    TAGS,
    MZ,
    ...SEEN,
  ],
  outputs: [o("entityId", "Entity ID")],
  supportsMetrics: true,
  iconKey: "globe",
});

/** `GET /api/v2/entities?entitySelector=type("KUBERNETES_CLUSTER")`. */
export const KubernetesClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "kubernetes-cluster",
  description: "A Kubernetes cluster monitored by the Dynatrace Operator.",
  fields: [
    f("distribution", "Distribution", { required: false, editable: false }),
    f("kubernetesVersion", "Kubernetes Version", { required: false, editable: false }),
    f("cloudType", "Cloud", { required: false, editable: false }),
    f("entityId", "Entity ID", { editable: false }),
    TAGS,
    MZ,
    ...SEEN,
  ],
  outputs: [o("entityId", "Entity ID")],
  iconKey: "kubernetes",
});

/** `GET /api/v2/problems`. */
export const ProblemResourceType = rt({
  name: "Problem",
  id: "problem",
  description:
    "A problem Davis raised in the last seven days: what broke, what it affects and its root cause. Comment on it or close it.",
  fields: [
    f("displayId", "Problem", { editable: false }),
    f("title", "Title", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("severityLevel", "Severity", { required: false, editable: false }),
    f("impactLevel", "Impact", { required: false, editable: false }),
    f("rootCause", "Root Cause", { required: false, editable: false }),
    f("rootCauseEntityId", "Root Cause Entity", { required: false, editable: false }),
    f("affectedEntities", "Affected", { required: false, editable: false }),
    f("affectedEntityIds", "Affected Entity IDs", { required: false, editable: false }),
    f("startTime", "Started", { required: false, editable: false }),
    f("endTime", "Ended", { required: false, editable: false }),
    MZ,
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "rootCauseEntityId", label: "root cause" },
    { fieldKey: "affectedEntityIds", matchTemplate: "{affectedEntityIds}", label: "affects" },
  ],
  pinnable: false,
  iconKey: "alert",
});

/** `GET /api/v2/slo`. */
export const SloResourceType = rt({
  name: "Service-Level Objective",
  id: "slo",
  description:
    "A service-level objective: a metric expression evaluated over a timeframe against a target. Create, edit, turn off and on, or delete it, and see its status and error budget.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("metricExpression", "Metric Expression", {
      description:
        "A metric expression that yields a percentage, for example 100*(builtin:service.errors.server.successCount:splitBy())/(builtin:service.requestCount.server:splitBy()).",
    }),
    f("filter", "Entity Filter", {
      required: false,
      description: 'An entity selector limiting the SLO, for example type("SERVICE"),tag("prod").',
    }),
    f("target", "Target (%)", { kind: "number" }),
    f("warning", "Warning (%)", { kind: "number" }),
    f("timeframe", "Timeframe", {
      description: "Evaluation window, for example -1d, -1w or -30d.",
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("evaluatedPercentage", "Current (%)", { kind: "number", required: false, editable: false }),
    f("errorBudget", "Error Budget Left", { kind: "number", required: false, editable: false }),
    f("relatedOpenProblems", "Open Problems", { kind: "number", required: false, editable: false }),
    f("metricName", "Metric Name", { required: false, editable: false }),
    f("evaluationType", "Evaluation", { required: false, editable: false }),
  ],
  outputs: [o("sloId", "SLO ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "target",
});

/** `GET /api/v1/synthetic/monitors`. */
export const SyntheticMonitorResourceType = rt({
  name: "Synthetic Monitor",
  id: "synthetic-monitor",
  description:
    "An HTTP or browser monitor run from Dynatrace synthetic locations. Create HTTP monitors, turn monitors off and on, delete them, and chart availability.",
  fields: [
    f("type", "Type", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("frequencyMin", "Frequency (min)", { kind: "number", required: false, editable: false }),
    f("url", "URL", { required: false, editable: false }),
    f("locations", "Locations", { required: false, editable: false }),
    f("locationCount", "Location Count", { kind: "number", required: false, editable: false }),
    f("entityId", "Entity ID", { editable: false }),
    TAGS,
  ],
  outputs: [o("entityId", "Entity ID")],
  supportsCreate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "search",
});

/** Settings 2.0, schema `builtin:alerting.profile`. */
export const AlertingProfileResourceType = rt({
  name: "Alerting Profile",
  id: "alerting-profile",
  description:
    "Which problems reach your notification integrations, and after how long. Set a delay per severity; a blank delay leaves that severity out of the profile.",
  fields: [
    f("name", "Name"),
    ...(
      [
        ["delayAvailability", "Availability"],
        ["delayErrors", "Errors"],
        ["delaySlowdown", "Slowdown"],
        ["delayResource", "Resource"],
        ["delayCustom", "Custom Alert"],
        ["delayMonitoring", "Monitoring Unavailable"],
      ] as const
    ).map(([key, label]) =>
      f(key, `${label} Delay (min)`, {
        kind: "number",
        required: false,
        description: `Notify about ${label.toLowerCase()} problems once they have been open this many minutes (0 to 10000). Blank leaves them out of the profile.`,
      }),
    ),
    f("ruleCount", "Severity Rules", { kind: "number", required: false, editable: false }),
    f("eventFilterCount", "Event Filters", { kind: "number", required: false, editable: false }),
    f("rulesJson", "Rules (JSON)", { required: false, editable: false }),
    f("managementZone", "Management Zone", { required: false, editable: false }),
    f("objectId", "Object ID", { editable: false }),
  ],
  outputs: [o("objectId", "Settings Object ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "bell",
});

/** Settings 2.0, schema `builtin:alerting.maintenance-window`. */
export const MaintenanceWindowResourceType = rt({
  name: "Maintenance Window",
  id: "maintenance-window",
  description:
    "A period when Dynatrace suppresses alerting or problem detection, once or on a daily, weekly or monthly schedule. Create, edit, turn off and on, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("maintenanceType", "Type", { kind: "enum", enumValues: ["PLANNED", "UNPLANNED"] }),
    f("suppression", "Suppression", {
      kind: "enum",
      enumValues: [
        "DETECT_PROBLEMS_AND_ALERT",
        "DETECT_PROBLEMS_DONT_ALERT",
        "DONT_DETECT_PROBLEMS",
      ],
      description:
        "Keep alerting, detect problems without alerting, or stop problem detection altogether.",
    }),
    f("disableSynthetic", "Pause Synthetic Monitors", { kind: "boolean", required: false }),
    f("scheduleType", "Schedule", { required: false, editable: false }),
    f("schedule", "When", { required: false, editable: false }),
    f("filters", "Scope", { required: false, editable: false }),
    f("objectId", "Object ID", { editable: false }),
  ],
  outputs: [o("objectId", "Settings Object ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "calendar",
});

/** `GET /api/v2/apiTokens`. */
export const ApiTokenResourceType = rt({
  name: "Access Token",
  id: "api-token",
  description:
    "An access token for this environment. Dynatrace only shows the secret once, so this is metadata: owner, scopes, expiry and last use. Rename it, turn it off and on, or revoke it.",
  fields: [
    f("name", "Name"),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("personalAccessToken", "Personal", { kind: "boolean", required: false, editable: false }),
    f("expirationDate", "Expires", { required: false, editable: false }),
    f("lastUsedDate", "Last Used", { required: false, editable: false }),
    f("lastUsedIpAddress", "Last Used From", { required: false, editable: false }),
    f("creationDate", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  expiryFields: [
    { fieldKey: "expirationDate", from: "expiry", kind: "api-token", label: "Token expires" },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  EnvironmentResourceType,
  HostResourceType,
  ProcessGroupResourceType,
  ServiceResourceType,
  ApplicationResourceType,
  KubernetesClusterResourceType,
  ProblemResourceType,
  SloResourceType,
  SyntheticMonitorResourceType,
  AlertingProfileResourceType,
  MaintenanceWindowResourceType,
  ApiTokenResourceType,
];

/** Entity types listed through `/api/v2/entities`, keyed by resource type id. */
export const ENTITY_TYPES: Record<string, string> = {
  host: "HOST",
  "process-group": "PROCESS_GROUP",
  service: "SERVICE",
  application: "APPLICATION",
  "kubernetes-cluster": "KUBERNETES_CLUSTER",
};

/** Settings 2.0 schema behind each settings-backed resource type. */
export const SETTINGS_SCHEMAS: Record<string, string> = {
  "alerting-profile": "builtin:alerting.profile",
  "maintenance-window": "builtin:alerting.maintenance-window",
};
