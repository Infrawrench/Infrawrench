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
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";
import { METRICS_WINDOW_MS } from "./signalflow.js";

/** Key under which `enrichDetail` stashes a synthetic test's recent runs. */
export const RUNS_KEY = "__runs__";
/** Key the client sets so the synchronous renderer can build app links. */
export const APP_KEY = "__app__";

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

function mono(content: string): SchemaNode {
  return { kind: "text", variant: "mono", content, copyable: true };
}

function openUrl(label: string, url: string): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function act(
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

export function severityStatus(sev: string): ResourceStatus {
  switch (sev) {
    case "Critical":
    case "Major":
      return "error";
    case "Minor":
    case "Warning":
      return "degraded";
    default:
      return "info";
  }
}

function app(r: ResourceInstance): string {
  return str(r.resolvedOutputs[APP_KEY]);
}

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Organization", f["realm"], f["accountType"]),
    status: {
      kind: "status-dot",
      status:
        str(f["accountStatus"]).toUpperCase() === "ACTIVE" || !f["accountStatus"]
          ? "healthy"
          : "degraded",
      label: str(f["accountStatus"]) || "Organization",
    },
    sections: [
      section("Organization", [
        kv([
          ["Name", f["organizationName"]],
          ["Organization ID", f["orgId"], true],
          ["Realm", f["realm"]],
          ["Account type", f["accountType"]],
          ["Account status", f["accountStatus"]],
          ["Renews", f["accountRenews"]],
          ["Valid until", f["accountValidUntil"]],
          ["Data points per minute limit", f["dpmLimit"]],
          ["Created", f["created"]],
        ]),
      ]),
      section("Tokens expiring", [
        kv([
          ["Within 7 days", f["tokensExpiringSoon"] || "None"],
          ["Within 30 days", f["tokensExpiringMonth"] || "None"],
        ]),
      ]),
      section("Usage", [
        muted(
          "The Metrics tab charts the organization's usage metrics: active metric time series against the limit, data points received, hosts and containers monitored, and custom metrics. Splunk has no billing API, so spend is not reported.",
        ),
      ]),
    ],
    headerActions: openUrl("Open Splunk Observability", app(r)),
  };
}

function renderDetector(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const total = Number(f["ruleCount"] ?? 0);
  const off = Number(f["disabledRules"] ?? 0);
  const allOff = total > 0 && off === total;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Detector", f["tags"]),
    status: {
      kind: "status-dot",
      status: allOff ? "unknown" : f["overMTSLimit"] === true ? "degraded" : "healthy",
      label: allOff ? "Rules off" : off ? `${off} of ${total} rules off` : "Active",
    },
    sections: [
      section("Detector", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Rules", f["rules"]],
          ["Tags", f["tags"]],
          ["Teams", f["teams"]],
          ["Locked", f["locked"] === true ? true : undefined],
          ["Over MTS limit", f["overMTSLimit"] === true ? true : undefined],
          ["Last updated", f["lastUpdated"]],
          ["Detector ID", r.externalId, true],
        ]),
      ]),
      section("SignalFlow program", [mono(str(f["programText"]) || "No program")]),
    ],
    headerActions: [
      ...openUrl("Open in Splunk", str(r.resolvedOutputs["url"])),
      allOff
        ? act("Turn rules on", "enable", { success: "Detector rules turned on" })
        : act("Turn rules off", "disable", {
            confirm:
              "Turn every rule of this detector off? It stops alerting until turned back on.",
            success: "Detector rules turned off",
          }),
    ],
  };
}

function renderIncident(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Alert", f["severity"]),
    status: {
      kind: "status-dot",
      status: f["active"] === true ? severityStatus(str(f["severity"])) : "healthy",
      label: f["active"] === true ? str(f["severity"]) || "Active" : "Cleared",
    },
    sections: [
      section("Alert", [
        kv([
          ["Detector", f["detectorName"]],
          ["Rule", f["detectLabel"]],
          ["Severity", f["severity"]],
          ["State", f["anomalyState"]],
          ["Muted", f["isMuted"] === true ? true : undefined],
          ["Triggered", f["triggeredAt"]],
          ["Inputs", f["inputs"]],
          ["Incident ID", r.externalId, true],
        ]),
      ]),
    ],
    headerActions: [
      ...openUrl("Open in Splunk", app(r) ? `${app(r)}/#/alerts/${str(r.externalId)}` : ""),
      ...(f["active"] === true
        ? [
            act("Clear alert", "clear", {
              confirm: "Clear this alert? Splunk marks it resolved.",
              success: "Alert cleared",
            }),
          ]
        : []),
    ],
  };
}

