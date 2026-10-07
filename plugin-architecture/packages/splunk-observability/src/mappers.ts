import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "splunk-observability";

type FieldValue = string | number | boolean | undefined | null;

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
  parentExternal?: { typeId: string; id: string },
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
    ...(parentExternal?.id
      ? { parentResourceId: resourceIdFor(accountId, parentExternal.typeId, parentExternal.id) }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function isoMs(ms: unknown): string | undefined {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString();
}

const join = (v: unknown): string | undefined =>
  Array.isArray(v) && v.length ? v.map(String).join(", ") : undefined;

export interface SfOrganization {
  id?: string;
  organizationName?: string;
  accountType?: string;
  accountStatus?: string;
  accountRenews?: string;
  accountValidUntil?: number;
  dpmLimit?: number;
  tokensExpiringInSevenDays?: string[];
  tokensExpiringInThirtyDays?: string[];
  created?: number;
  url?: string[];
}

export interface SfRule {
  detectLabel?: string;
  severity?: string;
  disabled?: boolean;
  description?: string;
  notifications?: unknown[];
}

export interface SfDetector {
  id?: string;
  name?: string;
  description?: string;
  programText?: string;
  rules?: SfRule[];
  tags?: string[];
  teams?: string[];
  locked?: boolean;
  overMTSLimit?: boolean;
  creator?: string;
  lastUpdated?: number;
}

export interface SfIncident {
  incidentId?: string;
  detectorId?: string;
  detectorName?: string;
  detectLabel?: string;
  severity?: string;
  anomalyState?: string;
  active?: boolean;
  isMuted?: boolean;
  events?: Array<{ timestamp?: number; detectorName?: string; inputs?: unknown }>;
}

export interface SfMutingRule {
  id?: string;
  description?: string;
  filters?: Array<{ property?: string; propertyValue?: unknown; NOT?: boolean }>;
  startTime?: number;
  stopTime?: number;
  recurrence?: { unit?: string; value?: number } | null;
  sendAlertsOnceMutingPeriodHasEnded?: boolean;
  creator?: string;
}

export interface SfDashboardGroup {
  id?: string;
  name?: string;
  description?: string;
  dashboards?: string[];
  teams?: string[];
  creator?: string;
  lastUpdated?: number;
}

export interface SfDashboard {
  id?: string;
  name?: string;
  description?: string;
  groupId?: string;
  charts?: Array<{ chartId?: string }>;
  tags?: string[];
  creator?: string;
  lastUpdated?: number;
}

export interface SfChart {
  id?: string;
  name?: string;
  description?: string;
  programText?: string;
  options?: { type?: string };
  tags?: string[];
  lastUpdated?: number;
}

export interface SfTeam {
  id?: string;
  name?: string;
  description?: string;
  members?: string[];
  notificationLists?: Record<string, unknown[]>;
  lastUpdated?: number;
}

export interface SfMember {
  id?: string;
  email?: string;
  fullName?: string;
  title?: string;
  admin?: boolean;
  created?: number;
  roles?: Array<{ title?: string }>;
}

export interface SfIntegration {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  createdByName?: string;
  lastUpdated?: number;
}

export interface SfToken {
  id?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  authScopes?: string[];
  expiry?: number;
  latestRotation?: number;
  limits?: { dpmQuota?: number };
  exceedingLimits?: boolean;
  creator?: string;
  created?: number;
}

export interface SfSlo {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  metadata?: string[];
  targets?: Array<{
    slo?: number;
    compliancePeriod?: string;
    type?: string;
    sloAlertRules?: Array<{ type?: string }>;
  }>;
  lastUpdated?: number;
}

export interface SfTest {
  id?: number;
  name?: string;
  type?: string;
  active?: boolean;
  frequency?: number;
  locationIds?: string[];
  lastRunStatus?: string;
  lastRunAt?: string;
  schedulingStrategy?: string;
}

export function mapDetector(accountId: string, d: SfDetector, app: string): ResourceInstance {
  const id = d.id ?? "";
  const rules = d.rules ?? [];
  return instance(
    accountId,
    "detector",
    id,
    d.name ?? id,
    {
      name: d.name,
      description: d.description,
      tags: join(d.tags),
      programText: d.programText,
      rules: rules
        .map((r) => `${r.detectLabel ?? "?"} (${r.severity ?? "?"}${r.disabled ? ", off" : ""})`)
        .join(", "),
      rulesJson: rules.length
        ? JSON.stringify(
            rules.map((r) => ({
              detectLabel: r.detectLabel,
              severity: r.severity,
              description: r.description,
              disabled: r.disabled === true,
            })),
          )
        : undefined,
      ruleCount: rules.length,
      disabledRules: rules.filter((r) => r.disabled).length,
      teams: join(d.teams),
      locked: d.locked === true,
      overMTSLimit: d.overMTSLimit === true,
      creator: d.creator,
      lastUpdated: isoMs(d.lastUpdated),
    },
    { detectorId: id, url: `${app}/#/detector/v2/${id}/edit` },
  );
}

export function mapIncident(accountId: string, i: SfIncident): ResourceInstance {
  const id = i.incidentId ?? "";
  const first = (i.events ?? [])[0];
  return instance(
    accountId,
    "incident",
    id,
    `${i.detectorName ?? first?.detectorName ?? "Detector"}: ${i.detectLabel ?? id}`,
    {
      detectorName: i.detectorName ?? first?.detectorName,
      detectorId: i.detectorId,
      detectLabel: i.detectLabel,
      severity: i.severity,
      anomalyState: i.anomalyState,
      active: i.active === true,
      isMuted: i.isMuted === true,
      triggeredAt: isoMs(first?.timestamp),
      inputs: first?.inputs ? JSON.stringify(first.inputs).slice(0, 500) : undefined,
    },
  );
}

export function describeFilters(filters: SfMutingRule["filters"]): string {
  return (filters ?? [])
    .map((flt) => {
      const v = Array.isArray(flt.propertyValue)
        ? flt.propertyValue.join("|")
        : String(flt.propertyValue ?? "");
      return `${flt.NOT ? "NOT " : ""}${flt.property ?? "?"}=${v}`;
    })
    .join(", ");
}

export function mapMutingRule(accountId: string, m: SfMutingRule): ResourceInstance {
  const id = m.id ?? "";
  return instance(accountId, "muting-rule", id, m.description || id, {
    description: m.description,
    filters: describeFilters(m.filters) || "All alerts",
    startTime: isoMs(m.startTime),
    stopTime: isoMs(m.stopTime),
    recurrence: m.recurrence?.value
      ? `every ${m.recurrence.value}${m.recurrence.unit ?? ""}`
      : undefined,
    sendAlertsAfter: m.sendAlertsOnceMutingPeriodHasEnded === true,
    creator: m.creator,
  });
}

export function mapGroup(accountId: string, g: SfDashboardGroup, app: string): ResourceInstance {
  const id = g.id ?? "";
  return instance(
    accountId,
    "dashboard-group",
    id,
    g.name ?? id,
    {
      name: g.name,
      description: g.description,
      dashboardCount: g.dashboards?.length ?? 0,
      teams: join(g.teams),
      creator: g.creator,
      lastUpdated: isoMs(g.lastUpdated),
    },
    { url: `${app}/#/dashboard?groupId=${id}` },
  );
}

export function mapDashboard(accountId: string, d: SfDashboard, app: string): ResourceInstance {
  const id = d.id ?? "";
  return instance(
    accountId,
    "dashboard",
    id,
    d.name ?? id,
    {
      name: d.name,
      description: d.description,
      groupId: d.groupId,
      chartCount: d.charts?.length ?? 0,
      tags: join(d.tags),
      creator: d.creator,
      lastUpdated: isoMs(d.lastUpdated),
    },
    { url: `${app}/#/dashboard/${id}` },
    d.groupId ? { typeId: "dashboard-group", id: d.groupId } : undefined,
  );
}

export function mapChart(accountId: string, c: SfChart, dashboardId?: string): ResourceInstance {
  const id = c.id ?? "";
  return instance(
    accountId,
    "chart",
    id,
    c.name ?? id,
    {
      name: c.name,
      description: c.description,
      programText: c.programText,
      chartType: c.options?.type,
      dashboardId,
      tags: join(c.tags),
      lastUpdated: isoMs(c.lastUpdated),
    },
    {},
    dashboardId ? { typeId: "dashboard", id: dashboardId } : undefined,
  );
}

export function mapTeam(accountId: string, t: SfTeam): ResourceInstance {
  const id = t.id ?? "";
  const lists = Object.entries(t.notificationLists ?? {})
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}: ${v.length}`)
    .join(", ");
  return instance(
    accountId,
    "team",
    id,
    t.name ?? id,
    {
      name: t.name,
      description: t.description,
      memberCount: t.members?.length ?? 0,
      notificationPolicies: lists,
      lastUpdated: isoMs(t.lastUpdated),
    },
    { teamId: id },
  );
}

export function mapMember(accountId: string, m: SfMember): ResourceInstance {
  const id = m.id ?? "";
  return instance(accountId, "member", id, m.fullName || m.email || id, {
    admin: m.admin === true,
    email: m.email,
    fullName: m.fullName,
    title: m.title,
    roles: join((m.roles ?? []).map((r) => r.title).filter(Boolean)),
    created: isoMs(m.created),
  });
}

export function mapIntegration(accountId: string, i: SfIntegration): ResourceInstance {
  const id = i.id ?? "";
  return instance(
    accountId,
    "integration",
    id,
    i.name ?? id,
    {
      name: i.name,
      type: i.type,
      enabled: i.enabled === true,
      createdBy: i.createdByName,
      lastUpdated: isoMs(i.lastUpdated),
    },
    { integrationId: id },
  );
}

/** Tokens are addressed by name in every route, so the name is the external id. */
export function mapToken(accountId: string, t: SfToken): ResourceInstance {
  const name = t.name ?? t.id ?? "";
  return instance(accountId, "org-token", name, name, {
    description: t.description,
    disabled: t.disabled === true,
    authScopes: join(t.authScopes),
    expiry: isoMs(t.expiry),
    latestRotation: isoMs(t.latestRotation),
    dpmQuota: t.limits?.dpmQuota,
    exceedingLimits: t.exceedingLimits === true,
    creator: t.creator,
    created: isoMs(t.created),
  });
}

export function mapSlo(accountId: string, s: SfSlo): ResourceInstance {
  const id = s.id ?? "";
  const target = s.targets?.[0];
  return instance(accountId, "slo", id, s.name ?? id, {
    name: s.name,
    description: s.description,
    type: s.type,
    target: target?.slo,
    compliancePeriod: target?.compliancePeriod,
    targetType: target?.type,
    alertRules: join((target?.sloAlertRules ?? []).map((r) => r.type)),
    metadata: join(s.metadata),
    lastUpdated: isoMs(s.lastUpdated),
  });
}

export function mapTest(accountId: string, t: SfTest): ResourceInstance {
  const id = String(t.id ?? "");
  return instance(accountId, "synthetic-test", id, t.name ?? id, {
    name: t.name,
    type: t.type,
    active: t.active === true,
    frequency: t.frequency,
    locations: join(t.locationIds),
    lastRunStatus: t.lastRunStatus,
    lastRunAt: t.lastRunAt,
    schedulingStrategy: t.schedulingStrategy,
    testId: id,
  });
}

/** Labels published by `detect(...).publish('label')` in a SignalFlow program. */
export function detectLabels(program: string): string[] {
  const out: string[] = [];
  const re = /detect\s*\([\s\S]*?\)\s*\.publish\s*\(\s*(?:label\s*=\s*)?['"]([^'"]+)['"]/g;
  for (const m of program.matchAll(re)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}
