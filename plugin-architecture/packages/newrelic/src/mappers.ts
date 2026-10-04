/**
 * NerdGraph response shapes (the fields this plugin reads) and their mapping
 * to `ResourceInstance`s. Outline fragments and field names verified against
 * the queries newrelic-client-go generates from the NerdGraph schema
 * (`pkg/entities`, `pkg/alerts`, 2026-10).
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { NewRelicRegion } from "./regions.js";

export const PLUGIN_ID = "newrelic";

/** `entitySearch(query:)` filter per entity resource type. */
export const ENTITY_QUERIES: Record<string, string> = {
  "apm-application": "domain = 'APM' AND type = 'APPLICATION'",
  "browser-application": "domain = 'BROWSER' AND type = 'APPLICATION'",
  host: "domain = 'INFRA' AND type = 'HOST'",
  "synthetic-monitor": "domain = 'SYNTH' AND type = 'MONITOR'",
  dashboard: "domain = 'VIZ' AND type = 'DASHBOARD'",
  workload: "domain = 'NR1' AND type = 'WORKLOAD'",
};

export const ENTITY_FIELDS = `
  guid name accountId domain type entityType reporting alertSeverity permalink
  account { id name }
  tags { key values }
  ... on ApmApplicationEntityOutline {
    language applicationId
    apmSummary { apdexScore errorRate hostCount instanceCount responseTimeAverage throughput }
    runningAgentVersions { maxVersion minVersion }
  }
  ... on BrowserApplicationEntityOutline {
    agentInstallType applicationId
    browserSummary { jsErrorRate pageLoadThroughput pageLoadTimeAverage }
  }
  ... on InfrastructureHostEntityOutline {
    hostSummary { cpuUtilizationPercent diskUsedPercent memoryUsedPercent servicesCount }
  }
  ... on SyntheticMonitorEntityOutline {
    monitorId monitorType monitoredUrl period
    monitorSummary { locationsFailing locationsRunning status successRate }
  }
  ... on DashboardEntityOutline { createdAt updatedAt permissions owner { email } }
  ... on WorkloadEntityOutline {
    createdAt updatedAt createdByUser { email name }
    workloadStatus { statusSource statusValue summary }
  }
`;

export interface NrEntity {
  guid?: string;
  name?: string;
  accountId?: number;
  domain?: string;
  type?: string;
  entityType?: string;
  reporting?: boolean | null;
  alertSeverity?: string | null;
  permalink?: string | null;
  account?: { id?: number; name?: string } | null;
  tags?: Array<{ key?: string; values?: string[] }> | null;
  language?: string | null;
  applicationId?: number | null;
  apmSummary?: {
    apdexScore?: number | null;
    errorRate?: number | null;
    hostCount?: number | null;
    instanceCount?: number | null;
    responseTimeAverage?: number | null;
    throughput?: number | null;
  } | null;
  runningAgentVersions?: { maxVersion?: string | null; minVersion?: string | null } | null;
  agentInstallType?: string | null;
  browserSummary?: {
    jsErrorRate?: number | null;
    pageLoadThroughput?: number | null;
    pageLoadTimeAverage?: number | null;
  } | null;
  hostSummary?: {
    cpuUtilizationPercent?: number | null;
    diskUsedPercent?: number | null;
    memoryUsedPercent?: number | null;
    servicesCount?: number | null;
  } | null;
  monitorId?: string | null;
  monitorType?: string | null;
  monitoredUrl?: string | null;
  period?: number | string | null;
  monitorSummary?: {
    locationsFailing?: number | null;
    locationsRunning?: number | null;
    status?: string | null;
    successRate?: number | null;
  } | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  permissions?: string | null;
  owner?: { email?: string | null } | null;
  createdByUser?: { email?: string | null; name?: string | null } | null;
  workloadStatus?: {
    statusSource?: string | null;
    statusValue?: string | null;
    summary?: string | null;
  } | null;
}

export interface NrPolicy {
  id?: string | number;
  name?: string;
  incidentPreference?: string;
  accountId?: number;
}

export interface NrCondition {
  id?: string | number;
  name?: string;
  description?: string | null;
  runbookUrl?: string | null;
  enabled?: boolean;
  policyId?: string | number;
  type?: string;
  nrql?: { query?: string; dataAccountId?: number | null } | null;
  terms?: Array<{
    operator?: string;
    priority?: string;
    threshold?: number | null;
    thresholdDuration?: number | null;
    thresholdOccurrences?: string;
  }> | null;
}

