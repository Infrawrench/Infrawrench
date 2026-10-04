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
import type { UsageSummary } from "./cost-data.js";
import { DEFAULT_METRICS_WINDOW_MS, USAGE_METRICS_WINDOW_MS } from "./metrics.js";
import type { NewRelicRates } from "./rates.js";
import type { NewRelicRegion } from "./regions.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes the usage summary for the renderer. */
export const USAGE_SUMMARY_KEY = "__usageSummary__";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(value: unknown, digits = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
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

function openInNewRelic(url: string): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in New Relic", action: { type: "open-url", url } }]
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

export function severityStatus(severity: string, reporting: unknown): ResourceStatus {
  if (reporting === false) return "unknown";
  switch (severity) {
    case "CRITICAL":
      return "error";
    case "WARNING":
      return "degraded";
    case "NOT_ALERTING":
      return "healthy";
    default:
      return "info";
  }
}

function severityLabel(severity: string, reporting: unknown): string {
  if (reporting === false) return "Not reporting";
  switch (severity) {
    case "CRITICAL":
      return "Critical";
    case "WARNING":
      return "Warning";
    case "NOT_ALERTING":
      return "Not alerting";
    case "NOT_CONFIGURED":
      return "No alerts configured";
    default:
      return "Unknown";
  }
}

const entityRows = (f: ResourceInstance["fields"]): Array<[string, unknown, boolean?]> => [
  ["Account", f["accountName"]],
  ["Account ID", f["nrAccountId"], true],
  ["Tags", f["tags"]],
  ["Entity GUID", f["guid"], true],
];

function entityStatus(f: ResourceInstance["fields"]) {
  const severity = str(f["alertSeverity"]);
  return {
    kind: "status-dot" as const,
    status: severityStatus(severity, f["reporting"]),
    label: severityLabel(severity, f["reporting"]),
  };
}

function renderAccount(r: ResourceInstance, rates: NewRelicRates): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<UsageSummary>(r.resolvedOutputs[USAGE_SUMMARY_KEY]);
  const sections: SectionNode[] = [
    section("Account", [
      kv([
        ["Name", f["name"]],
        ["Account ID", f["nrAccountId"], true],
        ["Region", f["region"]],
        ["Usage account", f["usageAccount"]],
      ]),
    ]),
  ];
  if (f["usageAccount"] !== true) {
    sections.push(
      section("Usage", [
        {
          kind: "text",
          variant: "muted",
          content:
            "Usage and estimated cost are read from the usage account picked in this connection's credentials. On an organization with several accounts, the parent account records usage for all of them.",
        },
      ]),
    );
  } else if (summary) {
    sections.push(
      section(`Usage this month (${summary.month})`, [
        {
          kind: "table",
          columns: [
            { key: "product", label: "Product", width: "wide" },
            { key: "usage", label: "Usage" },
            { key: "cost", label: "Estimated cost" },
          ],
          rows: summary.costs.map<TableRow>((c) => ({
            cells: {
              product: c.product,
              usage: c.usage,
              cost: c.amount !== undefined ? usd(c.amount) : "Enter a rate to estimate",
            },
          })),
        },
        kv([
          ["Estimated total", usd(summary.totalCost)],
          ["Basic users (free)", summary.basicUsers],
        ]),
        {
          kind: "text",
          variant: "muted",
          content: `Estimated: New Relic's API reports usage but not prices. Rates used: $${rates.dataPerGb}/GB beyond ${rates.freeGbPerMonth} GB free, $${rates.fullPlatformUser} per full platform user, $${rates.coreUser} per core user, $${rates.syntheticCheck} per billable synthetic check${rates.coreCcu !== undefined ? `, $${rates.coreCcu} per core CCU` : ""}${rates.advancedCcu !== undefined ? `, $${rates.advancedCcu} per advanced CCU` : ""}. Change them to your contract's rates under Edit credentials.`,
        },
      ]),
    );
    if (summary.byAccount.length > 0) {
      sections.push(
        section("Data ingested by account", [
          {
            kind: "table",
            columns: [
              { key: "account", label: "Account", width: "wide" },
              { key: "gb", label: "GB" },
            ],
            rows: summary.byAccount.map<TableRow>((row) => ({
              cells: { account: row.account, gb: row.gigabytes.toFixed(2) },
            })),
          },
        ]),
      );
    }
    if (summary.bySource.length > 0) {
      sections.push(
        section("Data ingested by source", [
          {
            kind: "table",
            columns: [
              { key: "source", label: "Source", width: "wide" },
              { key: "gb", label: "GB" },
            ],
            rows: summary.bySource.map<TableRow>((row) => ({
              cells: { source: row.source, gb: row.gigabytes.toFixed(2) },
            })),
          },
        ]),
      );
    }
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Account", str(f["region"])),
    status: {
      kind: "status-dot",
      status: "healthy",
      label: f["usageAccount"] === true ? "Usage account" : "Account",
    },
    sections,
  };
}

