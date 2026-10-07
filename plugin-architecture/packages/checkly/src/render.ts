import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `enrichDetail` stashes a check's 7-day analytics. */
export const ANALYTICS_KEY = "__analytics__";

const APP = "https://app.checklyhq.com";
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function kv(items: Array<[string, unknown]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text) list.push({ key, value: text });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
    },
  };
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function open(url: string): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Checkly", action: { type: "open-url", url } }]
    : [];
}

function generic(r: ResourceInstance, title: string): SectionNode {
  const type = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  return section(title, [
    kv(
      (type?.fields ?? [])
        .filter((f) => f.kind !== "password")
        .map((f) => [f.label, r.fields[f.key]] as [string, unknown]),
    ),
  ]);
}

export function checklyStatus(r: ResourceInstance): StatusDotNode | undefined {
  const f = r.fields;
  const dot = (status: StatusDotNode["status"], label: string): StatusDotNode => ({
    kind: "status-dot",
    status,
    label,
  });
  if (r.resourceTypeId === "check") {
    if (f["activated"] === false) return dot("unknown", "Deactivated");
    const s = str(f["status"]);
    if (s === "Failing" || s === "Error") return dot("error", s);
    if (s === "Degraded") return dot("degraded", "Degraded");
    if (s === "Passing") return dot("healthy", f["muted"] === true ? "Passing (muted)" : "Passing");
    return undefined;
  }
  if (r.resourceTypeId === "check-group") {
    return f["activated"] === false ? dot("unknown", "Deactivated") : dot("healthy", "Active");
  }
  if (r.resourceTypeId === "private-location") {
    const agents = Number(f["agentCount"] ?? 0);
    return agents > 0
      ? dot(Number(f["outdatedAgents"] ?? 0) > 0 ? "degraded" : "healthy", `${agents} agents`)
      : dot("error", "No agents");
  }
  if (r.resourceTypeId === "maintenance-window" && f["active"] === true)
    return dot("info", "In progress");
  return undefined;
}

const LABEL: Record<string, string> = Object.fromEntries(
  RESOURCE_TYPES.map((t) => [t.id, t.displayName]),
);

function body(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = checklyStatus(r);
  const base = {
    title: r.displayName,
    subtitle: LABEL[r.resourceTypeId] ?? r.resourceTypeId,
    ...(status ? { status } : {}),
  };
  switch (r.resourceTypeId) {
    case "check": {
      let analytics: Record<string, number> = {};
      try {
        analytics = JSON.parse(r.resolvedOutputs[ANALYTICS_KEY] ?? "{}");
      } catch {
        analytics = {};
      }
      const ms = (v: number | undefined) => (v === undefined ? "" : `${Math.round(v)} ms`);
      return {
        ...base,
        subtitle: joinSubtitle("Check", str(f["checkType"]), str(f["target"])),
        sections: [
          generic(r, "Check"),
          ...(Object.keys(analytics).length > 0
            ? [
                section("Last 7 days", [
                  kv([
                    [
                      "Availability",
                      analytics["availability"] !== undefined
                        ? `${analytics["availability"].toFixed(2)}%`
                        : "",
                    ],
                    [
                      "Average response time",
                      ms(
                        analytics["responseTime_avg"] ??
                          analytics["total_avg"] ??
                          analytics["latencyAvg_avg"],
                      ),
                    ],
                    [
                      "P95 response time",
                      ms(analytics["responseTime_p95"] ?? analytics["total_p95"]),
                    ],
                    ["P95 Largest Contentful Paint", ms(analytics["LCP_p95"])],
                    [
                      "Packet loss",
                      analytics["packetLoss_avg"] !== undefined
                        ? `${analytics["packetLoss_avg"].toFixed(2)}%`
                        : "",
                    ],
                  ]),
                ]),
              ]
            : []),
        ],
        headerActions: [
          action("Run now", "run", { success: "Check run started." }),
          f["activated"] === false
            ? action("Activate", "activate", { success: "Check activated." })
            : action("Deactivate", "deactivate", {
                confirm: "Deactivate this check? It stops running until activated.",
                success: "Check deactivated.",
              }),
          f["muted"] === true
            ? action("Unmute", "unmute", { success: "Alerts unmuted." })
            : action("Mute", "mute", { success: "Alerts muted." }),
          ...open(`${APP}/checks/${encodeURIComponent(r.externalId ?? "")}`),
          REFRESH,
        ],
      };
    }
    case "check-group":
      return {
        ...base,
        sections: [generic(r, "Check group")],
        headerActions: [
          action("Run all checks", "run", { success: "Check runs started." }),
          f["activated"] === false
            ? action("Activate", "activate", { success: "Group activated." })
            : action("Deactivate", "deactivate", {
                confirm: "Deactivate every check in this group?",
                success: "Group deactivated.",
              }),
          f["muted"] === true
            ? action("Unmute", "unmute", { success: "Group unmuted." })
            : action("Mute", "mute", { success: "Group muted." }),
          REFRESH,
        ],
      };
    case "private-location":
      return {
        ...base,
        sections: [
          generic(r, "Private location"),
          section("Running agents", [
            {
              kind: "text",
              variant: "muted",
              content:
                "Start the Checkly agent container with API_KEY set to an agent key. Generate agent key creates one and keeps it as the Agent API Key output, which you can export to a Kubernetes secret or a server.",
            },
          ]),
        ],
        headerActions: [
          action("Generate agent key", "generate-key", {
            success: "Agent key created. Read it from the Agent API Key output.",
          }),
          REFRESH,
        ],
      };
    case "dashboard":
    case "status-page":
      return {
        ...base,
        subtitle: joinSubtitle(LABEL[r.resourceTypeId] ?? "", str(f["url"])),
        sections: [generic(r, LABEL[r.resourceTypeId] ?? "Details")],
        headerActions: [
          ...(f["url"]
            ? [
                {
                  kind: "action" as const,
                  label: "Open",
                  action: { type: "open-url" as const, url: str(f["url"]) },
                },
              ]
            : []),
          REFRESH,
        ],
      };
    default:
      return {
        ...base,
        sections: [generic(r, LABEL[r.resourceTypeId] ?? "Details")],
        headerActions: [REFRESH],
      };
  }
}

export function renderChecklyDetail(r: ResourceInstance): DetailViewSchema {
  return withMetricsCapability(
    body(r),
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

export function renderChecklySidebar(r: ResourceInstance): SidebarItemSchema {
  const status = checklyStatus(r);
  return { id: r.id, label: r.displayName, ...(status ? { status } : {}) };
}