export const CONDITION_FIELDS = `
  id name description runbookUrl enabled policyId type
  nrql { query dataAccountId }
  terms { operator priority threshold thresholdDuration thresholdOccurrences }
`;

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
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

const round = (n: number | null | undefined, digits = 2): number | undefined =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.round(n * 10 ** digits) / 10 ** digits
    : undefined;

/** Epoch milliseconds or an ISO string, as an ISO string. */
export function isoTime(v: number | string | null | undefined): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Tags as `key:value` pairs, skipping New Relic's own bookkeeping tags. */
function describeTags(tags: NrEntity["tags"]): string {
  const hidden = new Set(["account", "accountId", "trustedAccountId", "guid"]);
  return (tags ?? [])
    .filter((t) => t.key && !hidden.has(t.key))
    .map((t) => `${t.key}:${(t.values ?? []).join("|")}`)
    .join(", ");
}

/** Monitor periods come back as minutes on the outline; the update input takes the enum. */
export function periodEnum(period: number | string | null | undefined): string | undefined {
  if (period === null || period === undefined || period === "") return undefined;
  if (typeof period === "string" && period.startsWith("EVERY_")) return period;
  const minutes = Number(period);
  const map: Record<number, string> = {
    1: "EVERY_MINUTE",
    5: "EVERY_5_MINUTES",
    10: "EVERY_10_MINUTES",
    15: "EVERY_15_MINUTES",
    30: "EVERY_30_MINUTES",
    60: "EVERY_HOUR",
    360: "EVERY_6_HOURS",
    720: "EVERY_12_HOURS",
    1440: "EVERY_DAY",
  };
  return map[minutes];
}

export function mapEntity(
  accountId: string,
  typeId: string,
  region: NewRelicRegion,
  e: NrEntity,
): ResourceInstance {
  const guid = e.guid ?? "";
  const nrAccountId = e.accountId ?? e.account?.id;
  const common: Record<string, FieldValue> = {
    name: e.name,
    guid,
    reporting: e.reporting ?? undefined,
    alertSeverity: e.alertSeverity ?? undefined,
    tags: describeTags(e.tags),
    accountName: e.account?.name,
    nrAccountId: nrAccountId !== undefined ? String(nrAccountId) : undefined,
  };
  const url = e.permalink || `${region.appUrl}/redirect/entity/${encodeURIComponent(guid)}`;
  const outputs: Record<string, string | undefined> = { guid, url };
  let fields: Record<string, FieldValue> = {};
  switch (typeId) {
    case "apm-application": {
      const s = e.apmSummary ?? {};
      const responseSeconds = s.responseTimeAverage;
      fields = {
        language: e.language,
        apdex: round(s.apdexScore),
        responseTimeMs:
          typeof responseSeconds === "number" ? round(responseSeconds * 1000, 1) : undefined,
        throughput: round(s.throughput, 1),
        errorRate: round(s.errorRate),
        hostCount: s.hostCount ?? undefined,
        instanceCount: s.instanceCount ?? undefined,
        agentVersion: e.runningAgentVersions?.maxVersion ?? undefined,
        applicationId: e.applicationId != null ? String(e.applicationId) : undefined,
      };
      break;
    }
    case "browser-application": {
      const s = e.browserSummary ?? {};
      fields = {
        pageLoadTime: round(s.pageLoadTimeAverage),
        pageViews: round(s.pageLoadThroughput, 1),
        jsErrorRate: round(s.jsErrorRate),
        agentInstallType: e.agentInstallType,
        applicationId: e.applicationId != null ? String(e.applicationId) : undefined,
      };
      break;
    }
    case "host": {
      const s = e.hostSummary ?? {};
      fields = {
        cpuPercent: round(s.cpuUtilizationPercent, 1),
        memoryPercent: round(s.memoryUsedPercent, 1),
        diskPercent: round(s.diskUsedPercent, 1),
        servicesCount: s.servicesCount ?? undefined,
      };
      break;
    }
    case "synthetic-monitor": {
      const s = e.monitorSummary ?? {};
      fields = {
        monitorType: e.monitorType,
        status: s.status ?? undefined,
        monitoredUrl: e.monitoredUrl,
        period: periodEnum(e.period),
        successRate: round(s.successRate, 1),
        locationsRunning: s.locationsRunning ?? undefined,
        locationsFailing: s.locationsFailing ?? undefined,
        monitorId: e.monitorId,
      };
      outputs["monitorId"] = e.monitorId ?? undefined;
      break;
    }
    case "dashboard":
      fields = {
        owner: e.owner?.email,
        permissions: e.permissions,
        createdAt: isoTime(e.createdAt),
        updatedAt: isoTime(e.updatedAt),
      };
      break;
    case "workload":
      fields = {
        status: e.workloadStatus?.statusValue,
        statusSource: e.workloadStatus?.statusSource,
        statusSummary: e.workloadStatus?.summary,
        createdBy: e.createdByUser?.email ?? e.createdByUser?.name,
        createdAt: isoTime(e.createdAt),
        updatedAt: isoTime(e.updatedAt),
      };
      break;
    default:
      break;
  }
  return instance(accountId, typeId, guid, e.name ?? guid, { ...common, ...fields }, outputs);
}

