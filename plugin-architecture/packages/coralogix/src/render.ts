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
import { withMetricsCapability } from "@infrawrench/plugin-base";
import {
  ALERT_METRICS_WINDOW_MS,
  POLICY_METRICS_WINDOW_MS,
  TEAM_METRICS_WINDOW_MS,
} from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes the team's usage summary for the renderer. */
export const TEAM_SUMMARY_KEY = "__teamSummary__";

export interface UsageBreakdownRow {
  label: string;
  units: number;
  gb: number;
  cost: number;
}

export interface TeamLimit {
  name: string;
  used: number;
  limit: number;
}

export interface TeamSummary {
  from: string;
  through: string;
  unitPrice: number;
  totals: { units: number; gb: number; cost: number };
  today: { units: number; gb: number };
  byPillar: UsageBreakdownRow[];
  byPriority: UsageBreakdownRow[];
  dailyQuota?: number;
  limits: TeamLimit[];
  usageMetricsExport?: boolean;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function amount(value: unknown, digits = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
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

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function action(
  label: string,
  actionId: string,
  successMessage: string,
  opts: { confirmMessage?: string; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(opts.confirmMessage ? { confirmMessage: opts.confirmMessage } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function breakdownTable(first: string, rows: UsageBreakdownRow[]): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "label", label: first, width: "wide" },
      { key: "units", label: "Units" },
      { key: "gb", label: "GB" },
      { key: "cost", label: "Estimated cost" },
    ],
    rows: rows.map<TableRow>((r) => ({
      cells: {
        label: r.label,
        units: amount(r.units),
        gb: r.gb > 0 ? amount(r.gb) : "",
        cost: usd(r.cost),
      },
    })),
  };
}

function renderTeam(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const s = parseJson<TeamSummary>(r.resolvedOutputs[TEAM_SUMMARY_KEY]);
  const quota =
    s?.dailyQuota ?? (typeof f["dailyQuota"] === "number" ? f["dailyQuota"] : undefined);
  const todayUnits = s?.today.units ?? f["todayUnits"];
  const quotaUse =
    quota && typeof todayUnits === "number" ? `${amount((todayUnits / quota) * 100, 1)}%` : "";
  const sections: SectionNode[] = [
    section("Team", [
      kv([
        ["Name", f["name"] ?? r.displayName],
        ["Region", f["region"]],
        ["Team ID", f["teamId"], true],
        ["Retention (days)", f["retentionDays"]],
      ]),
    ]),
    section("Daily quota", [
      kv([
        ["Daily quota", quota !== undefined ? `${amount(quota)} units` : ""],
        ["Used today", typeof todayUnits === "number" ? `${amount(todayUnits)} units` : ""],
        ["Share of quota used today", quotaUse],
      ]),
      ...(quota === undefined
        ? [
            muted(
              "The daily quota is read from Coralogix's team list, which an API key may not be allowed to see. Usage still appears below.",
            ),
          ]
        : []),
    ]),
  ];
  if (s) {
    sections.push(
      section(`Usage this month (${s.from} to ${s.through})`, [
        kv([
          ["Units", amount(s.totals.units)],
          ["GB processed", amount(s.totals.gb)],
          ["Estimated cost", usd(s.totals.cost)],
          ["Price per unit", usd(s.unitPrice)],
        ]),
        ...(s.byPillar.length > 0 ? [breakdownTable("Pillar", s.byPillar)] : []),
        ...(s.byPriority.length > 0 ? [breakdownTable("TCO priority", s.byPriority)] : []),
        muted(
          "Cost is units multiplied by the account's price per unit, which defaults to Coralogix's published $1.50. Edit the account to enter your plan's rate. Moving data to a lower TCO priority lowers the units each GB costs.",
        ),
      ]),
    );
    if (s.limits.length > 0) {
      sections.push(
        section("Limits", [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Limit", width: "wide" },
              { key: "used", label: "Used" },
              { key: "limit", label: "Limit" },
            ],
            rows: s.limits.map<TableRow>((l) => ({
              cells: { name: l.name, used: amount(l.used, 0), limit: amount(l.limit, 0) },
            })),
          },
        ]),
      );
    }
  } else {
    sections.push(
      section("Usage this month", [
        muted(
          "Usage could not be read. Check that the API key has the DataUsage preset under Check credentials.",
        ),
      ]),
    );
  }
  const exportOn = s?.usageMetricsExport ?? f["usageMetricsExport"];
  return {
    title: r.displayName,
    subtitle: str(f["region"]),
    sections,
    headerActions:
      exportOn === true
        ? [
            action(
              "Turn off data usage metrics",
              "disable-usage-metrics",
              "Data usage metrics turned off.",
              {
                confirmMessage:
                  "Stop sending data usage metrics into this team? Dashboards and alerts built on them stop receiving data.",
              },
            ),
          ]
        : exportOn === false
          ? [
              action(
                "Turn on data usage metrics",
                "enable-usage-metrics",
                "Data usage metrics turned on. They appear in the team's metrics within a few minutes.",
              ),
            ]
          : [],
  };
}

