import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "checkly";

export function resourceIdFor(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

type Value = string | number | boolean | null | undefined;
export type Obj = Record<string, unknown>;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, Value>,
  resolvedOutputs: Record<string, string> = {},
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
    resolvedOutputs,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

const s = (v: unknown): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : String(v);
const n = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const b = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const list = (v: unknown): string | undefined =>
  Array.isArray(v) && v.length > 0 ? v.map(String).join(", ") : undefined;

/** What a check points at, whatever its type. */
export function checkTarget(c: Obj): string | undefined {
  const req = (c["request"] ?? {}) as Obj;
  const hb = (c["heartbeat"] ?? {}) as Obj;
  if (c["checkType"] === "HEARTBEAT") {
    return hb["period"] !== undefined
      ? `every ${String(hb["period"])} ${String(hb["periodUnit"] ?? "")}`.trim()
      : undefined;
  }
  if (req["url"])
    return `${req["method"] && req["method"] !== "GET" ? `${String(req["method"])} ` : ""}${String(req["url"])}`;
  if (req["hostname"])
    return req["port"]
      ? `${String(req["hostname"])}:${String(req["port"])}`
      : String(req["hostname"]);
  if (req["query"]) return `${String(req["query"])} (${String(req["recordType"] ?? "")})`;
  if (c["sslCheckDomain"]) return String(c["sslCheckDomain"]);
  const ssl = (req["sslConfig"] ?? {}) as Obj;
  if (ssl["hostname"]) return String(ssl["hostname"]);
  return undefined;
}

export interface CheckStatus {
  checkId?: string;
  hasFailures?: boolean;
  hasErrors?: boolean;
  isDegraded?: boolean;
  lastRunLocation?: string;
  sslDaysRemaining?: number;
}

export function statusLabel(st: CheckStatus | undefined): string | undefined {
  if (!st) return undefined;
  if (st.hasErrors) return "Error";
  if (st.hasFailures) return "Failing";
  if (st.isDegraded) return "Degraded";
  return "Passing";
}

export function mapCheck(accountId: string, c: Obj, status?: CheckStatus): ResourceInstance {
  const id = String(c["id"] ?? "");
  const hb = (c["heartbeat"] ?? {}) as Obj;
  const pingUrl =
    s(hb["pingUrl"]) ??
    (hb["pingToken"] ? `https://ping.checklyhq.com/${String(hb["pingToken"])}` : undefined);
  const sslDays = n(status?.sslDaysRemaining);
  return instance(
    accountId,
    "check",
    id,
    s(c["name"]) ?? id,
    {
      name: s(c["name"]),
      frequency:
        c["frequency"] === undefined || c["frequency"] === null
          ? undefined
          : String(c["frequency"]),
      tags: list(c["tags"]),
      degradedResponseTime: n(c["degradedResponseTime"]),
      maxResponseTime: n(c["maxResponseTime"]),
      description: s(c["description"]),
      checkType: s(c["checkType"]),
      target: checkTarget(c),
      activated: b(c["activated"]),
      muted: b(c["muted"]),
      status: c["activated"] === false ? "Deactivated" : statusLabel(status),
      locations: list(c["locations"]),
      privateLocations: list(c["privateLocations"]),
      groupId:
        c["groupId"] === undefined || c["groupId"] === null ? undefined : String(c["groupId"]),
      lastRunLocation: s(status?.lastRunLocation),
      sslDaysRemaining: sslDays,
      sslExpiresAt:
        sslDays !== undefined
          ? new Date(Date.now() + sslDays * 86400_000).toISOString().slice(0, 10)
          : undefined,
      runtimeId: s(c["runtimeId"]),
      createdAt: s(c["created_at"]),
      updatedAt: s(c["updated_at"]),
    },
    { checkId: id, ...(pingUrl ? { pingUrl } : {}) },
  );
}

export function mapGroup(accountId: string, g: Obj, checkCount?: number): ResourceInstance {
  const id = String(g["id"] ?? "");
  return instance(
    accountId,
    "check-group",
    id,
    s(g["name"]) ?? id,
    {
      name: s(g["name"]),
      tags: list(g["tags"]),
      concurrency: n(g["concurrency"]),
      activated: b(g["activated"]),
      muted: b(g["muted"]),
      locations: list(g["locations"]),
      checkCount,
      createdAt: s(g["created_at"]),
    },
    { groupId: id },
  );
}

/** Human target of an alert channel; webhook and Slack URLs carry secrets, so only their host. */
export function channelTarget(type: string, config: Obj): string {
  const host = (u: unknown) => {
    try {
      return new URL(String(u)).host;
    } catch {
      return "";
    }
  };
  switch (type) {
    case "EMAIL":
      return String(config["address"] ?? "");
    case "SLACK":
      return String(config["channel"] ?? host(config["url"]));
    case "WEBHOOK":
      return `${String(config["name"] ?? "")}${config["url"] ? ` (${host(config["url"])})` : ""}`.trim();
    case "SMS":
    case "CALL":
      return `${String(config["name"] ?? "")} ${String(config["number"] ?? "")}`.trim();
    case "PAGERDUTY":
      return String(config["serviceName"] ?? config["account"] ?? "");
    case "OPSGENIE":
      return String(config["name"] ?? "");
    default:
      return String(config["name"] ?? "");
  }
}

export function mapChannel(accountId: string, c: Obj): ResourceInstance {
  const id = String(c["id"] ?? "");
  const type = String(c["type"] ?? "");
  const target = channelTarget(type, (c["config"] ?? {}) as Obj);
  return instance(
    accountId,
    "alert-channel",
    id,
    target ? `${target} (${type.toLowerCase()})` : `${type.toLowerCase()} ${id}`,
    {
      sendFailure: b(c["sendFailure"]),
      sendRecovery: b(c["sendRecovery"]),
      sendDegraded: b(c["sendDegraded"]),
      sslExpiry: b(c["sslExpiry"]),
      sslExpiryThreshold: n(c["sslExpiryThreshold"]),
      autoSubscribe: b(c["autoSubscribe"]),
      type,
      target,
      subscriptionCount: Array.isArray(c["subscriptions"]) ? c["subscriptions"].length : undefined,
      createdAt: s(c["created_at"]),
    },
    { channelId: id },
  );
}

export function mapWindow(accountId: string, w: Obj, now = Date.now()): ResourceInstance {
  const id = String(w["id"] ?? "");
  const starts = Date.parse(String(w["startsAt"] ?? ""));
  const ends = Date.parse(String(w["endsAt"] ?? ""));
  return instance(accountId, "maintenance-window", id, s(w["name"]) ?? id, {
    name: s(w["name"]),
    tags: list(w["tags"]),
    description: s(w["description"]),
    startsAt: s(w["startsAt"]),
    endsAt: s(w["endsAt"]),
    repeatUnit: s(w["repeatUnit"]),
    repeatInterval: n(w["repeatInterval"]),
    repeatEndsAt: s(w["repeatEndsAt"]),
    timezone: s(w["timezone"]),
    active:
      !w["repeatUnit"] && Number.isFinite(starts) && Number.isFinite(ends)
        ? starts <= now && now < ends
        : undefined,
  });
}

export function mapPrivateLocation(accountId: string, p: Obj): ResourceInstance {
  const id = String(p["id"] ?? "");
  const agents = (Array.isArray(p["runningAgents"]) ? p["runningAgents"] : []) as Obj[];
  return instance(
    accountId,
    "private-location",
    id,
    s(p["name"]) ?? id,
    {
      name: s(p["name"]),
      proxyUrl: s(p["proxyUrl"]),
      slugName: s(p["slugName"]),
      agentCount: n(p["agentCount"]),
      agentVersions:
        agents
          .map((a) => `${String(a["version"] ?? "?")} x${String(a["count"] ?? 0)}`)
          .join(", ") || undefined,
      outdatedAgents: agents
        .filter((a) => a["isOutdated"] === true)
        .reduce((sum, a) => sum + (n(a["count"]) ?? 0), 0),
      lastSeen: s(p["lastSeen"]),
      keyCount: Array.isArray(p["keys"]) ? p["keys"].length : undefined,
    },
    s(p["slugName"]) ? { slugName: String(p["slugName"]) } : {},
  );
}

export function dashboardUrl(d: Obj): string | undefined {
  if (d["customDomain"]) return `https://${String(d["customDomain"])}`;
  if (d["customUrl"]) return `https://${String(d["customUrl"])}.checklyhq.com`;
  return undefined;
}

export function mapDashboard(accountId: string, d: Obj): ResourceInstance {
  const id = String(d["dashboardId"] ?? d["id"] ?? "");
  const url = dashboardUrl(d);
  return instance(
    accountId,
    "dashboard",
    id,
    s(d["header"]) ?? s(d["customUrl"]) ?? id,
    {
      header: s(d["header"]),
      description: s(d["description"]),
      customUrl: s(d["customUrl"]),
      customDomain: s(d["customDomain"]),
      tags: list(d["tags"]),
      refreshRate:
        d["refreshRate"] === undefined || d["refreshRate"] === null
          ? undefined
          : String(d["refreshRate"]),
      isPrivate: b(d["isPrivate"]),
      url,
    },
    url ? { url } : {},
  );
}

export function mapStatusPage(accountId: string, p: Obj): ResourceInstance {
  const id = String(p["id"] ?? "");
  const url = s(p["customDomain"]) ? `https://${String(p["customDomain"])}` : s(p["url"]);
  return instance(
    accountId,
    "status-page",
    id,
    s(p["name"]) ?? id,
    {
      name: s(p["name"]),
      description: s(p["description"]),
      url,
      customDomain: s(p["customDomain"]),
      isPrivate: b(p["isPrivate"]),
      createdAt: s(p["created_at"]),
    },
    url ? { url } : {},
  );
}

export function mapVariable(accountId: string, v: Obj): ResourceInstance {
  const key = String(v["key"] ?? "");
  const hidden = v["secret"] === true || v["locked"] === true;
  return instance(accountId, "variable", key, key, {
    key,
    locked: b(v["locked"]),
    secret: b(v["secret"]),
    visibleValue: hidden ? undefined : s(v["value"]),
  });
}
