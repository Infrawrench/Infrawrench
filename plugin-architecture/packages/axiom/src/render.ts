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
import { aplDataset } from "./apl.js";
import { APP_URL } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, USAGE_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `enrichDetail` stashes a monitor's recent alerts. */
export const MONITOR_HISTORY_KEY = "__monitorHistory__";

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

function open(url: string): ActionNode[] {
  return url ? [{ kind: "action", label: "Open in Axiom", action: { type: "open-url", url } }] : [];
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function genericSection(r: ResourceInstance, title: string, skip: string[] = []): SectionNode {
  const type = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const items: Array<[string, unknown, boolean?]> = [];
  for (const field of type?.fields ?? []) {
    if (field.kind === "password" || skip.includes(field.key)) continue;
    items.push([field.label, r.fields[field.key], field.key.endsWith("Id") || field.key === "uid"]);
  }
  return section(title, [kv(items)]);
}

function snoozed(until: unknown): boolean {
  const t = Date.parse(str(until));
  return Number.isFinite(t) && t > Date.now();
}

export function axiomStatus(r: ResourceInstance): StatusDotNode | undefined {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "monitor":
      if (f["disabled"] === true)
        return { kind: "status-dot", status: "unknown", label: "Disabled" };
      if (snoozed(f["disabledUntil"]))
        return { kind: "status-dot", status: "unknown", label: "Snoozed" };
      if (f["state"] === "open") return { kind: "status-dot", status: "error", label: "Alerting" };
      return { kind: "status-dot", status: "healthy", label: "Enabled" };
    case "notifier":
      return snoozed(f["disabledUntil"])
        ? { kind: "status-dot", status: "unknown", label: "Snoozed" }
        : { kind: "status-dot", status: "healthy", label: "Active" };
    case "api-token": {
      const t = Date.parse(str(f["expiresAt"]));
      if (Number.isFinite(t) && t < Date.now())
        return { kind: "status-dot", status: "error", label: "Expired" };
      return { kind: "status-dot", status: "healthy", label: "Active" };
    }
    default:
      return undefined;
  }
}

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  RESOURCE_TYPES.map((t) => [t.id, t.displayName]),
);