function enableToggle(enabled: boolean, noun: string, extraDisable?: string): ActionNode {
  return enabled
    ? action(
        `Disable ${noun}`,
        "disable",
        `${noun.charAt(0).toUpperCase()}${noun.slice(1)} disabled.`,
        {
          confirmMessage: `Disable this ${noun}?${extraDisable ? ` ${extraDisable}` : ""}`,
        },
      )
    : action(
        `Enable ${noun}`,
        "enable",
        `${noun.charAt(0).toUpperCase()}${noun.slice(1)} enabled.`,
      );
}

function renderAlert(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: [f["type"], f["priority"]].filter(Boolean).join(" · "),
    sections: [
      section("Alert", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Priority", f["priority"]],
          ["Enabled", f["enabled"]],
          ["Type", f["type"]],
          ["Status", f["status"]],
          ["Group by", f["groupBy"]],
          ["Labels", f["labels"]],
          ["Last triggered", f["lastTriggeredAt"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
          ["Alert ID", r.externalId, true],
        ]),
      ]),
    ],
    headerActions: [
      enableToggle(
        f["enabled"] !== false,
        "alert",
        "It stops evaluating until it is enabled again.",
      ),
    ],
  };
}

function renderDashboard(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const pinned = f["pinned"] === true;
  return {
    title: r.displayName,
    subtitle: str(f["folder"]),
    sections: [
      section("Dashboard", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Folder", f["folder"]],
          ["Pinned", f["pinned"]],
          ["Team default", f["isDefault"]],
          ["Locked", f["locked"]],
          ["Slug", f["slug"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
          ["Dashboard ID", r.externalId, true],
        ]),
      ]),
    ],
    headerActions: [
      pinned
        ? action("Unpin", "unpin", "Dashboard unpinned.")
        : action("Pin", "pin", "Dashboard pinned."),
      ...(f["isDefault"] === true
        ? []
        : [
            action("Make default", "make-default", "Dashboard set as the team's default.", {
              confirmMessage: "Make this the dashboard everyone in the team opens by default?",
            }),
          ]),
    ],
  };
}

function renderPolicy(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: [f["source"], f["priorityLabel"]].filter(Boolean).join(" · "),
    sections: [
      section("Policy", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Priority", f["priorityLabel"]],
          ["Current priority (quota override)", f["currentPriority"]],
          ["Enabled", f["enabled"]],
          ["Source", f["source"]],
          ["Order", f["order"]],
          ["Archive retention", f["archiveRetentionId"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]),
      ]),
      section("Matches", [
        kv([
          ["Applications", f["applications"]],
          ["Subsystems", f["subsystems"]],
          ["Severities", f["severities"]],
          ["Services", f["services"]],
          ["Actions", f["actions"]],
        ]),
        muted(
          "The Metrics tab charts the volume these rules matched over the last week. Edit the policy to move that volume to a cheaper priority.",
        ),
      ]),
    ],
    headerActions: [
      enableToggle(
        f["enabled"] !== false,
        "policy",
        "Matching data falls through to the next policy, or to High priority if none matches.",
      ),
    ],
  };
}

function renderRuleGroup(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: str(f["ruleKinds"]),
    sections: [
      section("Rule group", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Enabled", f["enabled"]],
          ["Order", f["order"]],
          ["Rules", f["ruleCount"]],
          ["Rule types", f["ruleKinds"]],
          ["Applications", f["applications"]],
          ["Subsystems", f["subsystems"]],
          ["Severities", f["severities"]],
          ["Created by", f["creator"]],
        ]),
      ]),
    ],
    headerActions: [
      enableToggle(
        f["enabled"] !== false,
        "rule group",
        "Incoming logs are no longer parsed by it.",
      ),
    ],
  };
}

function renderEnrichment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: str(f["kind"]),
    sections: [
      section("Enrichment", [
        kv([
          ["Type", f["kind"]],
          ["Field", f["fieldName"]],
          ["Enriched field", f["enrichedFieldName"]],
          ["Custom enrichment", f["customEnrichment"]],
          ["AWS resource type", f["awsResourceType"]],
          ["Columns", f["selectedColumns"]],
          ["Datasets", f["datasets"]],
        ]),
      ]),
    ],
    headerActions: [],
  };
}

