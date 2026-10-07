import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { JsonApiItem } from "./api.js";

export const PLUGIN_ID = "better-stack";

export function resourceIdFor(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

type Value = string | number | boolean | null | undefined;
type Attrs = Record<string, unknown>;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, Value>,
  extra: { parentResourceId?: string; resolvedOutputs?: Record<string, string> } = {},
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  const now = new Date().toISOString();
  return {
    id: resourceIdFor(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: extra.resolvedOutputs ?? {},
    secretStates: [],
    externalId,
    ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

const s = (v: unknown): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : String(v);
const n = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const b = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export function mapMonitor(accountId: string, m: JsonApiItem<Attrs>): ResourceInstance {
  const a = m.attributes ?? {};
  const url = s(a["url"]);
  return instance(
    accountId,
    "monitor",
    m.id,
    s(a["pronounceable_name"]) ?? url ?? m.id,
    {
      name: s(a["pronounceable_name"]),
      url,
      monitorType: s(a["monitor_type"]),
      checkFrequency: n(a["check_frequency"]),
      requestTimeout: n(a["request_timeout"]),
      requiredKeyword: s(a["required_keyword"]),
      verifySsl: b(a["verify_ssl"]),
      confirmationPeriod: n(a["confirmation_period"]),
      recoveryPeriod: n(a["recovery_period"]),
      status: s(a["status"]),
      paused: a["status"] === "paused" || Boolean(a["paused_at"]),
      regions: Array.isArray(a["regions"]) ? (a["regions"] as string[]).join(", ") : undefined,
      lastCheckedAt: s(a["last_checked_at"]),
      policyId: s(a["policy_id"]),
      monitorGroupId: s(a["monitor_group_id"]),
      team: s(a["team_name"]),
      createdAt: s(a["created_at"]),
    },
    { resolvedOutputs: { monitorId: m.id, ...(url ? { url } : {}) } },
  );
}

export function mapGroup(
  accountId: string,
  typeId: string,
  g: JsonApiItem<Attrs>,
): ResourceInstance {
  const a = g.attributes ?? {};
  return instance(accountId, typeId, g.id, s(a["name"]) ?? g.id, {
    name: s(a["name"]),
    paused: Boolean(a["paused"]),
    team: s(a["team_name"]),
  });
}

export function mapHeartbeat(accountId: string, h: JsonApiItem<Attrs>): ResourceInstance {
  const a = h.attributes ?? {};
  const url = s(a["url"]);
  return instance(
    accountId,
    "heartbeat",
    h.id,
    s(a["name"]) ?? h.id,
    {
      name: s(a["name"]),
      period: n(a["period"]),
      grace: n(a["grace"]),
      status: s(a["status"]),
      paused: a["status"] === "paused" || Boolean(a["paused_at"]),
      heartbeatGroupId: s(a["heartbeat_group_id"]),
      team: s(a["team_name"]),
      createdAt: s(a["created_at"]),
    },
    { resolvedOutputs: url ? { pingUrl: url } : {} },
  );
}

export function statusPageUrl(a: Attrs): string | undefined {
  const custom = s(a["custom_domain"]);
  if (custom) return `https://${custom}`;
  const sub = s(a["subdomain"]);
  return sub ? `https://${sub}.betteruptime.com` : undefined;
}

export function mapStatusPage(accountId: string, p: JsonApiItem<Attrs>): ResourceInstance {
  const a = p.attributes ?? {};
  const url = statusPageUrl(a);
  return instance(
    accountId,
    "status-page",
    p.id,
    s(a["company_name"]) ?? s(a["subdomain"]) ?? p.id,
    {
      companyName: s(a["company_name"]),
      subdomain: s(a["subdomain"]),
      customDomain: s(a["custom_domain"]),
      companyUrl: s(a["company_url"]),
      timezone: s(a["timezone"]),
      history: n(a["history"]),
      published: b(a["published"]),
      aggregateState: s(a["aggregate_state"]),
      url,
      passwordEnabled: b(a["password_enabled"]),
      subscribable: b(a["subscribable"]),
      createdAt: s(a["created_at"]),
    },
    { resolvedOutputs: url ? { url } : {} },
  );
}

export function mapSection(
  accountId: string,
  pageId: string,
  x: JsonApiItem<Attrs>,
): ResourceInstance {
  const a = x.attributes ?? {};
  return instance(
    accountId,
    "status-page-section",
    `${pageId}/${x.id}`,
    s(a["name"]) ?? "Section",
    { name: s(a["name"]), position: n(a["position"]), statusPageId: pageId },
    { parentResourceId: resourceIdFor(accountId, "status-page", pageId) },
  );
}

export function mapPageResource(
  accountId: string,
  pageId: string,
  x: JsonApiItem<Attrs>,
): ResourceInstance {
  const a = x.attributes ?? {};
  const availability = n(a["availability"]);
  return instance(
    accountId,
    "status-page-resource",
    `${pageId}/${x.id}`,
    s(a["public_name"]) ?? x.id,
    {
      publicName: s(a["public_name"]),
      explanation: s(a["explanation"]),
      widgetType: s(a["widget_type"]),
      resourceType: s(a["resource_type"]),
      resourceId: s(a["resource_id"]),
      sectionId: s(a["status_page_section_id"]),
      status: s(a["status"]),
      availability:
        availability !== undefined ? Math.round(availability * 100_000) / 1000 : undefined,
      statusPageId: pageId,
    },
    { parentResourceId: resourceIdFor(accountId, "status-page", pageId) },
  );
}

export function mapReport(
  accountId: string,
  pageId: string,
  x: JsonApiItem<Attrs>,
): ResourceInstance {
  const a = x.attributes ?? {};
  return instance(
    accountId,
    "status-report",
    `${pageId}/${x.id}`,
    s(a["title"]) ?? x.id,
    {
      title: s(a["title"]),
      reportType: s(a["report_type"]),
      aggregateState: s(a["aggregate_state"]),
      startsAt: s(a["starts_at"]),
      endsAt: s(a["ends_at"]),
      statusPageId: pageId,
    },
    { parentResourceId: resourceIdFor(accountId, "status-page", pageId) },
  );
}

export function mapOnCall(
  accountId: string,
  c: JsonApiItem<Attrs>,
  included: JsonApiItem[],
): ResourceInstance {
  const a = c.attributes ?? {};
  const users =
    (c.relationships?.["on_call_users"]?.data as
      Array<{ id?: string; meta?: { email?: string } }> | undefined) ?? [];
  const names = users.map((u) => {
    const inc = included.find((i) => i.type === "user" && i.id === u.id)?.attributes as
      Attrs | undefined;
    const full = [s(inc?.["first_name"]), s(inc?.["last_name"])].filter(Boolean).join(" ");
    return full || u.meta?.email || u.id || "";
  });
  const name = s(a["name"]) ?? (a["default_calendar"] ? "Primary calendar" : c.id);
  return instance(accountId, "on-call-calendar", c.id, name, {
    name: s(a["name"]) ?? name,
    onCallNow: names.filter(Boolean).join(", ") || "Nobody",
    defaultCalendar: b(a["default_calendar"]),
    team: s(a["team_name"]),
  });
}

export function mapIncident(accountId: string, i: JsonApiItem<Attrs>): ResourceInstance {
  const a = i.attributes ?? {};
  const rel = (k: string) => (i.relationships?.[k]?.data as { id?: string } | null | undefined)?.id;
  const status = a["resolved_at"]
    ? "Resolved"
    : a["acknowledged_at"]
      ? "Acknowledged"
      : (s(a["status"]) ?? "Started");
  return instance(accountId, "incident", i.id, s(a["name"]) ?? i.id, {
    name: s(a["name"]),
    cause: s(a["cause"]),
    status,
    startedAt: s(a["started_at"]),
    acknowledgedAt: s(a["acknowledged_at"]),
    acknowledgedBy: s(a["acknowledged_by"]),
    resolvedAt: s(a["resolved_at"]),
    resolvedBy: s(a["resolved_by"]),
    monitorId: rel("monitor"),
    heartbeatId: rel("heartbeat"),
    url: s(a["url"]),
    team: s(a["team_name"]),
  });
}

export function describeSteps(steps: unknown): string {
  if (!Array.isArray(steps)) return "";
  return steps
    .map((st: Attrs, idx) => {
      const wait = n(st["wait_before"]) ?? 0;
      const members = Array.isArray(st["step_members"])
        ? (st["step_members"] as Attrs[]).map((m) => String(m["type"] ?? "")).join(" + ")
        : String(st["action_type"] ?? st["type"] ?? "");
      return `${idx + 1}. after ${Math.round(wait / 60)}m: ${members}`;
    })
    .join("; ");
}

export function mapPolicy(accountId: string, p: JsonApiItem<Attrs>): ResourceInstance {
  const a = p.attributes ?? {};
  return instance(
    accountId,
    "escalation-policy",
    p.id,
    s(a["name"]) ?? p.id,
    {
      name: s(a["name"]),
      repeatCount: n(a["repeat_count"]),
      repeatDelay: n(a["repeat_delay"]),
      steps: describeSteps(a["steps"]),
      team: s(a["team_name"]),
    },
    { resolvedOutputs: { policyId: p.id } },
  );
}

export function mapSource(accountId: string, x: JsonApiItem<Attrs>): ResourceInstance {
  const a = x.attributes ?? {};
  const host = s(a["ingesting_host"]);
  return instance(
    accountId,
    "source",
    x.id,
    s(a["name"]) ?? x.id,
    {
      name: s(a["name"]),
      logsRetention: n(a["logs_retention"]),
      metricsRetention: n(a["metrics_retention"]),
      platform: s(a["platform"]),
      ingestingPaused: Boolean(a["ingesting_paused"]),
      dataRegion: s(a["data_region"]),
      tableName: s(a["table_name"]),
      sourceGroupId: s(a["source_group_id"]),
      teamId: s(a["team_id"]),
      team: s(a["team_name"]),
      createdAt: s(a["created_at"]),
    },
    { resolvedOutputs: host ? { ingestingHost: host } : {} },
  );
}

export function mapSimple(
  accountId: string,
  typeId: string,
  x: JsonApiItem<Attrs>,
): ResourceInstance {
  const a = x.attributes ?? {};
  return instance(accountId, typeId, x.id, s(a["name"]) ?? x.id, {
    name: s(a["name"]),
    team: s(a["team_name"]),
  });
}

export function mapDashboard(accountId: string, x: JsonApiItem<Attrs>): ResourceInstance {
  const a = x.attributes ?? {};
  return instance(accountId, "dashboard", x.id, s(a["name"]) ?? x.id, {
    name: s(a["name"]),
    refreshInterval: n(a["refresh_interval"]),
    dateRangeFrom: s(a["date_range_from"]),
    dateRangeTo: s(a["date_range_to"]),
    dashboardGroupId: s(a["dashboard_group_id"]),
    team: s(a["team_name"]),
    updatedAt: s(a["updated_at"]),
  });
}

export function mapAlert(accountId: string, x: JsonApiItem<Attrs>): ResourceInstance {
  const a = x.attributes ?? {};
  return instance(accountId, "telemetry-alert", x.id, s(a["name"]) ?? x.id, {
    name: s(a["name"]),
    operator: s(a["operator"]),
    value: n(a["value"]),
    checkPeriod: n(a["check_period"]),
    alertType: s(a["alert_type"]),
  });
}

export function mapMember(accountId: string, x: JsonApiItem<Attrs>): ResourceInstance {
  const a = x.attributes ?? {};
  const name =
    [s(a["first_name"]), s(a["last_name"])].filter(Boolean).join(" ") || s(a["email"]) || x.id;
  return instance(
    accountId,
    "team-member",
    x.id,
    name,
    {
      name,
      email: s(a["email"]),
      role: s(a["role"]) ?? s(a["role_name"]),
      team: s(a["team_name"]),
    },
    { resolvedOutputs: s(a["email"]) ? { email: String(a["email"]) } : {} },
  );
}
