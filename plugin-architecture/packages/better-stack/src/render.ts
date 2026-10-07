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
import { RESOURCE_TYPES } from "./resource-types.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Keys under which `enrichDetail` stashes data the synchronous renderer needs. */
export const EVENTS_KEY = "__onCallEvents__";
export const SQL_CONNECTED_KEY = "__sqlConnected__";

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

function action(
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

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function open(label: string, url: string): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function generic(r: ResourceInstance, title: string): SectionNode {
  const type = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  return section(title, [
    kv(
      (type?.fields ?? []).map(
        (f) => [f.label, r.fields[f.key], f.key.endsWith("Id")] as [string, unknown, boolean],
      ),
    ),
  ]);
}

function dot(status: StatusDotNode["status"], label: string): StatusDotNode {
  return { kind: "status-dot", status, label };
}

export function betterStackStatus(r: ResourceInstance): StatusDotNode | undefined {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "monitor":
    case "heartbeat": {
      const s = str(f["status"]);
      if (f["paused"] === true || s === "paused") return dot("unknown", "Paused");
      if (s === "up") return dot("healthy", "Up");
      if (s === "down") return dot("error", "Down");
      if (s === "validating") return dot("degraded", "Recovering");
      if (s === "maintenance") return dot("info", "Maintenance");
      return s ? dot("provisioning", s) : undefined;
    }
    case "status-page": {
      const s = str(f["aggregateState"]);
      if (s === "operational") return dot("healthy", "Operational");
      if (s === "downtime") return dot("error", "Downtime");
      if (s === "degraded") return dot("degraded", "Degraded");
      if (s === "maintenance") return dot("info", "Maintenance");
      return undefined;
    }
    case "incident": {
      const s = str(f["status"]);
      if (s === "Resolved") return dot("healthy", "Resolved");
      if (s === "Acknowledged") return dot("degraded", "Acknowledged");
      return dot("error", s || "Open");
    }
    case "source":
      return f["ingestingPaused"] === true
        ? dot("unknown", "Ingesting paused")
        : dot("healthy", "Ingesting");
    default:
      return undefined;
  }
}

const LABEL: Record<string, string> = Object.fromEntries(
  RESOURCE_TYPES.map((t) => [t.id, t.displayName]),
);

