import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { DEFINITION_KEYS } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, SLO_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `enrichDetail` stashes data the synchronous renderer needs. */
export const RECIPIENT_TRIGGERS_KEY = "__recipientTriggers__";

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
  opts: { confirm?: string; success?: string; destructive?: boolean; variant?: "danger" } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function openUrl(url: string): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in Honeycomb", action: { type: "open-url", url } }]
    : [];
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function dot(status: ResourceStatus, label: string): StatusDotNode {
  return { kind: "status-dot", status, label };
}

/** Status for a resource's sidebar dot and detail header. */
export function honeycombStatus(r: ResourceInstance): StatusDotNode | undefined {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "environment":
      return f["connected"] === true
        ? dot("healthy", "Connected")
        : dot("unknown", "Not connected");
    case "dataset": {
      const last = Date.parse(str(f["lastWrittenAt"]));
      if (!Number.isFinite(last)) return dot("unknown", "No events yet");
      return Date.now() - last < 24 * 3600_000
        ? dot("healthy", "Receiving events")
        : dot("unknown", "No events in 24h");
    }
    case "trigger":
      if (f["disabled"] === true) return dot("unknown", "Disabled");
      return f["triggered"] === true ? dot("error", "Triggered") : dot("healthy", "OK");
    case "burn-alert":
      return f["triggered"] === true ? dot("error", "Triggered") : dot("healthy", "OK");
    case "slo": {
      const status = str(f["status"]);
      if (status === "triggered") return dot("error", "Burn alert triggered");
      if (status === "no_events") return dot("unknown", "No events");
      if (status === "normal") return dot("healthy", "Normal");
      return undefined;
    }
    case "signal":
      if (f["enabled"] !== true) return dot("unknown", "Off");
      return f["currentlyAnomalous"] === true
        ? dot("error", "Anomalous")
        : dot("healthy", str(f["status"]) || "Normal");
    case "api-key":
      return f["disabled"] === true ? dot("unknown", "Disabled") : dot("healthy", "Enabled");
    default:
      return undefined;
  }
}

function genericSection(r: ResourceInstance, title: string, skip: string[] = []): SectionNode {
  const type = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const items: Array<[string, unknown, boolean?]> = [];
  for (const field of type?.fields ?? []) {
    if (field.kind === "password" || skip.includes(field.key)) continue;
    const value = r.fields[field.key];
    items.push([field.label, value, field.key.endsWith("Id") || field.key === "slug"]);
  }
  return section(title, [kv(items)]);
}

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  RESOURCE_TYPES.map((t) => [t.id, t.displayName]),
);

function scopeLabel(r: ResourceInstance): string {
  const env = str(r.fields["environment"]);
  const dataset = str(r.fields["dataset"]);
  if (!env) return "";
  return dataset ? `${env} / ${dataset}` : `${env} (all datasets)`;
}

