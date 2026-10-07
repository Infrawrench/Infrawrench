import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { DEFAULT_DQL, DQL_TABLES } from "./dql.js";
import { METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `enrichDetail` stashes the month's cost for the environment view. */
export const COST_SUMMARY_KEY = "__costSummary__";
/** Key under which `enrichDetail` stashes a problem's comments. */
export const COMMENTS_KEY = "__comments__";
/** Output key the SQL editor resolves for the DQL tab. */
export const DQL_OUTPUT_KEY = "environmentId";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

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

function openUrl(label: string, url: string): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; destructive?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  fields: CreateFieldConfig[],
  opts: { description?: string; submitLabel?: string; danger?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      fields,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.submitLabel ? { submitLabel: opts.submitLabel } : {}),
      ...(opts.danger ? { danger: true } : {}),
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

function money(amount: number, currency: string): string {
  try {
    return amount.toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Deep link into the environment's UI for an entity, problem or setting. */
function uiLink(envUrl: string, path: string): string {
  return envUrl ? `${envUrl.replace(/\/+$/, "")}${path}` : "";
}

function envUrlOf(r: ResourceInstance): string {
  return str(r.resolvedOutputs["__envUrl__"] ?? r.fields["envUrl"]);
}

export function problemStatus(f: Record<string, unknown>): ResourceStatus {
  if (str(f["status"]) === "CLOSED") return "healthy";
  switch (str(f["severityLevel"])) {
    case "AVAILABILITY":
    case "ERROR":
      return "error";
    case "MONITORING_UNAVAILABLE":
      return "unknown";
    default:
      return "degraded";
  }
}

export function sloStatus(f: Record<string, unknown>): ResourceStatus {
  if (f["enabled"] === false) return "unknown";
  switch (str(f["status"])) {
    case "SUCCESS":
      return "healthy";
    case "WARNING":
      return "degraded";
    case "FAILURE":
      return "error";
    default:
      return "info";
  }
}

interface CostSummary {
  total: number;
  currency: string;
  byCapability: Array<{ name: string; amount: number }>;
}

function renderEnvironment(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const cost = parseJson<CostSummary | { error: string }>(r.resolvedOutputs[COST_SUMMARY_KEY]);
  const grail = f["grail"] === true;
  const sections: SectionNode[] = [
    section("Environment", [
      kv([
        ["Environment ID", f["environmentId"], true],
        ["URL", f["url"], true],
        ["Platform URL", f["platformUrl"], true],
        ["Version", f["version"]],
        ["Hosts", f["hostCount"]],
        ["Services", f["serviceCount"]],
        ["Web applications", f["applicationCount"]],
        ["Open problems", f["openProblems"]],
      ]),
    ]),
  ];
  const costChildren: SchemaNode[] = [];
  if (cost && "total" in cost) {
    costChildren.push(kv([["Cost this month so far", money(cost.total, cost.currency)]]));
    if (cost.byCapability.length > 0) {
      costChildren.push({
        kind: "table",
        columns: [
          { key: "capability", label: "Capability", width: "wide" },
          { key: "amount", label: "Amount" },
        ],
        rows: cost.byCapability.map<TableRow>((c) => ({
          cells: { capability: c.name, amount: money(c.amount, cost.currency) },
        })),
      });
    }
    costChildren.push(
      muted("Dynatrace Platform Subscription cost booked against this environment, by capability."),
    );
  } else if (cost && "error" in cost) {
    costChildren.push(muted(cost.error));
  } else {
    costChildren.push(
      muted(
        "Add an OAuth client (account UUID, client id and secret with account-uac-read) to the account's credentials to see this environment's platform subscription cost here and in Costs.",
      ),
    );
  }
  sections.push(section("Cost", costChildren));
  sections.push(
    section("Query", [
      muted(
        grail
          ? "Run DQL against Grail from the Query tab, for example fetch logs or fetch dt.entity.host."
          : "Add a platform token (Edit credentials) to run DQL against Grail. Managed environments have no Grail.",
      ),
    ]),
  );
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Environment", f["version"]),
    status: {
      kind: "status-dot",
      status: "healthy",
      label: str(f["environmentId"]) || "Environment",
    },
    sections,
    headerActions: [...openUrl("Open Dynatrace", str(f["platformUrl"]) || str(f["url"]))],
    ...(grail
      ? {
          sqlEditor: {
            connectionStringOutputKey: DQL_OUTPUT_KEY,
            defaultQuery: DEFAULT_DQL,
            tables: DQL_TABLES,
          },
        }
      : {}),
  };
}

function entityLink(r: ResourceInstance): string {
  const id = str(r.fields["entityId"]) || str(r.externalId);
  const env = envUrlOf(r);
  if (!env || !id) return "";
  switch (r.resourceTypeId) {
    case "host":
      return uiLink(env, `/#newhosts/hostdetails;id=${id}`);
    case "service":
      return uiLink(env, `/#newservices/serviceOverview;id=${id}`);
    case "process-group":
      return uiLink(env, `/#processgroupdetails;id=${id}`);
    case "application":
      return uiLink(env, `/#uemapplications/uemappmetrics;uemapplicationId=${id}`);
    default:
      return uiLink(env, `/#entity;id=${id}`);
  }
}

function renderEntity(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const label = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId)?.displayName ?? "Entity";
  const rows: Array<[string, unknown, boolean?]> = [];
  switch (r.resourceTypeId) {
    case "host":
      rows.push(
        ["OS", joinSubtitle(f["osType"], f["osVersion"])],
        ["CPU cores", f["cpuCores"]],
        ["Memory", typeof f["memoryBytes"] === "number" ? formatBytes(f["memoryBytes"]) : ""],
        ["Monitoring mode", f["monitoringMode"]],
        ["State", f["state"]],
        ["IP addresses", f["ipAddresses"], true],
        ["Cloud", f["cloudType"]],
        ["Host group", f["hostGroup"]],
        ["OneAgent", f["oneAgentVersion"]],
      );
      break;
    case "process-group":
      rows.push(["Technologies", f["technologies"]], ["Hosts", f["runsOn"]]);
      break;
    case "service":
      rows.push(
        ["Service type", f["serviceType"]],
        ["Technology", f["technology"]],
        ["Web server", f["webServer"]],
        ["Process groups", f["runsOn"]],
      );
      break;
    case "application":
      rows.push(["Application type", f["applicationType"]]);
      break;
    case "kubernetes-cluster":
      rows.push(
        ["Distribution", f["distribution"]],
        ["Kubernetes version", f["kubernetesVersion"]],
        ["Cloud", f["cloudType"]],
      );
      break;
  }
  rows.push(
    ["Tags", f["tags"]],
    ["Management zones", f["managementZones"]],
    ["First seen", f["firstSeen"]],
    ["Last seen", f["lastSeen"]],
    ["Entity ID", f["entityId"], true],
  );
  const offline = r.resourceTypeId === "host" && str(f["state"]) && str(f["state"]) !== "RUNNING";
  const logs = r.resourceTypeId === "host" || r.resourceTypeId === "service";
  return {
    title: r.displayName,
    subtitle: joinSubtitle(label, r.resourceTypeId === "host" ? f["osType"] : f["serviceType"]),
    status: {
      kind: "status-dot",
      status: offline ? "degraded" : "healthy",
      label: offline ? str(f["state"]) : "Monitored",
    },
    sections: [section(label, [kv(rows)])],
    headerActions: openUrl("Open in Dynatrace", entityLink(r)),
    ...(logs ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

const commentField: CreateFieldConfig = {
  key: "message",
  label: "Comment",
  kind: "text",
  required: true,
  multiline: true,
};

function renderProblem(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const open = str(f["status"]) !== "CLOSED";
  const comments = parseJson<Array<{ author?: string; at?: string; content?: string }>>(
    r.resolvedOutputs[COMMENTS_KEY],
  );
  const sections: SectionNode[] = [
    section("Problem", [
      kv([
        ["Problem", f["displayId"], true],
        ["Title", f["title"]],
        ["Status", f["status"]],
        ["Severity", f["severityLevel"]],
        ["Impact", f["impactLevel"]],
        ["Root cause", f["rootCause"]],
        ["Affected", f["affectedEntities"]],
        ["Management zones", f["managementZones"]],
        ["Started", f["startTime"]],
        ["Ended", f["endTime"]],
      ]),
    ]),
  ];
  if (comments && comments.length > 0) {
    sections.push(
      section("Comments", [
        {
          kind: "table",
          columns: [
            { key: "at", label: "When" },
            { key: "author", label: "Author" },
            { key: "content", label: "Comment", width: "wide" },
          ],
          rows: comments.map<TableRow>((c) => ({
            cells: { at: str(c.at), author: str(c.author), content: str(c.content) },
          })),
        },
      ]),
    );
  }
  const env = envUrlOf(r);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Problem", f["severityLevel"], f["impactLevel"]),
    status: {
      kind: "status-dot",
      status: problemStatus(f),
      label: open ? "Open" : "Closed",
    },
    sections,
    headerActions: [
      ...openUrl(
        "Open in Dynatrace",
        env
          ? uiLink(env, `/#problems/problemdetails;pid=${encodeURIComponent(str(r.externalId))}`)
          : "",
      ),
      prompt("Add comment", "comment", "Comment on this problem", [commentField], {
        submitLabel: "Add comment",
      }),
      ...(open
        ? [
            prompt(
              "Close problem",
              "close",
              "Close this problem",
              [{ ...commentField, label: "Closing comment" }],
              {
                description:
                  "Closing tells Davis the problem is resolved. If the cause is still present, Davis opens a new problem.",
                submitLabel: "Close problem",
              },
            ),
          ]
        : []),
    ],
  };
}

function renderSlo(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] !== false;
  const pct = (v: unknown) => (typeof v === "number" ? `${v}%` : "");
  return {
    title: r.displayName,
    subtitle: joinSubtitle("SLO", f["timeframe"]),
    status: {
      kind: "status-dot",
      status: sloStatus(f),
      label: enabled ? str(f["status"]) || "Not evaluated" : "Disabled",
    },
    sections: [
      section("Status", [
        kv([
          ["Current", pct(f["evaluatedPercentage"])],
          ["Target", pct(f["target"])],
          ["Warning", pct(f["warning"])],
          ["Error budget left", pct(f["errorBudget"])],
          ["Open problems", f["relatedOpenProblems"]],
        ]),
      ]),
      section("Definition", [
        kv([
          ["Description", f["description"]],
          ["Timeframe", f["timeframe"]],
          ["Entity filter", f["filter"], true],
          ["Metric name", f["metricName"], true],
          ["Evaluation", f["evaluationType"]],
        ]),
        {
          kind: "text",
          variant: "mono",
          content: str(f["metricExpression"]) || "No expression",
          copyable: true,
        },
      ]),
    ],
    headerActions: [
      enabled
        ? pluginAction("Turn off", "disable", {
            confirm: "Turn this SLO off? It stops being evaluated until turned back on.",
            success: "SLO turned off",
          })
        : pluginAction("Turn on", "enable", { success: "SLO turned on" }),
    ],
  };
}

function renderMonitor(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Synthetic monitor", f["type"]),
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Monitor", [
        kv([
          ["Type", f["type"]],
          ["URL", f["url"], true],
          [
            "Frequency",
            f["frequencyMin"] !== undefined ? `every ${str(f["frequencyMin"])} min` : "",
          ],
          ["Locations", f["locations"]],
          ["Tags", f["tags"]],
          ["Entity ID", f["entityId"], true],
        ]),
      ]),
    ],
    headerActions: [
      ...openUrl(
        "Open in Dynatrace",
        envUrlOf(r) ? uiLink(envUrlOf(r), `/#monitordetails;id=${str(f["entityId"])}`) : "",
      ),
      enabled
        ? pluginAction("Turn off", "disable", {
            confirm:
              "Turn this monitor off? It stops running from every location until turned back on.",
            success: "Monitor turned off",
          })
        : pluginAction("Turn on", "enable", { success: "Monitor turned on" }),
    ],
  };
}

