/**
 * Datadog API response shapes (the fields this plugin reads; verified against
 * Datadog's published v1/v2 OpenAPI documents, 2026-10) and their mapping to
 * `ResourceInstance`s.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { DatadogSite } from "./sites.js";

export const PLUGIN_ID = "datadog";

export interface DdMonitor {
  id?: number;
  name?: string;
  type?: string;
  query?: string;
  message?: string;
  priority?: number | null;
  tags?: string[];
  overall_state?: string;
  created?: string;
  modified?: string;
  creator?: { email?: string; handle?: string; name?: string };
  options?: {
    silenced?: Record<string, number | null> | null;
    thresholds?: Record<string, number | null> | null;
  };
  matching_downtimes?: Array<{ id?: number; start?: number | null; end?: number | null }>;
}

export interface DdDowntime {
  id?: string;
  attributes?: {
    scope?: string;
    message?: string | null;
    status?: string;
    created?: string;
    canceled?: string | null;
    monitor_identifier?: { monitor_id?: number; monitor_tags?: string[] };
    schedule?: {
      start?: string | null;
      end?: string | null;
      current_downtime?: { start?: string | null; end?: string | null };
      recurrences?: unknown[];
    };
  };
  relationships?: { monitor?: { data?: { id?: string | number } | null } };
}

export interface DdDashboardSummary {
  id?: string;
  title?: string;
  description?: string | null;
  layout_type?: string;
  author_handle?: string;
  is_read_only?: boolean;
  url?: string;
  created_at?: string;
  modified_at?: string;
}

export interface DdSlo {
  id?: string;
  name?: string;
  description?: string | null;
  type?: string;
  target_threshold?: number;
  warning_threshold?: number | null;
  timeframe?: string;
  tags?: string[];
  monitor_ids?: number[];
  created_at?: number;
  creator?: { email?: string; name?: string; handle?: string };
  thresholds?: Array<{ target?: number; warning?: number; timeframe?: string }>;
}

export interface DdSyntheticsTest {
  public_id?: string;
  name?: string;
  type?: string;
  subtype?: string;
  status?: string;
  locations?: string[];
  tags?: string[];
  monitor_id?: number;
  creator?: { email?: string; handle?: string; name?: string };
  config?: { request?: { url?: string; host?: string; port?: number | string } };
}

export interface DdHost {
  id?: number;
  name?: string;
  host_name?: string;
  aliases?: string[];
  apps?: string[];
  sources?: string[];
  up?: boolean;
  is_muted?: boolean;
  last_reported_time?: number;
  meta?: { agent_version?: string; platform?: string; cpuCores?: number };
  metrics?: { cpu?: number; iowait?: number; load?: number };
}

export interface DdUserAttributes {
  name?: string | null;
  email?: string;
  handle?: string;
  status?: string;
  title?: string | null;
  disabled?: boolean;
  mfa_enabled?: boolean;
  service_account?: boolean;
  last_login_time?: string | null;
  created_at?: string;
}

export interface DdUser {
  id?: string;
  attributes?: DdUserAttributes;
  relationships?: { roles?: { data?: Array<{ id?: string; type?: string }> } };
}

export interface DdIncluded {
  id?: string | number;
  type?: string;
  attributes?: { name?: string; email?: string; handle?: string };
}

export interface DdApiKey {
  id?: string;
  attributes?: {
    name?: string;
    last4?: string;
    category?: string;
    created_at?: string;
    date_last_used?: string | null;
    remote_config_read_enabled?: boolean;
  };
  relationships?: { created_by?: { data?: { id?: string } | null } };
}

export interface DdApplicationKey {
  id?: string;
  attributes?: {
    name?: string;
    last4?: string;
    created_at?: string;
    last_used_at?: string | null;
    scopes?: string[] | null;
  };
  relationships?: { owned_by?: { data?: { id?: string } | null } };
}

export interface DdOrg {
  public_id?: string;
  name?: string;
  created?: string;
  description?: string;
  subscription?: { type?: string };
  billing?: { type?: string };
}

function instance(
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

const join = (list: Array<string | number> | null | undefined): string =>
  (list ?? []).map(String).filter(Boolean).join(", ");

const epochToIso = (seconds: number | null | undefined): string | undefined =>
  typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;

/** Monitor thresholds as "critical 90 · warning 80". */
export function describeThresholds(t: Record<string, number | null> | null | undefined): string {
  if (!t) return "";
  const order = ["critical", "critical_recovery", "warning", "warning_recovery", "ok", "unknown"];
  return order
    .filter((k) => typeof t[k] === "number")
    .map((k) => `${k.replace("_", " ")} ${t[k]}`)
    .join(" · ");
}