function renderCustomEnrichment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    sections: [
      section("Custom enrichment", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["File", f["fileName"]],
          ["File size (bytes)", f["fileSize"]],
          ["Version", f["version"]],
          ["Query only", f["queryOnly"]],
          ["ID", r.externalId, true],
        ]),
        muted("Upload a new version of the file in Coralogix under Data Flow, Data Enrichment."),
      ]),
    ],
    headerActions: [],
  };
}

function renderWebhook(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: str(f["type"]),
    sections: [
      section("Outbound webhook", [
        kv([
          ["Name", f["name"]],
          ["Type", f["type"]],
          ["URL", f["url"], true],
          ["External ID", f["externalId"], true],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]),
      ]),
    ],
    headerActions: [action("Send test", "test", "Test notification sent.")],
  };
}

function renderQuotaRule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: str(f["allocationText"]),
    sections: [
      section("Quota rule", [
        kv([
          ["Entity type", f["entityType"]],
          ["Allocation", f["allocationText"]],
          ["Allocation type", f["allocationType"]],
          ["Can overflow", f["canOverflow"]],
          ["Enabled", f["enabled"]],
          ["Managed by Coralogix", f["cxManaged"]],
        ]),
        ...(f["cxManaged"] === true
          ? [muted("Coralogix manages this rule; changes may be reset by Coralogix.")]
          : []),
      ]),
    ],
    headerActions: [],
  };
}

function renderE2M(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: str(f["source"]),
    sections: [
      section("Events2Metrics rule", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Source", f["source"]],
          ["Query", f["query"]],
          ["Applications", f["applications"]],
          ["Subsystems", f["subsystems"]],
          ["Severities", f["severities"]],
          ["Metrics", f["metrics"]],
          ["Labels", f["labels"]],
          ["Permutations limit", f["permutationsLimit"]],
          ["Limit exceeded", f["limitExceeded"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ]),
        ...(f["limitExceeded"] === true
          ? [
              muted(
                "This rule has more label permutations than its limit allows; series beyond the limit are dropped. Remove a high-cardinality label or raise the limit in Coralogix.",
              ),
            ]
          : []),
      ]),
    ],
    headerActions: [],
  };
}

export function renderCoralogixDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs: number | undefined;
  switch (r.resourceTypeId) {
    case "team":
      schema = renderTeam(r);
      windowMs = TEAM_METRICS_WINDOW_MS;
      break;
    case "alert":
      schema = renderAlert(r);
      windowMs = ALERT_METRICS_WINDOW_MS;
      break;
    case "dashboard":
      schema = renderDashboard(r);
      break;
    case "tco-policy":
      schema = renderPolicy(r);
      windowMs = POLICY_METRICS_WINDOW_MS;
      break;
    case "parsing-rule-group":
      schema = renderRuleGroup(r);
      break;
    case "enrichment":
      schema = renderEnrichment(r);
      break;
    case "custom-enrichment":
      schema = renderCustomEnrichment(r);
      break;
    case "outgoing-webhook":
      schema = renderWebhook(r);
      break;
    case "quota-rule":
      schema = renderQuotaRule(r);
      break;
    case "events2metrics":
      schema = renderE2M(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function alertStatus(status: string): ResourceStatus {
  switch (status) {
    case "OK":
      return "healthy";
    case "Alerting":
      return "error";
    case "No data":
      return "unknown";
    default:
      return "info";
  }
}

export function renderCoralogixSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  const disabled = f["enabled"] === false;
  switch (r.resourceTypeId) {
    case "team":
      return item(
        "healthy",
        typeof f["monthToDateCost"] === "number" ? usd(f["monthToDateCost"]) : "Team",
      );
    case "alert":
      return disabled
        ? item("unknown", "Disabled")
        : item(alertStatus(str(f["status"])), str(f["status"]) || str(f["priority"]) || "Alert");
    case "tco-policy":
      return disabled ? item("unknown", "Disabled") : item("info", str(f["priority"]) || "Policy");
    case "parsing-rule-group":
      return disabled
        ? item("unknown", "Disabled")
        : item("healthy", str(f["ruleKinds"]) || "Rules");
    case "quota-rule":
      return disabled
        ? item("unknown", "Disabled")
        : item("info", str(f["allocationText"]) || "Rule");
    case "events2metrics":
      return f["limitExceeded"] === true
        ? item("degraded", "Limit exceeded")
        : item("healthy", str(f["source"]) || "Rule");
    case "dashboard":
      return item("info", f["pinned"] === true ? "Pinned" : str(f["folder"]) || "Dashboard");
    case "outgoing-webhook":
      return item("info", str(f["type"]) || "Webhook");
    case "enrichment":
      return item("info", str(f["kind"]) || "Enrichment");
    case "custom-enrichment":
      return item("info", f["version"] !== undefined ? `v${str(f["version"])}` : "Lookup");
    default:
      return item("info", str(r.resourceTypeId));
  }
}