function renderApm(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("APM application", f["language"]),
    status: entityStatus(f),
    sections: [
      section("Last 30 minutes", [
        kv([
          ["Apdex", f["apdex"]],
          [
            "Response time",
            f["responseTimeMs"] !== undefined ? `${str(f["responseTimeMs"])} ms` : "",
          ],
          ["Throughput", f["throughput"] !== undefined ? `${str(f["throughput"])} rpm` : ""],
          ["Error rate", f["errorRate"] !== undefined ? `${str(f["errorRate"])}%` : ""],
          ["Hosts", f["hostCount"]],
          ["Instances", f["instanceCount"]],
        ]),
      ]),
      section("Application", [
        kv([
          ["Language", f["language"]],
          ["Agent version", f["agentVersion"]],
          ["Application ID", f["applicationId"], true],
          ...entityRows(f),
        ]),
      ]),
    ],
    headerActions: openInNewRelic(r.resolvedOutputs["url"] ?? ""),
  };
}

function renderBrowser(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Browser application",
    status: entityStatus(f),
    sections: [
      section("Last 30 minutes", [
        kv([
          ["Page load time", f["pageLoadTime"] !== undefined ? `${str(f["pageLoadTime"])} s` : ""],
          ["Page views", f["pageViews"] !== undefined ? `${str(f["pageViews"])} ppm` : ""],
          ["JS error rate", f["jsErrorRate"] !== undefined ? `${str(f["jsErrorRate"])}%` : ""],
        ]),
      ]),
      section("Application", [
        kv([
          ["Agent install", f["agentInstallType"]],
          ["Application ID", f["applicationId"], true],
          ...entityRows(f),
        ]),
      ]),
    ],
    headerActions: openInNewRelic(r.resolvedOutputs["url"] ?? ""),
  };
}

function renderHost(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Host",
    status: entityStatus(f),
    sections: [
      section("Host", [
        kv([
          ["CPU", f["cpuPercent"] !== undefined ? `${str(f["cpuPercent"])}%` : ""],
          ["Memory", f["memoryPercent"] !== undefined ? `${str(f["memoryPercent"])}%` : ""],
          ["Disk", f["diskPercent"] !== undefined ? `${str(f["diskPercent"])}%` : ""],
          ["Services", f["servicesCount"]],
          ...entityRows(f),
        ]),
      ]),
    ],
    headerActions: openInNewRelic(r.resolvedOutputs["url"] ?? ""),
  };
}

function renderMonitor(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  const enabled = status === "ENABLED";
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Synthetic monitor", f["monitorType"]),
    status: enabled
      ? entityStatus(f)
      : { kind: "status-dot", status: "unknown", label: status ? status.toLowerCase() : "Monitor" },
    sections: [
      section("Monitor", [
        kv([
          ["Type", f["monitorType"]],
          ["Status", status],
          ["URL", f["monitoredUrl"], true],
          [
            "Frequency",
            str(f["period"])
              .replace(/^EVERY_/, "every ")
              .replace(/_/g, " ")
              .toLowerCase(),
          ],
          ["Success rate (24h)", f["successRate"] !== undefined ? `${str(f["successRate"])}%` : ""],
          ["Locations running", f["locationsRunning"]],
          ["Locations failing", f["locationsFailing"]],
          ["Monitor ID", f["monitorId"], true],
          ...entityRows(f),
        ]),
      ]),
    ],
    headerActions: [
      enabled
        ? {
            kind: "action",
            label: "Disable",
            action: {
              type: "plugin-action",
              actionId: "disable",
              confirmMessage: "Disable this monitor? It stops running until you enable it again.",
              successMessage: "Monitor disabled.",
            },
          }
        : {
            kind: "action",
            label: "Enable",
            action: {
              type: "plugin-action",
              actionId: "enable",
              successMessage: "Monitor enabled.",
            },
          },
      ...openInNewRelic(r.resolvedOutputs["url"] ?? ""),
    ],
  };
}

function renderDashboard(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Dashboard",
    status: { kind: "status-dot", status: "info", label: "Dashboard" },
    sections: [
      section("Dashboard", [
        kv([
          ["Owner", f["owner"]],
          ["Permissions", str(f["permissions"]).replace(/_/g, " ").toLowerCase()],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
          ...entityRows(f),
        ]),
      ]),
    ],
    headerActions: openInNewRelic(r.resolvedOutputs["url"] ?? ""),
  };
}