/** Policies and conditions are addressed by account + id: `<accountId>:<id>`. */
export function scopedId(nrAccountId: number | string, id: string | number): string {
  return `${nrAccountId}:${id}`;
}

export function parseScopedId(externalId: string): { nrAccountId: number; id: string } {
  const at = externalId.indexOf(":");
  const nrAccountId = Number(externalId.slice(0, at));
  const id = externalId.slice(at + 1);
  if (at <= 0 || !Number.isInteger(nrAccountId) || !id) {
    throw new Error(`New Relic plugin: malformed id "${externalId}"`);
  }
  return { nrAccountId, id };
}

export function mapPolicy(
  accountId: string,
  account: { id: number; name: string },
  p: NrPolicy,
): ResourceInstance {
  const id = String(p.id ?? "");
  return instance(
    accountId,
    "alert-policy",
    scopedId(account.id, id),
    p.name ?? id,
    {
      name: p.name,
      incidentPreference: p.incidentPreference,
      policyId: id,
      accountName: account.name,
      nrAccountId: String(account.id),
    },
    { policyId: id },
  );
}

export function describeTerms(terms: NrCondition["terms"]): string {
  return (terms ?? [])
    .map((t) => {
      const op =
        t.operator === "ABOVE"
          ? ">"
          : t.operator === "ABOVE_OR_EQUALS"
            ? ">="
            : t.operator === "BELOW"
              ? "<"
              : t.operator === "BELOW_OR_EQUALS"
                ? "<="
                : t.operator === "EQUALS"
                  ? "="
                  : t.operator === "NOT_EQUALS"
                    ? "!="
                    : (t.operator ?? "");
      const dur =
        typeof t.thresholdDuration === "number"
          ? ` for ${Math.round(t.thresholdDuration / 60)}m`
          : "";
      return `${(t.priority ?? "").toLowerCase()} ${op} ${t.threshold ?? ""}${dur}`.trim();
    })
    .join("; ");
}

export function mapCondition(
  accountId: string,
  account: { id: number; name: string },
  c: NrCondition,
  policyNames: Map<string, string>,
): ResourceInstance {
  const id = String(c.id ?? "");
  const policyId = c.policyId !== undefined ? String(c.policyId) : "";
  return instance(
    accountId,
    "alert-condition",
    scopedId(account.id, id),
    c.name ?? id,
    {
      name: c.name,
      description: c.description,
      runbookUrl: c.runbookUrl,
      enabled: c.enabled,
      conditionType: c.type,
      query: c.nrql?.query,
      dataAccountId: c.nrql?.dataAccountId != null ? String(c.nrql.dataAccountId) : undefined,
      thresholds: describeTerms(c.terms),
      policyName: policyNames.get(policyId),
      policyId,
      conditionId: id,
      accountName: account.name,
      nrAccountId: String(account.id),
    },
    { conditionId: id },
  );
}

export function mapAccount(
  accountId: string,
  region: NewRelicRegion,
  a: { id: number; name: string },
  usageAccountId: number | undefined,
  monthToDate?: number,
): ResourceInstance {
  return instance(
    accountId,
    "account",
    String(a.id),
    a.name,
    {
      name: a.name,
      nrAccountId: String(a.id),
      region: region.label,
      usageAccount: usageAccountId === a.id,
      monthToDate,
    },
    { nrAccountId: String(a.id) },
  );
}