export function mapMonitor(accountId: string, site: DatadogSite, m: DdMonitor): ResourceInstance {
  const id = String(m.id ?? "");
  const silenced = m.options?.silenced ?? {};
  const muted = Object.keys(silenced).length > 0 || (m.matching_downtimes ?? []).length > 0;
  return instance(
    accountId,
    "monitor",
    id,
    m.name ?? id,
    {
      name: m.name ?? "",
      message: m.message ?? "",
      priority: typeof m.priority === "number" ? String(m.priority) : "",
      tags: join(m.tags),
      type: m.type,
      query: m.query,
      overallState: m.overall_state,
      muted,
      thresholds: describeThresholds(m.options?.thresholds),
      creator: m.creator?.email ?? m.creator?.name,
      createdAt: m.created,
      modifiedAt: m.modified,
      monitorId: id,
      // Kept raw for the Terraform export and the metrics threshold line.
      thresholdsJson: m.options?.thresholds ? JSON.stringify(m.options.thresholds) : undefined,
    },
    { monitorId: id, url: `${site.appUrl}/monitors/${encodeURIComponent(id)}` },
  );
}

export function mapDowntime(
  accountId: string,
  d: DdDowntime,
  monitorNames: Map<string, string>,
): ResourceInstance {
  const id = d.id ?? "";
  const a = d.attributes ?? {};
  const monitorId =
    a.monitor_identifier?.monitor_id !== undefined
      ? String(a.monitor_identifier.monitor_id)
      : d.relationships?.monitor?.data?.id !== undefined
        ? String(d.relationships.monitor.data.id)
        : "";
  const monitorTags = join(a.monitor_identifier?.monitor_tags);
  const monitorName = monitorId
    ? (monitorNames.get(monitorId) ?? `Monitor ${monitorId}`)
    : monitorTags
      ? `Monitors tagged ${monitorTags}`
      : "";
  const start = a.schedule?.current_downtime?.start ?? a.schedule?.start ?? undefined;
  const end = a.schedule?.current_downtime?.end ?? a.schedule?.end ?? undefined;
  const label = [monitorName || "All monitors", a.scope && a.scope !== "*" ? a.scope : ""]
    .filter(Boolean)
    .join(" · ");
  return instance(
    accountId,
    "downtime",
    id,
    label,
    {
      scope: a.scope ?? "*",
      message: a.message ?? "",
      monitorName,
      monitorId,
      status: a.status,
      start: start ?? undefined,
      end: end ?? undefined,
      createdAt: a.created,
    },
    { downtimeId: id },
  );
}

export function mapDashboard(
  accountId: string,
  site: DatadogSite,
  d: DdDashboardSummary,
): ResourceInstance {
  const id = d.id ?? "";
  const url = d.url ? `${site.appUrl}${d.url}` : `${site.appUrl}/dashboard/${id}`;
  return instance(
    accountId,
    "dashboard",
    id,
    d.title ?? id,
    {
      title: d.title ?? "",
      description: d.description ?? "",
      layoutType: d.layout_type,
      author: d.author_handle,
      readOnly: d.is_read_only,
      url,
      createdAt: d.created_at,
      modifiedAt: d.modified_at,
    },
    { dashboardId: id, url },
  );
}

export function mapSlo(accountId: string, site: DatadogSite, s: DdSlo): ResourceInstance {
  const id = s.id ?? "";
  const primary = s.thresholds?.[0];
  return instance(
    accountId,
    "slo",
    id,
    s.name ?? id,
    {
      name: s.name ?? "",
      description: s.description ?? "",
      type: s.type,
      target: s.target_threshold ?? primary?.target,
      warning: s.warning_threshold ?? primary?.warning,
      timeframe: s.timeframe ?? primary?.timeframe,
      tags: join(s.tags),
      monitorIds: join(s.monitor_ids),
      creator: s.creator?.email ?? s.creator?.name,
      createdAt: epochToIso(s.created_at),
    },
    { sloId: id, url: `${site.appUrl}/slo?slo_id=${encodeURIComponent(id)}` },
  );
}

export function mapSyntheticsTest(
  accountId: string,
  site: DatadogSite,
  t: DdSyntheticsTest,
): ResourceInstance {
  const id = t.public_id ?? "";
  const req = t.config?.request;
  const target = req?.url ?? (req?.host ? `${req.host}${req.port ? `:${req.port}` : ""}` : "");
  return instance(
    accountId,
    "synthetics-test",
    id,
    t.name ?? id,
    {
      name: t.name ?? "",
      type: t.type,
      subtype: t.subtype,
      status: t.status,
      target,
      locations: join(t.locations),
      tags: join(t.tags),
      monitorId: t.monitor_id !== undefined ? String(t.monitor_id) : undefined,
      creator: t.creator?.email ?? t.creator?.name,
    },
    {
      publicId: id,
      url: `${site.appUrl}/synthetics/details/${encodeURIComponent(id)}`,
    },
  );
}

