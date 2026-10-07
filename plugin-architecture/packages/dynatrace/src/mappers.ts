/** API response → `ResourceInstance` mapping for every Dynatrace type. */

import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "dynatrace";

type FieldValue = string | number | boolean | undefined | null;

export interface DtEntityRef {
  id?: string;
  type?: string;
}

export interface DtEntity {
  entityId?: string;
  displayName?: string;
  type?: string;
  firstSeenTms?: number;
  lastSeenTms?: number;
  properties?: Record<string, unknown>;
  tags?: Array<{ key?: string; value?: string; stringRepresentation?: string }>;
  managementZones?: Array<{ id?: string; name?: string }>;
  fromRelationships?: Record<string, DtEntityRef[]>;
}

export interface DtProblem {
  problemId?: string;
  displayId?: string;
  title?: string;
  status?: string;
  severityLevel?: string;
  impactLevel?: string;
  startTime?: number;
  endTime?: number;
  rootCauseEntity?: { entityId?: { id?: string; type?: string }; name?: string } | null;
  affectedEntities?: Array<{ entityId?: { id?: string; type?: string }; name?: string }>;
  impactedEntities?: Array<{ entityId?: { id?: string; type?: string }; name?: string }>;
  managementZones?: Array<{ id?: string; name?: string }>;
  recentComments?: { comments?: DtComment[] };
  evidenceDetails?: { details?: Array<{ displayName?: string; evidenceType?: string }> };
}

export interface DtComment {
  id?: string;
  createdAtTimestamp?: number;
  content?: string;
  authorName?: string;
  context?: string;
}

export interface DtSlo {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  target?: number;
  warning?: number;
  timeframe?: string;
  evaluationType?: string;
  metricExpression?: string;
  metricName?: string;
  filter?: string;
  status?: string;
  evaluatedPercentage?: number;
  errorBudget?: number;
  relatedOpenProblems?: number;
  error?: string;
}

export interface DtMonitorStub {
  entityId?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
}

export interface DtMonitor extends DtMonitorStub {
  frequencyMin?: number;
  locations?: string[];
  tags?: Array<{ key?: string; value?: string } | string>;
  script?: {
    requests?: Array<{ url?: string; method?: string }>;
    events?: Array<{ url?: string; type?: string }>;
    configuration?: unknown;
  };
}

export interface DtSettingsObject<V = Record<string, unknown>> {
  objectId?: string;
  schemaVersion?: string;
  scope?: string;
  value?: V;
}

export interface DtApiToken {
  id?: string;
  name?: string;
  enabled?: boolean;
  owner?: string;
  personalAccessToken?: boolean;
  scopes?: string[];
  creationDate?: string;
  expirationDate?: string;
  lastUsedDate?: string;
  lastUsedIpAddress?: string;
}