function renderAlertingProfile(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const rules =
    parseJson<
      Array<{
        severityLevel?: string;
        delayInMinutes?: number;
        tagFilterIncludeMode?: string;
        tagFilter?: string[];
      }>
    >(str(f["rulesJson"])) ?? [];
  const sections: SectionNode[] = [
    section("Alerting profile", [
      kv([
        ["Name", f["name"]],
        ["Management zone", f["managementZone"]],
        ["Event filters", f["eventFilterCount"]],
        ["Object ID", f["objectId"], true],
      ]),
    ]),
    section("Severity rules", [
      rules.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "severity", label: "Severity" },
              { key: "delay", label: "Notify after" },
              { key: "tags", label: "Tag filter", width: "wide" },
            ],
            rows: rules.map<TableRow>((rule) => ({
              cells: {
                severity: str(rule.severityLevel),
                delay: `${rule.delayInMinutes ?? 0} min`,
                tags:
                  rule.tagFilterIncludeMode && rule.tagFilterIncludeMode !== "NONE"
                    ? `${rule.tagFilterIncludeMode}: ${(rule.tagFilter ?? []).join(", ")}`
                    : "Any entity",
              },
            })),
          }
        : muted("No severity rules: this profile matches no problems."),
    ]),
  ];
  return {
    title: r.displayName,
    subtitle: "Alerting profile",
    status: { kind: "status-dot", status: "info", label: `${rules.length} rules` },
    sections,
  };
}