function renderMutingRule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const stop = Date.parse(str(f["stopTime"]));
  const active = Number.isFinite(stop) ? stop > Date.now() : true;
  return {
    title: r.displayName,
    subtitle: "Muting rule",
    status: {
      kind: "status-dot",
      status: active ? "info" : "unknown",
      label: active ? "Muting" : "Ended",
    },
    sections: [
      section("Muting rule", [
        kv([
          ["Description", f["description"]],
          ["Filters", f["filters"]],
          ["Starts", f["startTime"]],
          ["Ends", f["stopTime"] || "Never"],
          ["Recurrence", f["recurrence"]],
          ["Alert when it ends", f["sendAlertsAfter"] === true],
          ["Creator", f["creator"]],
        ]),
      ]),
    ],
    headerActions: active
      ? [
          act("End now", "unmute", {
            confirm: "End this muting rule now? Matching alerts notify again.",
            success: "Muting ended",
          }),
        ]
      : [],
  };
}

function simple(
  r: ResourceInstance,
  label: string,
  rows: Array<[string, unknown, boolean?]>,
  extra: SectionNode[] = [],
): DetailViewSchema {
  return {
    title: r.displayName,
    subtitle: label,
    status: { kind: "status-dot", status: "info", label },
    sections: [section(label, [kv(rows)]), ...extra],
    headerActions: openUrl("Open in Splunk", str(r.resolvedOutputs["url"])),
  };
}

function renderToken(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const exp = Date.parse(str(f["expiry"]));
  const expired = Number.isFinite(exp) && exp < Date.now();
  const disabled = f["disabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Access token", f["authScopes"]),
    status: {
      kind: "status-dot",
      status: expired
        ? "error"
        : disabled
          ? "unknown"
          : f["exceedingLimits"] === true
            ? "degraded"
            : "healthy",
      label: expired ? "Expired" : disabled ? "Disabled" : "Active",
    },
    sections: [
      section("Token", [
        kv([
          ["Name", r.externalId, true],
          ["Description", f["description"]],
          ["Scopes", f["authScopes"]],
          ["Expires", f["expiry"]],
          ["Last rotated", f["latestRotation"]],
          ["DPM quota", f["dpmQuota"]],
          ["Exceeding limits", f["exceedingLimits"] === true ? true : undefined],
          ["Creator", f["creator"]],
          ["Created", f["created"]],
        ]),
        muted(
          "The secret is never stored here. Use Get credentials to rotate it and see the new secret once.",
        ),
      ]),
    ],
    headerActions: [
      disabled
        ? act("Turn on", "enable", { success: "Token turned on" })
        : act("Turn off", "disable", {
            confirm: "Turn this token off? Anything using it is refused.",
            success: "Token turned off",
          }),
    ],
  };
}

