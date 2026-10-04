import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import type { CostAttributionReport } from "./attribution.js";
import type { DatadogOrgCostSummary } from "./cost-data.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  USAGE_METRICS_WINDOW_MS,
  chartableMonitorQuery,
} from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const COST_SUMMARY_KEY = "__costSummary__";
export const ATTRIBUTION_KEY = "__attribution__";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function openInDatadog(url: string): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Datadog", action: { type: "open-url", url } }]
    : [];
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function monitorStatus(state: string): ResourceStatus {
  switch (state) {
    case "OK":
      return "healthy";
    case "Warn":
      return "degraded";
    case "Alert":
      return "error";
    case "No Data":
    case "Unknown":
    case "Skipped":
    case "Ignored":
      return "unknown";
    default:
      return "info";
  }
}

function renderOrganization(r: ResourceInstance, appUrl: string): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<DatadogOrgCostSummary>(r.resolvedOutputs[COST_SUMMARY_KEY]);
  const attribution = parseJson<CostAttributionReport>(r.resolvedOutputs[ATTRIBUTION_KEY]);
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"] ?? r.displayName],
        ["Public ID", f["publicId"], true],
        ["Region", f["region"]],
        ["Plan", f["plan"]],
        ["Created", f["createdAt"]],
      ]),
    ]),
    section("Cost this month", [
      kv([
        ["Month to date", usd(summary?.monthToDate ?? f["monthToDate"])],
        ["Projected month end", usd(summary?.projected ?? f["projectedCost"])],
      ]),
      ...(summary?.projected === undefined && f["projectedCost"] === undefined
        ? [
            {
              kind: "text" as const,
              variant: "muted" as const,
              content:
                "Datadog publishes the month-end projection from around the 12th of the month, and estimated cost lags by up to 72 hours.",
            },
          ]
        : []),
      ...(summary && summary.products.length > 0
        ? [
            {
              kind: "table" as const,
              columns: [
                { key: "product", label: "Product", width: "wide" as const },
                { key: "mtd", label: "Month to date" },
                { key: "projected", label: "Projected" },
              ],
              rows: summary.products.map<TableRow>((p) => ({
                cells: {
                  product: p.product,
                  mtd: usd(p.monthToDate),
                  projected: usd(p.projected),
                },
              })),
            },
          ]
        : []),
    ]),
  ];
  if (attribution) {
    sections.push(
      section(`Cost attribution by tag (${attribution.month})`, [
        ...(attribution.tagKeys.length === 0
          ? [
              {
                kind: "text" as const,
                variant: "muted" as const,
                content:
                  "No tag keys are configured for usage attribution, so cost is not broken down by tag. Choose up to three tag keys in Datadog under Plan & Usage, Usage Attribution; the breakdown appears here from the next finalised month.",
              },
            ]
          : [
              {
                kind: "text" as const,
                variant: "muted" as const,
                content: `Broken down by ${attribution.tagKeys.join(", ")}, as configured for usage attribution in Datadog.${attribution.truncated ? " Showing the first pages only; open Datadog for the full report." : ""}`,
              },
            ]),
        ...(attribution.rows.length > 0
          ? [
              {
                kind: "table" as const,
                columns: [
                  { key: "tags", label: "Tags", width: "wide" as const },
                  { key: "org", label: "Organization" },
                  { key: "cost", label: "Cost" },
                  { key: "top", label: "Largest product" },
                ],
                rows: attribution.rows.slice(0, 50).map<TableRow>((row) => ({
                  cells: {
                    tags: row.tags,
                    org: row.orgName,
                    cost: usd(row.totalCost),
                    top: row.topProduct,
                  },
                })),
              },
            ]
          : []),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Organization", str(f["region"]).toUpperCase()),
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: openInDatadog(`${appUrl}/billing/usage`),
  };
}

function renderMonitor(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const muted = f["muted"] === true;
  const state = str(f["overallState"]);
  const chartable = chartableMonitorQuery(str(f["type"]), str(f["query"]));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Monitor", f["type"]),
    status: {
      kind: "status-dot",
      status: muted ? "unknown" : monitorStatus(state),
      label: muted ? `${state || "Muted"} (muted)` : state || "Monitor",
    },
    sections: [
      section("Monitor", [
        kv([
          ["Name", f["name"]],
          ["Type", f["type"]],
          ["State", state],
          ["Muted", muted],
          ["Priority", f["priority"] ? `P${str(f["priority"])}` : ""],
          ["Thresholds", f["thresholds"]],
          ["Tags", f["tags"]],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
          ["Modified", f["modifiedAt"]],
          ["Monitor ID", f["monitorId"], true],
        ]),
      ]),
      section("Query", [
        { kind: "text", variant: "mono", content: str(f["query"]), copyable: true },
      ]),
      ...(f["message"]
        ? [section("Notification message", [{ kind: "text", content: str(f["message"]) }])]
        : []),
      ...(!chartable && f["query"]
        ? [
            section("Metrics", [
              {
                kind: "text",
                variant: "muted",
                content:
                  "The Metrics tab charts metric and query alert monitors; this monitor type has no metric query to plot.",
              },
            ]),
          ]
        : []),
    ],
    headerActions: [
      ...(muted
        ? [
            {
              kind: "action" as const,
              label: "Unmute",
              action: {
                type: "plugin-action" as const,
                actionId: "unmute",
                successMessage: "Monitor unmuted.",
              },
            },
          ]
        : [
            {
              kind: "action" as const,
              label: "Mute 1 hour",
              action: {
                type: "plugin-action" as const,
                actionId: "mute-1h",
                successMessage: "Monitor muted for an hour.",
              },
            },
            {
              kind: "action" as const,
              label: "Mute 1 day",
              action: {
                type: "plugin-action" as const,
                actionId: "mute-1d",
                successMessage: "Monitor muted for a day.",
              },
            },
            {
              kind: "action" as const,
              label: "Mute until unmuted",
              action: {
                type: "plugin-action" as const,
                actionId: "mute",
                confirmMessage:
                  "Mute this monitor with no end time? It stays silent until someone unmutes it.",
                successMessage: "Monitor muted.",
              },
            },
          ]),
      ...openInDatadog(r.resolvedOutputs["url"] ?? ""),
    ],
  };
}

function renderDowntime(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Downtime", status),
    status: {
      kind: "status-dot",
      status: status === "active" ? "degraded" : status === "scheduled" ? "provisioning" : "info",
      label: status || "Downtime",
    },
    sections: [
      section("Downtime", [
        kv([
          ["Monitor", f["monitorName"] || "All monitors in scope"],
          ["Scope", f["scope"]],
          ["Status", status],
          ["Starts", f["start"]],
          ["Ends", f["end"] || "No end (until canceled)"],
          ["Message", f["message"]],
          ["Created", f["createdAt"]],
          ["Downtime ID", r.externalId, true],
        ]),
      ]),
    ],
  };
}

