import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * New Relic resource types. Entity types come from NerdGraph `entitySearch`
 * (cross-account, every account the key can see); alert policies and NRQL
 * conditions from `actor.account(id).alerts`, one account at a time. Field
 * names follow the NerdGraph outlines verified against newrelic-client-go's
 * generated queries (2026-10).
 */

const accountFields = [
  f("accountName", "Account", { required: false, editable: false }),
  f("nrAccountId", "Account ID", { required: false, editable: false }),
];

const entityFields = [
  f("guid", "Entity GUID", { required: false, editable: false }),
  f("reporting", "Reporting", { kind: "boolean", required: false, editable: false }),
  f("alertSeverity", "Alert Status", { required: false, editable: false }),
  f("tags", "Tags", { required: false, editable: false }),
];

export const AccountResourceType = rt({
  name: "Account",
  id: "account",
  description:
    "A New Relic account the user key can access. The usage account shows month-to-date data ingest, users, compute and synthetic checks with an estimated cost, and charts daily usage.",
  fields: [
    f("name", "Name", { editable: false }),
    f("nrAccountId", "Account ID", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("usageAccount", "Usage Account", { kind: "boolean", required: false, editable: false }),
    f("monthToDate", "Estimated Month-to-Date Cost (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("nrAccountId", "Account ID")],
  supportsMetrics: true,
  iconKey: "account",
});

export const ApmApplicationResourceType = rt({
  name: "APM Application",
  id: "apm-application",
  description:
    "A service instrumented with a New Relic APM agent. Shows Apdex, response time, throughput and error rate, and charts them from transaction data.",
  fields: [
    f("name", "Name", { editable: false }),
    f("language", "Language", { required: false, editable: false }),
    f("apdex", "Apdex", { kind: "number", required: false, editable: false }),
    f("responseTimeMs", "Response Time (ms)", { kind: "number", required: false, editable: false }),
    f("throughput", "Throughput (rpm)", { kind: "number", required: false, editable: false }),
    f("errorRate", "Error Rate (%)", { kind: "number", required: false, editable: false }),
    f("hostCount", "Hosts", { kind: "number", required: false, editable: false }),
    f("instanceCount", "Instances", { kind: "number", required: false, editable: false }),
    f("agentVersion", "Agent Version", { required: false, editable: false }),
    f("applicationId", "Application ID", { required: false, editable: false }),
    ...accountFields,
    ...entityFields,
  ],
  outputs: [o("guid", "Entity GUID"), o("url", "New Relic URL")],
  supportsMetrics: true,
  iconKey: "app",
});

export const BrowserApplicationResourceType = rt({
  name: "Browser Application",
  id: "browser-application",
  description:
    "A website or single-page app monitored with the New Relic browser agent. Shows page load time, page views and JavaScript error rate, and charts them from page view data.",
  fields: [
    f("name", "Name", { editable: false }),
    f("pageLoadTime", "Page Load Time (s)", { kind: "number", required: false, editable: false }),
    f("pageViews", "Page Views (ppm)", { kind: "number", required: false, editable: false }),
    f("jsErrorRate", "JS Error Rate (%)", { kind: "number", required: false, editable: false }),
    f("agentInstallType", "Agent Install", { required: false, editable: false }),
    f("applicationId", "Application ID", { required: false, editable: false }),
    ...accountFields,
    ...entityFields,
  ],
  outputs: [o("guid", "Entity GUID"), o("url", "New Relic URL")],
  supportsMetrics: true,
  iconKey: "app",
});

export const HostResourceType = rt({
  name: "Host",
  id: "host",
  description:
    "A host reporting through the New Relic infrastructure agent. Shows CPU, memory and disk use, and charts them with network traffic.",
  fields: [
    f("name", "Name", { editable: false }),
    f("cpuPercent", "CPU (%)", { kind: "number", required: false, editable: false }),
    f("memoryPercent", "Memory (%)", { kind: "number", required: false, editable: false }),
    f("diskPercent", "Disk (%)", { kind: "number", required: false, editable: false }),
    f("servicesCount", "Services", { kind: "number", required: false, editable: false }),
    ...accountFields,
    ...entityFields,
  ],
  outputs: [o("guid", "Entity GUID"), o("url", "New Relic URL")],
  supportsMetrics: true,
  iconKey: "server",
});

export const SyntheticMonitorResourceType = rt({
  name: "Synthetic Monitor",
  id: "synthetic-monitor",
  description:
    "A New Relic synthetic monitor: ping, browser, scripted, step, certificate or broken-links check. Enable or disable it, change how often it runs, and chart duration and failures.",
  fields: [
    f("name", "Name"),
    f("period", "Frequency", {
      kind: "enum",
      required: false,
      enumValues: [
        "EVERY_MINUTE",
        "EVERY_5_MINUTES",
        "EVERY_10_MINUTES",
        "EVERY_15_MINUTES",
        "EVERY_30_MINUTES",
        "EVERY_HOUR",
        "EVERY_6_HOURS",
        "EVERY_12_HOURS",
        "EVERY_DAY",
      ],
      description: "How often the monitor runs from each location.",
    }),
    f("monitorType", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("monitoredUrl", "URL", { required: false, editable: false }),
    f("successRate", "Success Rate (%)", { kind: "number", required: false, editable: false }),
    f("locationsRunning", "Locations Running", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("locationsFailing", "Locations Failing", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("monitorId", "Monitor ID", { required: false, editable: false }),
    ...accountFields,
    ...entityFields,
  ],
  outputs: [o("guid", "Entity GUID"), o("monitorId", "Monitor ID"), o("url", "New Relic URL")],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "network",
});

export const DashboardResourceType = rt({
  name: "Dashboard",
  id: "dashboard",
  description: "A New Relic dashboard. Open it in New Relic or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("permissions", "Permissions", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    ...accountFields,
    ...entityFields,
  ],
  outputs: [o("guid", "Entity GUID"), o("url", "New Relic URL")],
  supportsDelete: true,
  iconKey: "dashboard",
});

export const WorkloadResourceType = rt({
  name: "Workload",
  id: "workload",
  description:
    "A New Relic workload: a group of entities whose health is rolled up into one status. Shows the status and its source, or deletes the workload.",
  fields: [
    f("name", "Name", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("statusSource", "Status Source", { required: false, editable: false }),
    f("statusSummary", "Summary", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    ...accountFields,
    ...entityFields,
  ],
  outputs: [o("guid", "Entity GUID"), o("url", "New Relic URL")],
  supportsDelete: true,
  iconKey: "layers",
});

export const AlertPolicyResourceType = rt({
  name: "Alert Policy",
  plural: "Alert Policies",
  id: "alert-policy",
  description:
    "A New Relic alert policy: a group of conditions and how their violations roll up into incidents. Create one in any account, rename it, change its incident preference, or delete it.",
  fields: [
    f("name", "Name"),
    f("incidentPreference", "Incident Preference", {
      kind: "enum",
      enumValues: ["PER_POLICY", "PER_CONDITION", "PER_CONDITION_AND_TARGET"],
      description:
        "PER_POLICY opens one incident for the whole policy, PER_CONDITION one per condition, PER_CONDITION_AND_TARGET one per condition and entity.",
    }),
    f("policyId", "Policy ID", { required: false, editable: false }),
    ...accountFields,
  ],
  outputs: [o("policyId", "Policy ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const AlertConditionResourceType = rt({
  name: "Alert Condition",
  id: "alert-condition",
  description:
    "A New Relic NRQL alert condition. Rename it, edit its description and runbook link, enable or disable it, delete it, and chart the query it evaluates.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("runbookUrl", "Runbook URL", { required: false }),
    f("enabled", "Enabled", { kind: "boolean", required: false, editable: false }),
    f("conditionType", "Type", { required: false, editable: false }),
    f("query", "NRQL Query", { required: false, editable: false }),
    f("thresholds", "Thresholds", { required: false, editable: false }),
    f("policyName", "Policy", { required: false, editable: false }),
    f("policyId", "Policy ID", { required: false, editable: false }),
    f("conditionId", "Condition ID", { required: false, editable: false }),
    ...accountFields,
  ],
  outputs: [o("conditionId", "Condition ID")],
  dependsOn: [
    {
      fieldKey: "policyId",
      matchTemplate: "{nrAccountId}:{policyId}",
      targetTypeId: "alert-policy",
      label: "belongs to",
    },
  ],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "search",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  ApmApplicationResourceType,
  BrowserApplicationResourceType,
  HostResourceType,
  SyntheticMonitorResourceType,
  DashboardResourceType,
  WorkloadResourceType,
  AlertPolicyResourceType,
  AlertConditionResourceType,
];