export function mapHost(accountId: string, h: DdHost): ResourceInstance {
  const name = h.host_name ?? h.name ?? String(h.id ?? "");
  const round = (n: number | undefined) =>
    typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
  return instance(
    accountId,
    "host",
    name,
    name,
    {
      hostName: name,
      up: h.up,
      muted: h.is_muted,
      agentVersion: h.meta?.agent_version,
      platform: h.meta?.platform,
      cpuCores: h.meta?.cpuCores,
      cpu: round(h.metrics?.cpu),
      iowait: round(h.metrics?.iowait),
      load: round(h.metrics?.load),
      apps: join(h.apps),
      sources: join(h.sources),
      aliases: join(h.aliases),
      lastReportedAt: epochToIso(h.last_reported_time),
    },
    { hostName: name },
  );
}

export function mapUser(
  accountId: string,
  u: DdUser,
  roleNames: Map<string, string>,
): ResourceInstance {
  const id = u.id ?? "";
  const a = u.attributes ?? {};
  const roles = (u.relationships?.roles?.data ?? [])
    .map((r) => (r.id ? (roleNames.get(r.id) ?? r.id) : ""))
    .filter(Boolean);
  return instance(
    accountId,
    "user",
    id,
    a.name || a.email || a.handle || id,
    {
      name: a.name ?? "",
      email: a.email,
      handle: a.handle,
      status: a.status,
      roles: roles.join(", "),
      title: a.title ?? "",
      mfaEnabled: a.mfa_enabled,
      serviceAccount: a.service_account,
      disabled: a.disabled,
      lastLoginAt: a.last_login_time ?? undefined,
      createdAt: a.created_at,
    },
    { userId: id, email: a.email },
  );
}

/** id → "name <email>" lookup over a JSON:API `included` array of users. */
export function includedUsers(included: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of included as DdIncluded[]) {
    if (raw?.type !== "users" || raw.id === undefined) continue;
    const a = raw.attributes ?? {};
    out.set(String(raw.id), a.email || a.name || a.handle || String(raw.id));
  }
  return out;
}

/** id → name lookup over a JSON:API `included` array of roles. */
export function includedRoles(included: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of included as DdIncluded[]) {
    if (raw?.type !== "roles" || raw.id === undefined) continue;
    out.set(String(raw.id), raw.attributes?.name ?? String(raw.id));
  }
  return out;
}

export function mapApiKey(
  accountId: string,
  k: DdApiKey,
  users: Map<string, string>,
): ResourceInstance {
  const id = k.id ?? "";
  const a = k.attributes ?? {};
  const creatorId = k.relationships?.created_by?.data?.id;
  return instance(
    accountId,
    "api-key",
    id,
    a.name || `…${a.last4 ?? id}`,
    {
      name: a.name ?? "",
      last4: a.last4,
      category: a.category,
      remoteConfig: a.remote_config_read_enabled,
      createdBy: creatorId ? (users.get(creatorId) ?? creatorId) : undefined,
      createdAt: a.created_at,
      lastUsedAt: a.date_last_used ?? undefined,
    },
    { keyId: id },
  );
}

export function mapApplicationKey(
  accountId: string,
  k: DdApplicationKey,
  users: Map<string, string>,
): ResourceInstance {
  const id = k.id ?? "";
  const a = k.attributes ?? {};
  const ownerId = k.relationships?.owned_by?.data?.id;
  return instance(
    accountId,
    "application-key",
    id,
    a.name || `…${a.last4 ?? id}`,
    {
      name: a.name ?? "",
      last4: a.last4,
      owner: ownerId ? (users.get(ownerId) ?? ownerId) : undefined,
      // Null scopes means unscoped: the key carries all of its owner's permissions.
      scopes: a.scopes && a.scopes.length > 0 ? a.scopes.join(", ") : "All (unscoped)",
      createdAt: a.created_at,
      lastUsedAt: a.last_used_at ?? undefined,
    },
    { keyId: id },
  );
}

export interface OrgRow {
  publicId: string;
  name: string;
  region?: string;
  monthToDate?: number;
  projected?: number;
  plan?: string;
  createdAt?: string;
}

export function mapOrganization(accountId: string, org: OrgRow): ResourceInstance {
  const id = org.publicId || org.name;
  return instance(
    accountId,
    "organization",
    id,
    org.name || id,
    {
      name: org.name,
      publicId: org.publicId,
      region: org.region,
      monthToDate: org.monthToDate,
      projectedCost: org.projected,
      plan: org.plan,
      createdAt: org.createdAt,
    },
    { publicId: org.publicId },
  );
}