function body(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = axiomStatus(r);
  const base = {
    title: r.displayName,
    subtitle: joinSubtitle(TYPE_LABEL[r.resourceTypeId] ?? r.resourceTypeId, str(f["dataset"])),
    ...(status ? { status } : {}),
  };
  switch (r.resourceTypeId) {
    case "organization":
      return {
        ...base,
        subtitle: joinSubtitle("Organization", str(f["plan"]), str(f["defaultEdgeDeployment"])),
        sections: [genericSection(r, "Organization")],
        headerActions: [
          ...open(`${APP_URL}/${encodeURIComponent(str(f["orgId"]))}/settings`),
          REFRESH,
        ],
      };
    case "dataset": {
      const name = str(f["name"]) || r.displayName;
      return {
        ...base,
        subtitle: joinSubtitle("Dataset", str(f["kind"]), str(f["edgeDeployment"])),
        sections: [genericSection(r, "Dataset")],
        headerActions: [
          action("Trim to 30 days", "trim-30d", {
            confirm:
              "Delete every event older than 30 days from this dataset? This cannot be undone.",
            success: "Trim started.",
            destructive: true,
          }),
          action("Trim to 7 days", "trim-7d", {
            confirm:
              "Delete every event older than 7 days from this dataset? This cannot be undone.",
            success: "Trim started.",
            destructive: true,
          }),
          action("Vacuum fields", "vacuum", {
            confirm: "Remove fields that no longer hold any data from this dataset's schema?",
            success: "Vacuum started.",
          }),
          REFRESH,
        ],
        sqlEditor: {
          connectionStringOutputKey: "name",
          defaultQuery: `${aplDataset(name)}\n| sort by _time desc\n| take 100`,
          tables: [{ name: aplDataset(name), columns: [] }],
        },
        logs: { defaultTailLines: 200 },
      };
    }
    case "monitor": {
      let history: Array<{ name?: string; state?: string; timestamp?: string }> = [];
      try {
        history = JSON.parse(r.resolvedOutputs[MONITOR_HISTORY_KEY] ?? "[]");
      } catch {
        history = [];
      }
      const disabled = f["disabled"] === true;
      return {
        ...base,
        subtitle: joinSubtitle("Monitor", str(f["type"])),
        sections: [
          genericSection(r, "Monitor", ["aplQuery"]),
          section("Query", [
            { kind: "text", variant: "mono", content: str(f["aplQuery"]), copyable: true },
          ]),
          ...(history.length > 0
            ? [
                section("Recent alerts", [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "time", label: "Time" },
                      { key: "state", label: "State" },
                      { key: "name", label: "Alert", width: "wide" as const },
                    ],
                    rows: history.slice(0, 50).map((h) => ({
                      cells: {
                        time: str(h.timestamp).replace("T", " ").slice(0, 19),
                        state: str(h.state),
                        name: str(h.name),
                      },
                    })),
                  },
                ]),
              ]
            : []),
        ],
        headerActions: [
          disabled
            ? action("Enable", "enable", { success: "Monitor enabled." })
            : action("Disable", "disable", { success: "Monitor disabled." }),
          ...(snoozed(f["disabledUntil"])
            ? [action("Unsnooze", "unsnooze", { success: "Monitor unsnoozed." })]
            : [
                action("Snooze 1 hour", "snooze-1h", { success: "Monitor snoozed for an hour." }),
                action("Snooze 1 day", "snooze-1d", { success: "Monitor snoozed for a day." }),
              ]),
          ...open(`${APP_URL}/monitors/${encodeURIComponent(r.externalId ?? "")}`),
          REFRESH,
        ],
      };
    }
    case "notifier":
      return {
        ...base,
        subtitle: joinSubtitle("Notifier", str(f["channel"])),
        sections: [genericSection(r, "Notifier")],
        headerActions: [
          ...(snoozed(f["disabledUntil"])
            ? [action("Unsnooze", "unsnooze", { success: "Notifier unsnoozed." })]
            : [
                action("Snooze 1 hour", "snooze-1h", { success: "Notifier snoozed for an hour." }),
                action("Snooze 1 day", "snooze-1d", { success: "Notifier snoozed for a day." }),
              ]),
          REFRESH,
        ],
      };
    case "dashboard":
      return {
        ...base,
        sections: [genericSection(r, "Dashboard")],
        headerActions: [...open(str(f["url"])), REFRESH],
      };
    case "view":
      return {
        ...base,
        sections: [
          genericSection(r, "View", ["aplQuery"]),
          section("Query", [
            { kind: "text", variant: "mono", content: str(f["aplQuery"]), copyable: true },
          ]),
        ],
        headerActions: [REFRESH],
      };
    case "starred-query":
      return {
        ...base,
        sections: [
          genericSection(r, "Saved query", ["apl"]),
          section("APL", [
            { kind: "text", variant: "mono", content: str(f["apl"]), copyable: true },
          ]),
        ],
        headerActions: [REFRESH],
      };
    case "api-token":
      return {
        ...base,
        sections: [genericSection(r, "API token")],
        headerActions: [
          action("Regenerate", "regenerate", {
            confirm:
              "Regenerate this token? The current value stops working in an hour; the new one is shown as the Token output.",
            success: "Token regenerated. Read the new value from the Token output.",
          }),
          REFRESH,
        ],
      };
    default:
      return {
        ...base,
        sections: [genericSection(r, TYPE_LABEL[r.resourceTypeId] ?? "Details")],
        headerActions: [REFRESH],
      };
  }
}

export function renderAxiomDetail(r: ResourceInstance): DetailViewSchema {
  const window =
    r.resourceTypeId === "organization" ? USAGE_METRICS_WINDOW_MS : DEFAULT_METRICS_WINDOW_MS;
  return withMetricsCapability(body(r), RESOURCE_TYPES, r.resourceTypeId, window);
}

export function renderAxiomSidebar(r: ResourceInstance): SidebarItemSchema {
  const status = axiomStatus(r);
  return { id: r.id, label: r.displayName, ...(status ? { status } : {}) };
}