function workloadStatus(value: string): ResourceStatus {
  switch (value) {
    case "OPERATIONAL":
      return "healthy";
    case "DEGRADED":
      return "degraded";
    case "DISRUPTED":
      return "error";
    default:
      return "unknown";
  }
}

function renderWorkload(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = str(f["status"]);
  return {
    title: r.displayName,
    subtitle: "Workload",
    status: {
      kind: "status-dot",
      status: workloadStatus(status),
      label: status ? status.toLowerCase() : "Workload",
    },
    sections: [
      section("Workload", [
        kv([
          ["Status", status],
          ["Status source", f["statusSource"]],
          ["Summary", f["statusSummary"]],
          ["Created by", f["createdBy"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
          ...entityRows(f),
        ]),
      ]),
    ],
    headerActions: openInNewRelic(r.resolvedOutputs["url"] ?? ""),
  };
}

function renderPolicy(r: ResourceInstance, region: NewRelicRegion): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Alert policy", f["accountName"]),
    status: { kind: "status-dot", status: "info", label: "Alert policy" },
    sections: [
      section("Policy", [
        kv([
          ["Name", f["name"]],
          ["Incident preference", str(f["incidentPreference"]).replace(/_/g, " ").toLowerCase()],
          ["Policy ID", f["policyId"], true],
          ["Account", f["accountName"]],
          ["Account ID", f["nrAccountId"], true],
        ]),
      ]),
    ],
    headerActions: openInNewRelic(`${region.appUrl}/alerts-ai/policies`),
  };
}

function renderCondition(r: ResourceInstance, region: NewRelicRegion): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Alert condition", f["conditionType"]),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Condition", [
        kv([
          ["Name", f["name"]],
          ["Type", f["conditionType"]],
          ["Enabled", enabled],
          ["Thresholds", f["thresholds"]],
          ["Policy", f["policyName"]],
          ["Runbook", f["runbookUrl"], true],
          ["Condition ID", f["conditionId"], true],
          ["Account", f["accountName"]],
        ]),
      ]),
      section("Query", [
        { kind: "text", variant: "mono", content: str(f["query"]), copyable: true },
      ]),
      ...(f["description"]
        ? [section("Description", [{ kind: "text", content: str(f["description"]) }])]
        : []),
    ],
    headerActions: [
      enabled
        ? {
            kind: "action",
            label: "Disable",
            action: {
              type: "plugin-action",
              actionId: "disable",
              confirmMessage:
                "Disable this condition? It stops evaluating and opens no incidents until you enable it.",
              successMessage: "Condition disabled.",
            },
          }
        : {
            kind: "action",
            label: "Enable",
            action: {
              type: "plugin-action",
              actionId: "enable",
              successMessage: "Condition enabled.",
            },
          },
      ...openInNewRelic(`${region.appUrl}/alerts-ai/policies`),
    ],
  };
}

export function renderNewRelicDetail(
  r: ResourceInstance,
  region: NewRelicRegion,
  rates: NewRelicRates,
): DetailViewSchema {
  let schema: DetailViewSchema;
  let windowMs = DEFAULT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case "account":
      schema = renderAccount(r, rates);
      windowMs = USAGE_METRICS_WINDOW_MS;
      break;
    case "apm-application":
      schema = renderApm(r);
      break;
    case "browser-application":
      schema = renderBrowser(r);
      break;
    case "host":
      schema = renderHost(r);
      break;
    case "synthetic-monitor":
      schema = renderMonitor(r);
      break;
    case "dashboard":
      schema = renderDashboard(r);
      break;
    case "workload":
      schema = renderWorkload(r);
      break;
    case "alert-policy":
      schema = renderPolicy(r, region);
      break;
    case "alert-condition":
      schema = renderCondition(r, region);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, windowMs);
}

export function renderNewRelicSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "account":
      return item("healthy", f["usageAccount"] === true ? "Usage account" : "Account");
    case "synthetic-monitor": {
      const status = str(f["status"]);
      if (status && status !== "ENABLED") return item("unknown", status.toLowerCase());
      const severity = str(f["alertSeverity"]);
      return item(
        severityStatus(severity, f["reporting"]),
        severityLabel(severity, f["reporting"]),
      );
    }
    case "workload": {
      const status = str(f["status"]);
      return item(workloadStatus(status), status ? status.toLowerCase() : "Workload");
    }
    case "alert-policy":
      return item("info", "Policy");
    case "alert-condition":
      return f["enabled"] === true ? item("healthy", "Enabled") : item("unknown", "Disabled");
    case "dashboard":
      return item("info", "Dashboard");
    default: {
      const severity = str(f["alertSeverity"]);
      return item(
        severityStatus(severity, f["reporting"]),
        severityLabel(severity, f["reporting"]),
      );
    }
  }
}