function renderMaintenanceWindow(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Maintenance window", f["maintenanceType"]),
    status: {
      kind: "status-dot",
      status: enabled ? "info" : "unknown",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Maintenance window", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Type", f["maintenanceType"]],
          ["Suppression", f["suppression"]],
          ["Pause synthetic monitors", f["disableSynthetic"] === true],
          ["When", f["schedule"]],
          ["Scope", f["filters"]],
          ["Object ID", f["objectId"], true],
        ]),
      ]),
    ],
    headerActions: [
      enabled
        ? pluginAction("Turn off", "disable", { success: "Maintenance window turned off" })
        : pluginAction("Turn on", "enable", { success: "Maintenance window turned on" }),
    ],
  };
}

function renderApiToken(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  const exp = str(f["expirationDate"]);
  const expired = exp !== "" && Date.parse(exp) < Date.now();
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Access token", f["owner"]),
    status: {
      kind: "status-dot",
      status: expired ? "error" : enabled ? "healthy" : "unknown",
      label: expired ? "Expired" : enabled ? "Enabled" : "Disabled",
    },
    sections: [
      section("Token", [
        kv([
          ["Name", f["name"]],
          ["Owner", f["owner"]],
          ["Personal", f["personalAccessToken"] === true],
          ["Expires", exp || "Never"],
          ["Last used", f["lastUsedDate"]],
          ["Last used from", f["lastUsedIpAddress"]],
          ["Created", f["creationDate"]],
        ]),
        muted(
          "Dynatrace only shows a token's secret when it is created. Deleting the token revokes it at once.",
        ),
      ]),
      section("Scopes", [
        {
          kind: "text",
          variant: "mono",
          content: str(f["scopes"]).split(", ").filter(Boolean).join("\n") || "None",
        },
      ]),
    ],
    headerActions: [
      enabled
        ? pluginAction("Turn off", "disable", {
            confirm:
              "Turn this token off? Anything using it is refused until it is turned back on.",
            success: "Token turned off",
          })
        : pluginAction("Turn on", "enable", { success: "Token turned on" }),
    ],
  };
}