function renderDashboard(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Dashboard", f["layoutType"]),
    status: { kind: "status-dot", status: "info", label: "Dashboard" },
    sections: [
      section("Dashboard", [
        kv([
          ["Title", f["title"]],
          ["Description", f["description"]],
          ["Layout", f["layoutType"]],
          ["Author", f["author"]],
          ["Read-only", f["readOnly"]],
          ["Created", f["createdAt"]],
          ["Modified", f["modifiedAt"]],
          ["Dashboard ID", r.externalId, true],
        ]),
      ]),
    ],
    headerActions: openInDatadog(str(f["url"])),
  };
}

function renderSlo(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("SLO", f["type"], f["timeframe"]),
    status: { kind: "status-dot", status: "info", label: "SLO" },
    sections: [
      section("Objective", [
        kv([
          ["Name", f["name"]],
          ["Type", f["type"]],
          ["Target", f["target"] !== undefined ? `${str(f["target"])}%` : ""],
          ["Warning", f["warning"] !== undefined ? `${str(f["warning"])}%` : ""],
          ["Timeframe", f["timeframe"]],
          ["Monitors", f["monitorIds"]],
          ["Tags", f["tags"]],
          ["Created by", f["creator"]],
          ["Created", f["createdAt"]],
          ["SLO ID", r.externalId, true],
        ]),
      ]),
      ...(f["description"]
        ? [section("Description", [{ kind: "text", content: str(f["description"]) }])]
        : []),
    ],
    headerActions: openInDatadog(r.resolvedOutputs["url"] ?? ""),
  };
}

