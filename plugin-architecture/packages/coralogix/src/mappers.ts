/**
 * Coralogix API response shapes (the fields this plugin reads; verified
 * against the published OpenAPI document `/mgmt/openapi/5/openapi.yaml`,
 * 2026-10) and their mapping to `ResourceInstance`s.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "coralogix";

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

const join = (v: Array<string | number> | undefined | null): string =>
  (v ?? []).map(String).filter(Boolean).join(", ");

/** "ALERT_DEF_TYPE_LOGS_THRESHOLD" → "Logs threshold", given the prefix to drop. */
export function humanEnum(value: string | undefined, prefix: string): string {
  if (!value) return "";
  const rest = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const words = rest
    .replace(/_OR_UNSPECIFIED$/, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
  if (words.length === 0) return "";
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Alerts: GET /alerts/alerts/v3
// ---------------------------------------------------------------------------

export type AlertPriority =
  | "ALERT_DEF_PRIORITY_P5_OR_UNSPECIFIED"
  | "ALERT_DEF_PRIORITY_P4"
  | "ALERT_DEF_PRIORITY_P3"
  | "ALERT_DEF_PRIORITY_P2"
  | "ALERT_DEF_PRIORITY_P1";

export interface CxAlertDefProperties {
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: AlertPriority;
  type?: string;
  groupByKeys?: string[];
  entityLabels?: Record<string, string>;
  phantomMode?: boolean;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface CxAlertDef {
  id?: string;
  alertVersionId?: string;
  alertDefProperties?: CxAlertDefProperties;
  status?: string;
  createdTime?: string;
  updatedTime?: string;
  lastTriggeredTime?: string;
}

/** P1..P5 in the UI; the API spells P5 as "P5 or unspecified". */
export function alertPriorityLabel(p: string | undefined): string {
  const m = /P([1-5])/.exec(p ?? "");
  return m ? `P${m[1]}` : "P5";
}

export function alertPriorityValue(label: string): AlertPriority {
  switch (label.trim().toUpperCase()) {
    case "P1":
      return "ALERT_DEF_PRIORITY_P1";
    case "P2":
      return "ALERT_DEF_PRIORITY_P2";
    case "P3":
      return "ALERT_DEF_PRIORITY_P3";
    case "P4":
      return "ALERT_DEF_PRIORITY_P4";
    default:
      return "ALERT_DEF_PRIORITY_P5_OR_UNSPECIFIED";
  }
}

export function alertStatusLabel(s: string | undefined): string {
  switch (s) {
    case "ALERT_DEF_STATUS_ALERTING":
      return "Alerting";
    case "ALERT_DEF_STATUS_OK":
      return "OK";
    case "ALERT_DEF_STATUS_NO_DATA":
      return "No data";
    default:
      return "";
  }
}

export function mapAlert(accountId: string, a: CxAlertDef): ResourceInstance {
  const id = a.id ?? "";
  const p = a.alertDefProperties ?? {};
  const labels = Object.entries(p.entityLabels ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  return instance(
    accountId,
    "alert",
    id,
    p.name ?? id,
    {
      name: p.name ?? "",
      description: p.description ?? "",
      priority: alertPriorityLabel(p.priority),
      enabled: p.enabled !== false,
      type: humanEnum(p.type, "ALERT_DEF_TYPE_"),
      status: alertStatusLabel(a.status),
      groupBy: join(p.groupByKeys),
      labels,
      lastTriggeredAt: a.lastTriggeredTime,
      createdAt: a.createdTime,
      updatedAt: a.updatedTime,
      alertVersionId: a.alertVersionId,
    },
    { alertId: id, alertVersionId: a.alertVersionId },
  );
}

// ---------------------------------------------------------------------------
// Dashboards: GET /dashboards/dashboards/v1/catalog/list
// ---------------------------------------------------------------------------

export interface CxDashboardCatalogItem {
  id?: string;
  name?: string;
  description?: string;
  slugName?: string;
  authorId?: string;
  createTime?: string;
  updateTime?: string;
  isDefault?: boolean;
  isPinned?: boolean;
  isLocked?: boolean;
  folder?: { id?: string; name?: string; parentId?: string };
}

export function mapDashboard(accountId: string, d: CxDashboardCatalogItem): ResourceInstance {
  const id = d.id ?? "";
  return instance(
    accountId,
    "dashboard",
    id,
    d.name ?? id,
    {
      name: d.name ?? "",
      description: d.description ?? "",
      folder: d.folder?.name,
      pinned: d.isPinned === true,
      isDefault: d.isDefault === true,
      locked: d.isLocked === true,
      slug: d.slugName,
      createdAt: d.createTime,
      updatedAt: d.updateTime,
    },
    { dashboardId: id },
  );
}

// ---------------------------------------------------------------------------
// TCO policies: GET /dataplans/policies/v1
// ---------------------------------------------------------------------------

export type PolicyPriority =
  | "PRIORITY_TYPE_UNSPECIFIED"
  | "PRIORITY_TYPE_BLOCK"
  | "PRIORITY_TYPE_LOW"
  | "PRIORITY_TYPE_MEDIUM"
  | "PRIORITY_TYPE_HIGH";

export interface CxRule {
  name?: string;
  ruleTypeId?: string;
}

export interface CxPolicy {
  id?: string;
  /** The team id, which Coralogix's API calls the company id. */
  companyId?: number | string;
  name?: string;
  description?: string;
  enabled?: boolean;
  deleted?: boolean;
  order?: number;
  priority?: PolicyPriority;
  applicationRule?: CxRule;
  subsystemRule?: CxRule;
  archiveRetention?: { id?: string };
  logRules?: { severities?: string[]; dpxlExpression?: string };
  spanRules?: {
    serviceRule?: CxRule;
    actionRule?: CxRule;
    tagRules?: Array<{ tagName?: string; tagValue?: string; ruleTypeId?: string }>;
    dpxlExpression?: string;
  };
  rumRules?: { severities?: string[]; dpxlExpression?: string };
  priorityOverride?: unknown;
  priorityOverrideStatus?: {
    quotaBased?: { currentPriority?: PolicyPriority; currentUsage?: number; dailyLimit?: number };
  };
  targets?: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

/** The TCO Optimizer's names for each priority. */
export const POLICY_PRIORITY_LABELS: Record<string, string> = {
  PRIORITY_TYPE_HIGH: "High (Frequent Search)",
  PRIORITY_TYPE_MEDIUM: "Medium (Monitoring)",
  PRIORITY_TYPE_LOW: "Low (Compliance)",
  PRIORITY_TYPE_BLOCK: "Block",
};

export const POLICY_PRIORITY_CHOICES = ["High", "Medium", "Low", "Block"] as const;

export function policyPriorityChoice(p: string | undefined): string {
  switch (p) {
    case "PRIORITY_TYPE_HIGH":
      return "High";
    case "PRIORITY_TYPE_MEDIUM":
      return "Medium";
    case "PRIORITY_TYPE_LOW":
      return "Low";
    case "PRIORITY_TYPE_BLOCK":
      return "Block";
    default:
      return "";
  }
}

export function policyPriorityValue(choice: string): PolicyPriority | undefined {
  switch (choice.trim().toLowerCase()) {
    case "high":
      return "PRIORITY_TYPE_HIGH";
    case "medium":
      return "PRIORITY_TYPE_MEDIUM";
    case "low":
      return "PRIORITY_TYPE_LOW";
    case "block":
      return "PRIORITY_TYPE_BLOCK";
    default:
      return undefined;
  }
}

const RULE_VERBS: Record<string, string> = {
  RULE_TYPE_ID_IS: "is",
  RULE_TYPE_ID_IS_NOT: "is not",
  RULE_TYPE_ID_START_WITH: "starts with",
  RULE_TYPE_ID_INCLUDES: "includes",
};

/** "is prod, staging", or blank for a rule that matches everything. */
export function describeRule(rule: CxRule | undefined): string {
  if (!rule?.name) return "";
  const verb = RULE_VERBS[rule.ruleTypeId ?? ""] ?? "is";
  return `${verb} ${rule.name.split(",").join(", ")}`;
}

export function policySource(p: CxPolicy): string {
  if (p.spanRules) return "Spans";
  if (p.rumRules) return "RUM";
  return "Logs";
}

export function mapPolicy(accountId: string, p: CxPolicy): ResourceInstance {
  const id = p.id ?? "";
  const severities = (p.logRules?.severities ?? p.rumRules?.severities ?? [])
    .map((s) => humanEnum(s, "SEVERITY_"))
    .filter(Boolean);
  const current = p.priorityOverrideStatus?.quotaBased?.currentPriority;
  return instance(
    accountId,
    "tco-policy",
    id,
    p.name ?? id,
    {
      name: p.name ?? "",
      description: p.description ?? "",
      priority: policyPriorityChoice(p.priority),
      priorityLabel: POLICY_PRIORITY_LABELS[p.priority ?? ""] ?? "",
      enabled: p.enabled !== false,
      source: policySource(p),
      applications: describeRule(p.applicationRule) || "All",
      subsystems: describeRule(p.subsystemRule) || "All",
      severities: severities.join(", "),
      services: describeRule(p.spanRules?.serviceRule),
      actions: describeRule(p.spanRules?.actionRule),
      order: p.order,
      archiveRetentionId: p.archiveRetention?.id,
      currentPriority: current ? (POLICY_PRIORITY_LABELS[current] ?? "") : "",
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
    { policyId: id },
  );
}

// ---------------------------------------------------------------------------
// Parsing rule groups: GET /parsing-rules/rule-groups/v1
// ---------------------------------------------------------------------------

export interface CxParsingRule {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  order?: number;
  sourceField?: string;
  parameters?: Record<string, unknown>;
}

export interface CxRuleSubgroup {
  id?: string;
  enabled?: boolean;
  order?: number;
  rules?: CxParsingRule[];
}

export interface CxRuleGroup {
  id?: string;
  name?: string;
  description?: string;
  creator?: string;
  enabled?: boolean;
  hidden?: boolean;
  order?: number;
  ruleMatchers?: Array<{
    applicationName?: { value?: string };
    subsystemName?: { value?: string };
    severity?: { value?: string };
  }>;
  ruleSubgroups?: CxRuleSubgroup[];
}

/** "Parse", "Block", ... from a rule's parameters key (`parseParameters` → "Parse"). */
export function ruleKind(rule: CxParsingRule): string {
  const key = Object.keys(rule.parameters ?? {})[0] ?? "";
  return humanEnum(
    key
      .replace(/Parameters$/, "")
      .replace(/([A-Z])/g, "_$1")
      .toUpperCase(),
    "",
  );
}

export function mapRuleGroup(accountId: string, g: CxRuleGroup): ResourceInstance {
  const id = g.id ?? "";
  const rules = (g.ruleSubgroups ?? []).flatMap((s) => s.rules ?? []);
  const matchers = g.ruleMatchers ?? [];
  const pick = (k: "applicationName" | "subsystemName" | "severity") =>
    matchers
      .map((m) => m[k]?.value)
      .filter((v): v is string => !!v)
      .map((v) => (k === "severity" ? humanEnum(v, "VALUE_") : v))
      .join(", ");
  return instance(
    accountId,
    "parsing-rule-group",
    id,
    g.name ?? id,
    {
      name: g.name ?? "",
      description: g.description ?? "",
      enabled: g.enabled !== false,
      order: g.order,
      ruleCount: rules.length,
      ruleKinds: [...new Set(rules.map(ruleKind).filter(Boolean))].join(", "),
      applications: pick("applicationName") || "All",
      subsystems: pick("subsystemName") || "All",
      severities: pick("severity"),
      creator: g.creator,
    },
    { ruleGroupId: id },
  );
}

// ---------------------------------------------------------------------------
// Enrichments: GET /enrichment-rules/enrichment-rules/v1 and custom enrichments
// ---------------------------------------------------------------------------

export interface CxEnrichment {
  id?: number;
  fieldName?: string;
  enrichedFieldName?: string;
  selectedColumns?: string[];
  enrichmentType?: {
    geoIp?: { withAsn?: boolean };
    suspiciousIp?: Record<string, never>;
    aws?: { resourceType?: string };
    customEnrichment?: { id?: number };
  };
  targets?: Array<{ dataset?: string }>;
}

export interface CxCustomEnrichment {
  id?: number;
  name?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  version?: number;
  isQueryOnly?: boolean;
}

export function enrichmentKind(e: CxEnrichment): string {
  const t = e.enrichmentType ?? {};
  if (t.geoIp) return t.geoIp.withAsn ? "Geo IP with ASN" : "Geo IP";
  if (t.suspiciousIp) return "Suspicious IP";
  if (t.aws) return "AWS";
  if (t.customEnrichment) return "Custom";
  return "";
}

export function mapEnrichment(
  accountId: string,
  e: CxEnrichment,
  customNames: Map<number, string>,
): ResourceInstance {
  const id = String(e.id ?? "");
  const kind = enrichmentKind(e);
  const customId = e.enrichmentType?.customEnrichment?.id;
  const customName =
    customId !== undefined ? (customNames.get(customId) ?? `#${customId}`) : undefined;
  const label = [kind, e.fieldName].filter(Boolean).join(": ");
  return instance(
    accountId,
    "enrichment",
    id,
    label || id,
    {
      fieldName: e.fieldName,
      enrichedFieldName: e.enrichedFieldName,
      kind,
      customEnrichment: customName,
      customEnrichmentId: customId !== undefined ? String(customId) : undefined,
      awsResourceType: e.enrichmentType?.aws?.resourceType,
      selectedColumns: join(e.selectedColumns),
      datasets: join((e.targets ?? []).map((t) => t.dataset ?? "")),
    },
    { enrichmentId: id },
  );
}

export function mapCustomEnrichment(accountId: string, c: CxCustomEnrichment): ResourceInstance {
  const id = String(c.id ?? "");
  return instance(
    accountId,
    "custom-enrichment",
    id,
    c.name ?? id,
    {
      name: c.name ?? "",
      description: c.description ?? "",
      fileName: c.fileName,
      fileSize: c.fileSize,
      version: c.version,
      queryOnly: c.isQueryOnly === true,
    },
    { customEnrichmentId: id },
  );
}

// ---------------------------------------------------------------------------
// Outgoing webhooks: GET /integrations/webhooks/v1
// ---------------------------------------------------------------------------

export interface CxWebhookSummary {
  id?: string;
  externalId?: number;
  name?: string;
  type?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

const WEBHOOK_TYPES: Record<string, string> = {
  GENERIC: "Generic webhook",
  SLACK: "Slack",
  PAGERDUTY: "PagerDuty",
  SEND_LOG: "Send log",
  EMAIL_GROUP: "Email group",
  MICROSOFT_TEAMS: "Microsoft Teams",
  MS_TEAMS_WORKFLOW: "Microsoft Teams workflow",
  JIRA: "Jira",
  OPSGENIE: "Opsgenie",
  DEMISTO: "Cortex XSOAR (Demisto)",
  AWS_EVENT_BRIDGE: "Amazon EventBridge",
  IBM_EVENT_NOTIFICATIONS: "IBM Event Notifications",
};

export function mapWebhook(accountId: string, w: CxWebhookSummary): ResourceInstance {
  const id = w.id ?? "";
  return instance(
    accountId,
    "outgoing-webhook",
    id,
    w.name ?? id,
    {
      name: w.name ?? "",
      type: WEBHOOK_TYPES[w.type ?? ""] ?? humanEnum(w.type, ""),
      url: w.url,
      externalId: w.externalId,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    },
    { webhookId: id, ...(w.externalId !== undefined ? { externalId: String(w.externalId) } : {}) },
  );
}

// ---------------------------------------------------------------------------
// Quota rules: GET /dataplan/quota-rules/v1
// ---------------------------------------------------------------------------

export interface CxQuotaRule {
  entityType?: string;
  allocation?: number;
  allocationType?:
    | "QUOTA_ALLOCATION_TYPE_UNSPECIFIED"
    | "QUOTA_ALLOCATION_TYPE_PERCENTAGE"
    | "QUOTA_ALLOCATION_TYPE_LOCKED_UNITS";
  canOverflow?: boolean;
  cxManaged?: boolean;
  enabled?: boolean;
}

export interface CxQuotaRuleSet {
  id?: string;
  rules?: CxQuotaRule[];
}

export function allocationTypeLabel(t: string | undefined): string {
  if (t === "QUOTA_ALLOCATION_TYPE_LOCKED_UNITS") return "Locked units";
  if (t === "QUOTA_ALLOCATION_TYPE_PERCENTAGE") return "Percentage";
  return "";
}

export function mapQuotaRule(accountId: string, r: CxQuotaRule): ResourceInstance {
  const entity = r.entityType ?? "";
  const unitWord = r.allocationType === "QUOTA_ALLOCATION_TYPE_LOCKED_UNITS" ? " units" : "%";
  return instance(
    accountId,
    "quota-rule",
    entity,
    entity,
    {
      entityType: entity,
      allocation: r.allocation,
      allocationType: allocationTypeLabel(r.allocationType),
      allocationText: r.allocation !== undefined ? `${r.allocation}${unitWord}` : "",
      canOverflow: r.canOverflow === true,
      enabled: r.enabled !== false,
      cxManaged: r.cxManaged === true,
    },
    { entityType: entity },
  );
}

// ---------------------------------------------------------------------------
// Events2Metrics: GET /events2metrics/events2metrics/v2
// ---------------------------------------------------------------------------

export interface CxE2M {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  createTime?: string;
  updateTime?: string;
  logsQuery?: {
    lucene?: string;
    alias?: string;
    applicationnameFilters?: string[];
    subsystemnameFilters?: string[];
    severityFilters?: string[];
  };
  spansQuery?: {
    lucene?: string;
    applicationnameFilters?: string[];
    subsystemnameFilters?: string[];
    serviceFilters?: string[];
    actionFilters?: string[];
  };
  metricFields?: Array<{ targetBaseMetricName?: string; sourceField?: string }>;
  metricLabels?: Array<{ targetLabel?: string; sourceField?: string }>;
  permutations?: { limit?: number; hasExceededLimit?: boolean };
  isInternal?: boolean;
}

export function mapE2M(accountId: string, e: CxE2M): ResourceInstance {
  const id = e.id ?? "";
  const q = e.logsQuery ?? e.spansQuery ?? {};
  return instance(
    accountId,
    "events2metrics",
    id,
    e.name ?? id,
    {
      name: e.name ?? "",
      description: e.description ?? "",
      source: e.type === "E2M_TYPE_SPANS2METRICS" ? "Spans" : "Logs",
      query: q.lucene,
      applications: join(q.applicationnameFilters),
      subsystems: join(q.subsystemnameFilters),
      severities: join((e.logsQuery?.severityFilters ?? []).map((s) => humanEnum(s, "SEVERITY_"))),
      metrics: join((e.metricFields ?? []).map((m) => m.targetBaseMetricName ?? "")),
      labels: join((e.metricLabels ?? []).map((l) => l.targetLabel ?? "")),
      permutationsLimit: e.permutations?.limit,
      limitExceeded: e.permutations?.hasExceededLimit === true,
      createdAt: e.createTime,
      updatedAt: e.updateTime,
    },
    { e2mId: id },
  );
}

// ---------------------------------------------------------------------------
// Team: GET /aaa/teams/v2 (deprecated, still served)
// ---------------------------------------------------------------------------

export interface CxTeam {
  teamId?: { id?: number };
  teamName?: string;
  dailyQuota?: number;
  retention?: number;
}