export function resourceIdFor(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

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
    id: resourceIdFor(accountId, typeId, externalId),
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

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Epoch milliseconds → ISO, ignoring Dynatrace's `-1` for "not yet". */
export function isoMs(ms: number | undefined | null): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function list(values: unknown): string | undefined {
  if (!Array.isArray(values)) return typeof values === "string" ? values : undefined;
  const out = values.map((v) => str(v)).filter(Boolean);
  return out.length ? out.join(", ") : undefined;
}

function prop(e: DtEntity, key: string): unknown {
  return e.properties?.[key];
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function formatTags(tags: DtEntity["tags"]): string | undefined {
  const out = (tags ?? [])
    .map((t) => t.stringRepresentation ?? (t.value ? `${t.key}:${t.value}` : t.key))
    .filter((t): t is string => Boolean(t));
  return out.length ? out.join(", ") : undefined;
}

function zones(mz: Array<{ name?: string }> | undefined): string | undefined {
  return list((mz ?? []).map((z) => z.name).filter(Boolean));
}

function relIds(e: DtEntity, rel: string, type?: string): string | undefined {
  const refs = (e.fromRelationships?.[rel] ?? []).filter((r) => !type || r.type === type);
  return list(refs.map((r) => r.id));
}

export function mapEntity(accountId: string, typeId: string, e: DtEntity): ResourceInstance {
  const id = e.entityId ?? "";
  const common = {
    entityId: id,
    tags: formatTags(e.tags),
    managementZones: zones(e.managementZones),
    firstSeen: isoMs(e.firstSeenTms),
    lastSeen: isoMs(e.lastSeenTms),
  };
  let fields: Record<string, FieldValue> = {};
  switch (typeId) {
    case "host":
      fields = {
        osType: str(prop(e, "osType")),
        osVersion: str(prop(e, "osVersion")),
        cpuCores: num(prop(e, "cpuCores")),
        memoryBytes: num(prop(e, "physicalMemory")),
        monitoringMode: str(prop(e, "monitoringMode")),
        state: str(prop(e, "state")),
        ipAddresses: list(prop(e, "ipAddress")),
        cloudType: str(prop(e, "cloudType")),
        hostGroup: str(prop(e, "hostGroupName")),
        oneAgentVersion: oneAgentVersion(prop(e, "installerVersion")),
      };
      break;
    case "process-group":
      fields = {
        technologies: technologies(prop(e, "softwareTechnologies")),
        runsOn: relIds(e, "runsOn", "HOST"),
      };
      break;
    case "service":
      fields = {
        serviceType: str(prop(e, "serviceType")),
        technology:
          technologies(prop(e, "serviceTechnologyTypes")) ??
          list(prop(e, "serviceTechnologyTypes")),
        webServer: str(prop(e, "webServerName")),
        runsOn: relIds(e, "runsOn", "PROCESS_GROUP"),
      };
      break;
    case "application":
      fields = { applicationType: str(prop(e, "applicationType")) };
      break;
    case "kubernetes-cluster":
      fields = {
        distribution: str(prop(e, "kubernetesDistribution")),
        kubernetesVersion: str(prop(e, "kubernetesVersion")),
        cloudType: str(prop(e, "cloudType")),
      };
      break;
  }
  return instance(
    accountId,
    typeId,
    id,
    e.displayName ?? id,
    { ...fields, ...common },
    {
      entityId: id,
    },
  );
}

function oneAgentVersion(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function technologies(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const o = t as { type?: string; edition?: string; version?: string };
        return [o.type, o.version].filter(Boolean).join(" ");
      }
      return "";
    })
    .filter(Boolean);
  return out.length ? Array.from(new Set(out)).join(", ") : undefined;
}

export function mapProblem(accountId: string, p: DtProblem): ResourceInstance {
  const id = p.problemId ?? p.displayId ?? "";
  const affected = [...(p.affectedEntities ?? []), ...(p.impactedEntities ?? [])];
  const affectedIds = Array.from(
    new Set(affected.map((a) => a.entityId?.id).filter((x): x is string => Boolean(x))),
  );
  const affectedNames = Array.from(
    new Set(affected.map((a) => a.name).filter((x): x is string => Boolean(x))),
  );
  return instance(accountId, "problem", id, `${p.displayId ?? ""} ${p.title ?? ""}`.trim(), {
    displayId: p.displayId,
    title: p.title,
    status: p.status,
    severityLevel: p.severityLevel,
    impactLevel: p.impactLevel,
    rootCause: p.rootCauseEntity?.name,
    rootCauseEntityId: p.rootCauseEntity?.entityId?.id,
    affectedEntities: affectedNames.slice(0, 20).join(", "),
    affectedEntityIds: affectedIds.slice(0, 50).join(", "),
    startTime: isoMs(p.startTime),
    endTime: isoMs(p.endTime),
    managementZones: zones(p.managementZones),
  });
}