function renderBody(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const status = honeycombStatus(r);
  const base = {
    title: r.displayName,
    subtitle: joinSubtitle(TYPE_LABEL[r.resourceTypeId] ?? r.resourceTypeId, scopeLabel(r)),
    ...(status ? { status } : {}),
  };
  switch (r.resourceTypeId) {
    case "environment": {
      const connected = f["connected"] === true;
      return {
        ...base,
        subtitle: joinSubtitle("Environment", str(f["team"]), str(f["region"]).toUpperCase()),
        sections: [
          genericSection(r, "Environment", ["connected"]),
          ...(connected
            ? []
            : [
                section("Not connected", [
                  {
                    kind: "text",
                    variant: "muted",
                    content: f["environmentId"]
                      ? "Infrawrench has no configuration key for this environment, so its datasets, triggers, SLOs and boards are not listed. Use Connect environment to create a key with the management key, or edit the environment and paste one."
                      : "Edit the environment and paste a configuration key to list what is inside it.",
                  },
                ]),
              ]),
        ],
        headerActions: [
          ...(!connected && f["environmentId"]
            ? [
                action("Connect environment", "connect", {
                  success: "Environment connected. Refresh the account to list its contents.",
                }),
              ]
            : []),
          ...openUrl(str(r.resolvedOutputs["url"])),
          REFRESH,
        ],
      };
    }
    case "dataset": {
      const defs: Array<[string, unknown]> = DEFINITION_KEYS.map((k) => [
        RESOURCE_TYPES.find((t) => t.id === "dataset")?.fields.find((x) => x.key === `def_${k}`)
          ?.label ?? k,
        f[`def_${k}`],
      ]);
      return {
        ...base,
        sections: [
          genericSection(
            r,
            "Dataset",
            DEFINITION_KEYS.map((k) => `def_${k}`),
          ),
          section("Dataset definitions", [
            {
              kind: "text",
              variant: "muted",
              content:
                "The columns Honeycomb reads as trace ids, durations, errors and so on. Edit the dataset to change them; a blank value uses Honeycomb's default.",
            },
            kv(defs),
          ]),
        ],
        headerActions: [...openUrl(str(r.resolvedOutputs["url"])), REFRESH],
      };
    }
    case "trigger": {
      const disabled = f["disabled"] === true;
      return {
        ...base,
        sections: [
          genericSection(r, "Trigger", ["query"]),
          section("Query", [
            { kind: "text", variant: "mono", content: str(f["query"]) || "(stored query)" },
          ]),
        ],
        headerActions: [
          disabled
            ? action("Enable", "enable", { success: "Trigger enabled." })
            : action("Disable", "disable", { success: "Trigger disabled." }),
          REFRESH,
        ],
      };
    }
    case "saved-query":
      return {
        ...base,
        sections: [
          genericSection(r, "Saved query", ["query"]),
          section("Query", [
            { kind: "text", variant: "mono", content: str(f["query"]) || "(stored query)" },
          ]),
        ],
        headerActions: [REFRESH],
      };
    case "slo":
      return {
        ...base,
        sections: [
          genericSection(r, "SLO"),
          ...(f["compliance"] === undefined
            ? [
                section("Reporting", [
                  {
                    kind: "text",
                    variant: "muted",
                    content:
                      "Compliance, burn rate and remaining budget come from Honeycomb's detailed SLO API, which is part of the Enterprise plan. The Metrics tab charts good and failed events either way.",
                  },
                ]),
              ]
            : []),
        ],
        headerActions: [REFRESH],
      };
    case "recipient": {
      const triggers = (() => {
        try {
          return JSON.parse(r.resolvedOutputs[RECIPIENT_TRIGGERS_KEY] ?? "[]") as Array<{
            name?: string;
            dataset?: string;
          }>;
        } catch {
          return [];
        }
      })();
      return {
        ...base,
        sections: [
          genericSection(r, "Recipient"),
          ...(triggers.length > 0
            ? [
                section("Triggers that notify this recipient", [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "name", label: "Trigger", width: "wide" as const },
                      { key: "dataset", label: "Dataset" },
                    ],
                    rows: triggers.map((t) => ({
                      cells: { name: str(t.name), dataset: str(t.dataset) || "all datasets" },
                    })),
                  },
                ]),
              ]
            : []),
        ],
        headerActions: [REFRESH],
      };
    }
    case "signal":
      return {
        ...base,
        sections: [genericSection(r, "Signal")],
        headerActions: [
          f["enabled"] === true
            ? action("Turn off", "disable", { success: "Signal turned off." })
            : action("Turn on", "enable", { success: "Signal turned on." }),
          REFRESH,
        ],
      };
    case "api-key":
      return {
        ...base,
        subtitle: joinSubtitle("API Key", str(f["keyType"]), str(f["environment"])),
        sections: [genericSection(r, "API key")],
        headerActions: [
          f["disabled"] === true
            ? action("Enable", "enable", { success: "Key enabled." })
            : action("Disable", "disable", {
                confirm:
                  "Disable this key? Anything using it stops working until it is enabled again.",
                success: "Key disabled.",
              }),
          REFRESH,
        ],
      };
    case "board":
      return {
        ...base,
        sections: [genericSection(r, "Board")],
        headerActions: [...openUrl(str(f["url"])), REFRESH],
      };
    default:
      return {
        ...base,
        sections: [genericSection(r, TYPE_LABEL[r.resourceTypeId] ?? "Details")],
        headerActions: [REFRESH],
      };
  }
}

export function renderHoneycombDetail(r: ResourceInstance): DetailViewSchema {
  const window = r.resourceTypeId === "slo" ? SLO_METRICS_WINDOW_MS : DEFAULT_METRICS_WINDOW_MS;
  return withMetricsCapability(renderBody(r), RESOURCE_TYPES, r.resourceTypeId, window);
}

export function renderHoneycombSidebar(r: ResourceInstance): SidebarItemSchema {
  const status = honeycombStatus(r);
  return { id: r.id, label: r.displayName, ...(status ? { status } : {}) };
}