function renderTest(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const active = f["active"] === true;
  let runs: Array<{
    timestamp?: string;
    location?: string;
    success?: boolean;
    runDurationMs?: number;
    message?: string;
  }> = [];
  try {
    runs = JSON.parse(r.resolvedOutputs[RUNS_KEY] ?? "[]");
  } catch {
    runs = [];
  }
  const last = str(f["lastRunStatus"]);
  const sections: SectionNode[] = [
    section("Test", [
      kv([
        ["Type", f["type"]],
        ["Frequency", f["frequency"] !== undefined ? `every ${str(f["frequency"])} min` : ""],
        ["Locations", f["locations"]],
        ["Scheduling", f["schedulingStrategy"]],
        ["Last run", joinSubtitle(f["lastRunStatus"], f["lastRunAt"])],
        ["Test ID", f["testId"], true],
      ]),
    ]),
  ];
  if (runs.length > 0) {
    sections.push(
      section("Recent runs", [
        {
          kind: "table",
          columns: [
            { key: "at", label: "When" },
            { key: "location", label: "Location" },
            { key: "result", label: "Result" },
            { key: "duration", label: "Duration" },
            { key: "message", label: "Message", width: "wide" },
          ],
          rows: runs.slice(0, 25).map<TableRow>((run) => ({
            cells: {
              at: str(run.timestamp),
              location: str(run.location),
              result: run.success ? "Success" : "Failed",
              duration: run.runDurationMs !== undefined ? `${run.runDurationMs} ms` : "",
              message: str(run.message),
            },
          })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Synthetic test", f["type"]),
    status: {
      kind: "status-dot",
      status: !active
        ? "unknown"
        : last === "failed"
          ? "error"
          : last === "success"
            ? "healthy"
            : "info",
      label: !active ? "Paused" : last || "Active",
    },
    sections,
    headerActions: [
      ...openUrl("Open in Splunk", app(r) ? `${app(r)}/#/synthetics` : ""),
      act("Run now", "run", { success: "Run started" }),
      active
        ? act("Pause", "pause", {
            confirm: "Pause this test? It stops running until resumed.",
            success: "Test paused",
          })
        : act("Resume", "resume", { success: "Test resumed" }),
    ],
  };
}

export function renderSplunkDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      break;
    case "detector":
      schema = renderDetector(r);
      break;
    case "incident":
      schema = renderIncident(r);
      break;
    case "muting-rule":
      schema = renderMutingRule(r);
      break;
    case "dashboard-group":
      schema = simple(r, "Dashboard group", [
        ["Description", f["description"]],
        ["Dashboards", f["dashboardCount"]],
        ["Teams", f["teams"]],
        ["Creator", f["creator"]],
        ["Last updated", f["lastUpdated"]],
        ["ID", r.externalId, true],
      ]);
      break;
    case "dashboard":
      schema = simple(r, "Dashboard", [
        ["Description", f["description"]],
        ["Charts", f["chartCount"]],
        ["Tags", f["tags"]],
        ["Creator", f["creator"]],
        ["Last updated", f["lastUpdated"]],
        ["ID", r.externalId, true],
      ]);
      break;
    case "chart":
      schema = simple(
        r,
        "Chart",
        [
          ["Description", f["description"]],
          ["Type", f["chartType"]],
          ["Tags", f["tags"]],
          ["Last updated", f["lastUpdated"]],
          ["ID", r.externalId, true],
        ],
        [section("SignalFlow program", [mono(str(f["programText"]) || "No program")])],
      );
      break;
    case "team":
      schema = simple(r, "Team", [
        ["Description", f["description"]],
        ["Members", f["memberCount"]],
        ["Notification policy", f["notificationPolicies"] || "Organization default"],
        ["Last updated", f["lastUpdated"]],
        ["Team ID", r.externalId, true],
      ]);
      break;
    case "member":
      schema = simple(r, f["admin"] === true ? "Admin" : "Member", [
        ["Name", f["fullName"]],
        ["Email", f["email"], true],
        ["Title", f["title"]],
        ["Admin", f["admin"] === true],
        ["Roles", f["roles"]],
        ["Joined", f["created"]],
      ]);
      break;
    case "integration": {
      const enabled = f["enabled"] === true;
      schema = {
        ...simple(r, "Integration", [
          ["Type", f["type"]],
          ["Enabled", enabled],
          ["Created by", f["createdBy"]],
          ["Last updated", f["lastUpdated"]],
          ["Integration ID", r.externalId, true],
        ]),
        status: {
          kind: "status-dot",
          status: enabled ? "healthy" : "unknown",
          label: enabled ? "Enabled" : "Disabled",
        },
        headerActions: [
          act("Validate", "validate", { success: "Integration is working" }),
          enabled
            ? act("Turn off", "disable", {
                confirm: "Turn this integration off?",
                success: "Integration turned off",
              })
            : act("Turn on", "enable", { success: "Integration turned on" }),
        ],
      };
      break;
    }
    case "org-token":
      schema = renderToken(r);
      break;
    case "slo":
      schema = simple(r, "SLO", [
        ["Description", f["description"]],
        ["Type", f["type"]],
        ["Target", f["target"] !== undefined ? `${str(f["target"])}%` : ""],
        ["Compliance period", f["compliancePeriod"]],
        ["Window", f["targetType"]],
        ["Alert rules", f["alertRules"]],
        ["Scope", f["metadata"]],
        ["Last updated", f["lastUpdated"]],
        ["SLO ID", r.externalId, true],
      ]);
      break;
    case "synthetic-test":
      schema = renderTest(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(f).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderSplunkSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "incident":
      return item(severityStatus(str(f["severity"])), str(f["severity"]) || "Alert");
    case "detector":
      return Number(f["disabledRules"] ?? 0) > 0 && f["disabledRules"] === f["ruleCount"]
        ? item("unknown", "Rules off")
        : item("healthy", `${str(f["ruleCount"]) || "0"} rules`);
    case "integration":
      return f["enabled"] === true
        ? item("healthy", str(f["type"]) || "Enabled")
        : item("unknown", "Disabled");
    case "org-token":
      return f["disabled"] === true
        ? item("unknown", "Disabled")
        : item("healthy", str(f["authScopes"]) || "Active");
    case "synthetic-test":
      return f["active"] !== true
        ? item("unknown", "Paused")
        : item(
            str(f["lastRunStatus"]) === "failed" ? "error" : "healthy",
            str(f["type"]) || "Active",
          );
    default:
      return item("info", str(f["description"]).slice(0, 40) || r.resourceTypeId);
  }
}

/** Form fields the muting-rule create form shares with the edit path. */
export const MUTING_FILTER_HELP =
  "Dimension filters, one per line or comma-separated, as property=value (prefix with ! to exclude), for example host=web-1, !env=dev. Leave empty to mute every alert.";

export type { CreateFieldConfig };