export function mapSlo(accountId: string, s: DtSlo): ResourceInstance {
  const id = s.id ?? "";
  return instance(
    accountId,
    "slo",
    id,
    s.name ?? id,
    {
      name: s.name,
      description: s.description,
      metricExpression: s.metricExpression,
      filter: s.filter,
      target: s.target,
      warning: s.warning,
      timeframe: s.timeframe,
      enabled: s.enabled === true,
      status: s.enabled === false ? "DISABLED" : s.status,
      // Dynatrace reports -1 when an SLO could not be evaluated.
      evaluatedPercentage:
        typeof s.evaluatedPercentage === "number" && s.evaluatedPercentage >= 0
          ? round(s.evaluatedPercentage)
          : undefined,
      errorBudget:
        typeof s.errorBudget === "number" && s.evaluatedPercentage !== -1
          ? round(s.errorBudget)
          : undefined,
      relatedOpenProblems: s.relatedOpenProblems,
      metricName: s.metricName,
      evaluationType: s.evaluationType,
    },
    { sloId: id },
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function mapMonitor(
  accountId: string,
  m: DtMonitor,
  locationNames: Map<string, string> = new Map(),
): ResourceInstance {
  const id = m.entityId ?? "";
  const url = m.script?.requests?.[0]?.url ?? m.script?.events?.find((e) => e.url)?.url;
  const tags = (m.tags ?? [])
    .map((t) => (typeof t === "string" ? t : t.value ? `${t.key}:${t.value}` : t.key))
    .filter(Boolean)
    .join(", ");
  return instance(
    accountId,
    "synthetic-monitor",
    id,
    m.name ?? id,
    {
      type: m.type,
      enabled: m.enabled === true,
      frequencyMin: m.frequencyMin,
      url,
      locations: m.locations?.map((l) => locationNames.get(l) ?? l).join(", "),
      locationCount: m.locations?.length,
      entityId: id,
      tags,
    },
    { entityId: id },
  );
}

/** Alerting profile `value`, as stored in Settings 2.0. */
export interface AlertingProfileValue {
  name?: string;
  managementZone?: string | null;
  severityRules?: Array<{
    severityLevel?: string;
    delayInMinutes?: number;
    tagFilterIncludeMode?: string;
    tagFilter?: string[];
  }>;
  eventFilters?: unknown[];
}

/** Severity level ↔ the per-severity delay field on the alerting profile type. */
export const SEVERITY_FIELDS: Array<[field: string, level: string]> = [
  ["delayAvailability", "AVAILABILITY"],
  ["delayErrors", "ERRORS"],
  ["delaySlowdown", "PERFORMANCE"],
  ["delayResource", "RESOURCE_CONTENTION"],
  ["delayCustom", "CUSTOM_ALERT"],
  ["delayMonitoring", "MONITORING_UNAVAILABLE"],
];

export function mapAlertingProfile(
  accountId: string,
  o: DtSettingsObject<AlertingProfileValue>,
): ResourceInstance {
  const id = o.objectId ?? "";
  const v = o.value ?? {};
  const rules = v.severityRules ?? [];
  const delays: Record<string, number | undefined> = {};
  for (const [field, level] of SEVERITY_FIELDS) {
    const rule = rules.find((r) => r.severityLevel === level);
    delays[field] = rule ? (rule.delayInMinutes ?? 0) : undefined;
  }
  return instance(
    accountId,
    "alerting-profile",
    id,
    v.name ?? id,
    {
      name: v.name,
      ...delays,
      ruleCount: rules.length,
      eventFilterCount: v.eventFilters?.length ?? 0,
      rulesJson: rules.length ? JSON.stringify(rules) : undefined,
      managementZone: v.managementZone ?? undefined,
      objectId: id,
    },
    { objectId: id },
  );
}

/** Maintenance window `value`, as stored in Settings 2.0. */
export interface MaintenanceWindowValue {
  enabled?: boolean;
  generalProperties?: {
    name?: string;
    description?: string;
    maintenanceType?: string;
    suppression?: string;
    disableSyntheticMonitorExecution?: boolean;
  };
  schedule?: {
    scheduleType?: string;
    onceRecurrence?: { startTime?: string; endTime?: string; timeZone?: string };
    dailyRecurrence?: Recurrence;
    weeklyRecurrence?: Recurrence & { dayOfWeek?: string };
    monthlyRecurrence?: Recurrence & { dayOfMonth?: number };
  };
  filters?: Array<{
    entityType?: string;
    entityId?: string;
    entityTags?: string[];
    managementZones?: string[];
  }>;
}

interface Recurrence {
  recurrenceRange?: { scheduleStartDate?: string; scheduleEndDate?: string };
  timeWindow?: { startTime?: string; endTime?: string; timeZone?: string };
}

export function describeSchedule(s: MaintenanceWindowValue["schedule"]): string {
  if (!s) return "";
  const window = (r: Recurrence | undefined) => {
    const t = r?.timeWindow;
    const range = r?.recurrenceRange;
    const times = t ? `${t.startTime ?? ""}-${t.endTime ?? ""} ${t.timeZone ?? ""}`.trim() : "";
    const dates = range
      ? ` from ${range.scheduleStartDate ?? "?"} to ${range.scheduleEndDate ?? "?"}`
      : "";
    return `${times}${dates}`;
  };
  switch (s.scheduleType) {
    case "ONCE": {
      const o = s.onceRecurrence;
      return o
        ? `Once, ${o.startTime ?? "?"} to ${o.endTime ?? "?"} ${o.timeZone ?? ""}`.trim()
        : "Once";
    }
    case "DAILY":
      return `Daily ${window(s.dailyRecurrence)}`.trim();
    case "WEEKLY":
      return `Every ${titleCase(s.weeklyRecurrence?.dayOfWeek ?? "week")} ${window(s.weeklyRecurrence)}`.trim();
    case "MONTHLY":
      return `Monthly on day ${s.monthlyRecurrence?.dayOfMonth ?? "?"} ${window(s.monthlyRecurrence)}`.trim();
    default:
      return str(s.scheduleType);
  }
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

export function describeFilters(filters: MaintenanceWindowValue["filters"]): string {
  if (!filters || filters.length === 0) return "Whole environment";
  return filters
    .map((f) =>
      [
        f.entityType,
        f.entityId,
        f.entityTags?.length ? `tags ${f.entityTags.join("+")}` : "",
        f.managementZones?.length ? `zones ${f.managementZones.join("+")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("; ");
}

export function mapMaintenanceWindow(
  accountId: string,
  o: DtSettingsObject<MaintenanceWindowValue>,
): ResourceInstance {
  const id = o.objectId ?? "";
  const v = o.value ?? {};
  const g = v.generalProperties ?? {};
  return instance(
    accountId,
    "maintenance-window",
    id,
    g.name ?? id,
    {
      name: g.name,
      description: g.description,
      enabled: v.enabled === true,
      maintenanceType: g.maintenanceType,
      suppression: g.suppression,
      disableSynthetic: g.disableSyntheticMonitorExecution === true,
      scheduleType: v.schedule?.scheduleType,
      schedule: describeSchedule(v.schedule),
      filters: describeFilters(v.filters),
      objectId: id,
    },
    { objectId: id },
  );
}

export function mapApiToken(accountId: string, t: DtApiToken): ResourceInstance {
  const id = t.id ?? "";
  return instance(accountId, "api-token", id, t.name ?? id, {
    name: t.name,
    enabled: t.enabled === true,
    owner: t.owner,
    scopes: t.scopes?.join(", "),
    personalAccessToken: t.personalAccessToken === true,
    expirationDate: t.expirationDate,
    lastUsedDate: t.lastUsedDate,
    lastUsedIpAddress: t.lastUsedIpAddress,
    creationDate: t.creationDate,
  });
}