export function renderDynatraceDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "environment":
      schema = renderEnvironment(r);
      break;
    case "host":
    case "process-group":
    case "service":
    case "application":
    case "kubernetes-cluster":
      schema = renderEntity(r);
      break;
    case "problem":
      schema = renderProblem(r);
      break;
    case "slo":
      schema = renderSlo(r);
      break;
    case "synthetic-monitor":
      schema = renderMonitor(r);
      break;
    case "alerting-profile":
      schema = renderAlertingProfile(r);
      break;
    case "maintenance-window":
      schema = renderMaintenanceWindow(r);
      break;
    case "api-token":
      schema = renderApiToken(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderDynatraceSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "environment":
      return item("healthy", str(f["environmentId"]) || "Environment");
    case "host": {
      const state = str(f["state"]);
      return item(
        state && state !== "RUNNING" ? "degraded" : "healthy",
        state || str(f["osType"]) || "Host",
      );
    }
    case "problem":
      return item(problemStatus(f), str(f["status"]) || "Problem");
    case "slo":
      return item(sloStatus(f), f["enabled"] === false ? "Disabled" : str(f["status"]) || "SLO");
    case "synthetic-monitor":
    case "maintenance-window":
    case "api-token":
      return f["enabled"] === true
        ? item("healthy", str(f["type"]) || "Enabled")
        : item("unknown", "Disabled");
    default:
      return item("info", str(f["serviceType"]) || str(f["technologies"]) || r.resourceTypeId);
  }
}