function renderSyntheticsTest(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const paused = str(f["status"]) === "paused";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Synthetic test", f["type"], f["subtype"]),
    status: {
      kind: "status-dot",
      status: paused ? "unknown" : "healthy",
      label: paused ? "Paused" : "Live",
    },
    sections: [
      section("Test", [
        kv([
          ["Name", f["name"]],
          ["Type", joinSubtitle(f["type"], f["subtype"])],
          ["Status", f["status"]],
          ["Target", f["target"], true],
          ["Locations", f["locations"]],
          ["Tags", f["tags"]],
          ["Monitor ID", f["monitorId"]],
          ["Created by", f["creator"]],
          ["Public ID", r.externalId, true],
        ]),
      ]),
    ],
    headerActions: [
      {
        kind: "action",
        label: "Run now",
        action: {
          type: "plugin-action",
          actionId: "run",
          successMessage: "Test triggered from every configured location.",
        },
      },
      paused
        ? {
            kind: "action",
            label: "Resume",
            action: { type: "plugin-action", actionId: "resume", successMessage: "Test resumed." },
          }
        : {
            kind: "action",
            label: "Pause",
            action: {
              type: "plugin-action",
              actionId: "pause",
              confirmMessage: "Pause this test? It stops running and alerting until resumed.",
              successMessage: "Test paused.",
            },
          },
      ...openInDatadog(r.resolvedOutputs["url"] ?? ""),
    ],
  };
}

function renderHost(r: ResourceInstance, appUrl: string): DetailViewSchema {
  const f = r.fields;
  const up = f["up"] !== false;
  const muted = f["muted"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle(
      "Host",
      f["platform"],
      f["agentVersion"] ? `Agent ${str(f["agentVersion"])}` : "",
    ),
    status: {
      kind: "status-dot",
      status: up ? (muted ? "unknown" : "healthy") : "error",
      label: up ? (muted ? "Up (muted)" : "Up") : "Not reporting",
    },
    sections: [
      section("Host", [
        kv([
          ["Host name", f["hostName"], true],
          ["Reporting", up],
          ["Muted", muted],
          ["Agent version", f["agentVersion"]],
          ["Platform", f["platform"]],
          ["CPU cores", f["cpuCores"]],
          ["CPU", f["cpu"] !== undefined ? `${str(f["cpu"])}%` : ""],
          ["I/O wait", f["iowait"] !== undefined ? `${str(f["iowait"])}%` : ""],
          ["Load (15m)", f["load"]],
          ["Last reported", f["lastReportedAt"]],
        ]),
      ]),
      section("Integrations and sources", [
        kv([
          ["Integrations", f["apps"]],
          ["Sources", f["sources"]],
          ["Aliases", f["aliases"]],
        ]),
      ]),
    ],
    headerActions: [
      muted
        ? {
            kind: "action",
            label: "Unmute",
            action: { type: "plugin-action", actionId: "unmute", successMessage: "Host unmuted." },
          }
        : {
            kind: "action",
            label: "Mute",
            action: {
              type: "plugin-action",
              actionId: "mute",
              confirmMessage: "Mute every monitor notification for this host until it is unmuted?",
              successMessage: "Host muted.",
            },
          },
      ...openInDatadog(`${appUrl}/infrastructure?host=${encodeURIComponent(str(f["hostName"]))}`),
    ],
  };
}