function body(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = betterStackStatus(r);
  const base = {
    title: r.displayName,
    subtitle: joinSubtitle(LABEL[r.resourceTypeId] ?? r.resourceTypeId, str(f["team"])),
    ...(status ? { status } : {}),
  };
  const pauseActions = (paused: boolean, noun: string): ActionNode[] =>
    paused
      ? [action("Resume", "resume", { success: `${noun} resumed.` })]
      : [
          action("Pause", "pause", {
            confirm: `Pause this ${noun.toLowerCase()}? You will not be alerted while it is paused.`,
            success: `${noun} paused.`,
          }),
        ];
  switch (r.resourceTypeId) {
    case "monitor":
      return {
        ...base,
        subtitle: joinSubtitle("Monitor", str(f["monitorType"]), str(f["team"])),
        sections: [generic(r, "Monitor")],
        headerActions: [...pauseActions(f["paused"] === true, "Monitor"), REFRESH],
      };
    case "monitor-group":
    case "heartbeat-group":
      return {
        ...base,
        sections: [generic(r, LABEL[r.resourceTypeId] ?? "Group")],
        headerActions: [...pauseActions(f["paused"] === true, "Group"), REFRESH],
      };
    case "heartbeat":
      return {
        ...base,
        sections: [
          generic(r, "Heartbeat"),
          section("Sending heartbeats", [
            {
              kind: "text",
              variant: "muted",
              content:
                "Have your job request the Ping URL output (GET, HEAD or POST) when it finishes. Append /fail to report a failure explicitly.",
            },
          ]),
        ],
        headerActions: [...pauseActions(f["paused"] === true, "Heartbeat"), REFRESH],
      };
    case "status-page":
      return {
        ...base,
        sections: [generic(r, "Status page")],
        headerActions: [...open("Open status page", str(f["url"])), REFRESH],
      };
    case "on-call-calendar": {
      let events: Array<{
        users?: string[];
        starts_at?: string;
        ends_at?: string;
        override?: boolean;
      }> = [];
      try {
        events = JSON.parse(r.resolvedOutputs[EVENTS_KEY] ?? "[]");
      } catch {
        events = [];
      }
      return {
        ...base,
        sections: [
          generic(r, "On-call calendar"),
          ...(events.length > 0
            ? [
                section("Next 14 days", [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "from", label: "From" },
                      { key: "to", label: "To" },
                      { key: "who", label: "On call", width: "wide" as const },
                    ],
                    rows: events.slice(0, 50).map((e) => ({
                      cells: {
                        from: str(e.starts_at).replace("T", " ").slice(0, 16),
                        to: str(e.ends_at).replace("T", " ").slice(0, 16),
                        who: `${(e.users ?? []).join(", ")}${e.override ? " (override)" : ""}`,
                      },
                    })),
                  },
                ]),
              ]
            : []),
        ],
        headerActions: [REFRESH],
      };
    }
    case "incident": {
      const s = str(f["status"]);
      return {
        ...base,
        sections: [generic(r, "Incident")],
        headerActions: [
          ...(s !== "Resolved" && s !== "Acknowledged"
            ? [action("Acknowledge", "acknowledge", { success: "Incident acknowledged." })]
            : []),
          ...(s !== "Resolved"
            ? [action("Resolve", "resolve", { success: "Incident resolved." })]
            : []),
          REFRESH,
        ],
      };
    }
    case "source": {
      const connected = r.resolvedOutputs[SQL_CONNECTED_KEY] === "true";
      const prefix =
        f["teamId"] && f["tableName"] ? `t${str(f["teamId"])}_${str(f["tableName"])}` : "";
      return {
        ...base,
        subtitle: joinSubtitle("Source", str(f["platform"]), str(f["dataRegion"])),
        sections: [
          generic(r, "Source"),
          ...(connected
            ? []
            : [
                section("SQL access", [
                  {
                    kind: "text",
                    variant: "muted",
                    content:
                      "Logs, the SQL editor and the events chart read this source through Better Stack's SQL API. Use Connect SQL access to create a read-only connection for this source's team; Infrawrench keeps its password.",
                  },
                ]),
              ]),
        ],
        headerActions: [
          f["ingestingPaused"] === true
            ? action("Resume ingesting", "resume", { success: "Ingesting resumed." })
            : action("Pause ingesting", "pause", {
                confirm:
                  "Pause ingesting? Events sent to this source are dropped while it is paused.",
                success: "Ingesting paused.",
              }),
          ...(connected
            ? []
            : [action("Connect SQL access", "connect-sql", { success: "SQL access connected." })]),
          REFRESH,
        ],
        ...(prefix
          ? {
              sqlEditor: {
                connectionStringOutputKey: "ingestingHost",
                defaultQuery: `SELECT dt, raw\nFROM remote(${prefix}_logs)\nORDER BY dt DESC\nLIMIT 100`,
                tables: [
                  {
                    name: `remote(${prefix}_logs)`,
                    columns: [
                      { name: "dt", type: "DateTime" },
                      { name: "raw", type: "String" },
                    ],
                  },
                  {
                    name: `remote(${prefix}_metrics)`,
                    columns: [{ name: "dt", type: "DateTime" }],
                  },
                ],
              },
              logs: { defaultTailLines: 200 },
            }
          : {}),
      };
    }
    default:
      return {
        ...base,
        sections: [generic(r, LABEL[r.resourceTypeId] ?? "Details")],
        headerActions: [REFRESH],
      };
  }
}

export function renderBetterStackDetail(r: ResourceInstance): DetailViewSchema {
  return withMetricsCapability(
    body(r),
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

export function renderBetterStackSidebar(r: ResourceInstance): SidebarItemSchema {
  const status = betterStackStatus(r);
  return { id: r.id, label: r.displayName, ...(status ? { status } : {}) };
}