function renderUser(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = f["disabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle(f["serviceAccount"] === true ? "Service account" : "User", f["status"]),
    status: {
      kind: "status-dot",
      status: disabled ? "unknown" : str(f["status"]) === "Pending" ? "provisioning" : "healthy",
      label: str(f["status"]) || (disabled ? "Disabled" : "Active"),
    },
    sections: [
      section("User", [
        kv([
          ["Name", f["name"]],
          ["Email", f["email"], true],
          ["Handle", f["handle"]],
          ["Title", f["title"]],
          ["Status", f["status"]],
          ["Roles", f["roles"]],
          ["MFA", f["mfaEnabled"]],
          ["Service account", f["serviceAccount"]],
          ["Last login", f["lastLoginAt"]],
          ["Created", f["createdAt"]],
          ["User ID", r.externalId, true],
        ]),
      ]),
    ],
    headerActions: disabled
      ? []
      : [
          {
            kind: "action",
            label: "Disable",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "disable",
              confirmMessage:
                "Disable this user? They lose access to Datadog immediately; an admin can re-enable them in Datadog.",
              successMessage: "User disabled.",
            },
          },
        ],
  };
}

function renderKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const isApp = r.resourceTypeId === "application-key";
  return {
    title: r.displayName,
    subtitle: joinSubtitle(
      isApp ? "Application key" : "API key",
      f["last4"] ? `…${str(f["last4"])}` : "",
    ),
    status: {
      kind: "status-dot",
      status: f["lastUsedAt"] ? "healthy" : "info",
      label: f["lastUsedAt"] ? "In use" : "No recorded use",
    },
    sections: [
      section(isApp ? "Application key" : "API key", [
        kv([
          ["Name", f["name"]],
          ["Last 4", f["last4"]],
          ...(isApp
            ? ([
                ["Owner", f["owner"]],
                ["Scopes", f["scopes"]],
              ] as Array<[string, unknown]>)
            : ([
                ["Category", f["category"]],
                ["Remote Configuration", f["remoteConfig"]],
                ["Created by", f["createdBy"]],
              ] as Array<[string, unknown]>)),
          ["Created", f["createdAt"]],
          ["Last used", f["lastUsedAt"]],
          ["Key ID", r.externalId, true],
        ]),
        {
          kind: "text",
          variant: "muted",
          content:
            "Datadog shows a key's secret only when it is created. Deleting a key revokes it at once for everything that uses it.",
        },
      ]),
    ],
  };
}

export function renderDatadogDetail(r: ResourceInstance, appUrl: string): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs = DEFAULT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r, appUrl);
      windowMs = USAGE_METRICS_WINDOW_MS;
      break;
    case "monitor":
      schema = renderMonitor(r);
      break;
    case "downtime":
      schema = renderDowntime(r);
      break;
    case "dashboard":
      schema = renderDashboard(r);
      break;
    case "slo":
      schema = renderSlo(r);
      windowMs = USAGE_METRICS_WINDOW_MS;
      break;
    case "synthetics-test":
      schema = renderSyntheticsTest(r);
      break;
    case "host":
      schema = renderHost(r, appUrl);
      break;
    case "user":
      schema = renderUser(r);
      break;
    case "api-key":
    case "application-key":
      schema = renderKey(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderDatadogSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "organization":
      return item(
        "healthy",
        f["monthToDate"] !== undefined ? usd(f["monthToDate"]) : "Organization",
      );
    case "monitor": {
      const state = str(f["overallState"]);
      return f["muted"] === true
        ? item("unknown", "Muted")
        : item(monitorStatus(state), state || "Monitor");
    }
    case "downtime":
      return item(
        str(f["status"]) === "active" ? "degraded" : "info",
        str(f["status"]) || "Downtime",
      );
    case "synthetics-test":
      return str(f["status"]) === "paused" ? item("unknown", "Paused") : item("healthy", "Live");
    case "host":
      return f["up"] === false
        ? item("error", "Not reporting")
        : item("healthy", str(f["platform"]) || "Up");
    case "user":
      return f["disabled"] === true
        ? item("unknown", "Disabled")
        : item("healthy", str(f["status"]) || "User");
    case "api-key":
    case "application-key":
      return item(f["lastUsedAt"] ? "healthy" : "info", f["last4"] ? `…${str(f["last4"])}` : "Key");
    case "slo":
      return item("info", f["target"] !== undefined ? `${str(f["target"])}%` : "SLO");
    default:
      return item("info", str(r.resourceTypeId));
  }
}
