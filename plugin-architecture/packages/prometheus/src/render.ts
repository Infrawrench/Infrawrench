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
} from "@infrawrench/plugin-base";
import { camelToTitle, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

export const COMMANDS = { createSilence: "create-silence", deleteSeries: "delete-series" } as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const MONO = new Set(["query", "labels", "matchers", "annotations"]);

function fieldsNode(r: ResourceInstance, skip: string[] = []): SchemaNode[] {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  const blocks: SchemaNode[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (skip.includes(key) || value === "") continue;
    const label = labels.get(key) ?? camelToTitle(key);
    if (MONO.has(key) && String(value).length > 60) {
      blocks.push({ kind: "text", content: label, variant: "subheading" });
      blocks.push({ kind: "text", content: String(value), variant: "mono", copyable: true });
      continue;
    }
    items.push({
      key: label,
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  return [{ kind: "key-value-list", items }, ...blocks];
}

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});
const openUrl = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function pluginAction(
  label: string,
  actionId: string,
  successMessage: string,
  opts: { confirm?: string; destructive?: boolean; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

export function silenceFields(matchers: string): CreateFieldConfig[] {
  return [
    {
      key: "matchers",
      label: "Matchers",
      kind: "text",
      required: true,
      defaultValue: matchers,
      placeholder: 'alertname="DiskFull", instance=~"db-.*"',
      description: "Alerts matching every matcher are muted. Operators = != =~ !~ as in PromQL.",
    },
    {
      key: "duration",
      label: "For",
      kind: "select",
      required: true,
      defaultValue: "2h",
      options: ["1h", "2h", "4h", "12h", "1d", "3d", "7d"].map((d) => ({ id: d, label: d })),
    },
    {
      key: "createdBy",
      label: "Created by",
      kind: "text",
      required: true,
      defaultValue: "Infrawrench",
    },
    {
      key: "comment",
      label: "Comment",
      kind: "text",
      required: true,
      placeholder: "Investigating",
    },
  ];
}

function silenceAction(matchers: string, hasAm: boolean): ActionNode[] {
  if (!hasAm || !matchers) return [];
  return [
    {
      kind: "action",
      label: "Silence",
      action: {
        type: "prompt-nosql-command",
        command: COMMANDS.createSilence,
        title: "Create silence",
        description:
          "Alertmanager stops notifying for alerts that match every matcher until the silence ends.",
        submitLabel: "Silence",
        fields: silenceFields(matchers),
      },
    },
  ];
}

function healthStatus(health: string): ResourceStatus {
  return health === "up" || health === "ok"
    ? "healthy"
    : health === "unknown" || !health
      ? "unknown"
      : "error";
}

function alertStatus(state: string): ResourceStatus {
  return state === "firing" || state === "active"
    ? "error"
    : state === "pending"
      ? "degraded"
      : "info";
}

export function renderPromDetail(
  r: ResourceInstance,
  baseUrl: string,
  amUrl: string | undefined,
): DetailViewSchema {
  const f = r.fields;
  const base = (subtitle: string, extra: Partial<DetailViewSchema> = {}): DetailViewSchema =>
    withMetricsCapability(
      {
        title: r.displayName || "Prometheus",
        subtitle,
        sections: [section("Details", fieldsNode(r))],
        ...extra,
      },
      RESOURCE_TYPES,
      r.resourceTypeId,
    );
  const graph = (q: string) => `${baseUrl}/graph?g0.expr=${encodeURIComponent(q)}&g0.tab=0`;
  switch (r.resourceTypeId) {
    case "prometheus-server": {
      const down = Number(f["targetsDown"] ?? 0);
      const firing = Number(f["alertsFiring"] ?? 0);
      return base(
        joinSubtitle(
          "Prometheus",
          f["version"] ? `v${str(f["version"])}` : "",
          f["storageRetention"] ? `retention ${str(f["storageRetention"])}` : "",
        ),
        {
          status: {
            kind: "status-dot",
            ...(f["reloadConfigSuccess"] === false
              ? { status: "error" as const, label: "Config reload failed" }
              : firing
                ? { status: "error" as const, label: `${firing} firing` }
                : down
                  ? { status: "degraded" as const, label: `${down} targets down` }
                  : { status: "healthy" as const, label: "Healthy" }),
          },
          sqlEditor: { connectionStringOutputKey: "url", defaultQuery: "sum by (job) (up)" },
          manifestEditor: { language: "yaml", readOnly: true, resourceKind: "Configuration" },
          describe: { language: "text" },
          headerActions: [
            openUrl("Open Prometheus", `${baseUrl}/`),
            pluginAction("Reload config", "reload", "Configuration reloaded", {
              confirm:
                "Reload the configuration and rule files from disk? Needs --web.enable-lifecycle.",
            }),
            pluginAction("Snapshot TSDB", "snapshot", "Snapshot written to the data directory", {
              confirm:
                "Write a snapshot of all current data under <data-dir>/snapshots? Needs --web.enable-admin-api and the disk space for it.",
            }),
            pluginAction("Clean tombstones", "clean-tombstones", "Tombstones cleaned", {
              confirm: "Remove deleted series from disk now? Needs --web.enable-admin-api.",
            }),
            {
              kind: "action",
              label: "Delete series",
              variant: "danger",
              action: {
                type: "prompt-nosql-command",
                command: COMMANDS.deleteSeries,
                title: "Delete series",
                description:
                  "Marks matching samples deleted; they disappear from queries at once and from disk on the next compaction or Clean tombstones. Needs --web.enable-admin-api. This cannot be undone.",
                submitLabel: "Delete",
                danger: true,
                fields: [
                  {
                    key: "match",
                    label: "Series selector",
                    kind: "text",
                    required: true,
                    placeholder: '{job="old-exporter"}',
                  },
                  {
                    key: "start",
                    label: "From",
                    kind: "text",
                    required: false,
                    placeholder: "2026-01-01T00:00:00Z (empty: the beginning)",
                  },
                  {
                    key: "end",
                    label: "Until",
                    kind: "text",
                    required: false,
                    placeholder: "Empty: now",
                  },
                ],
              },
            },
          ],
        },
      );
    }
    case "prometheus-scrape-pool": {
      const down = Number(f["down"] ?? 0);
      return base("Scrape pool", {
        status: {
          kind: "status-dot",
          status: Number(f["targets"] ?? 0) === 0 ? "info" : down ? "degraded" : "healthy",
          label: `${str(f["up"] || 0)}/${str(f["targets"] || 0)} up`,
        },
        manifestEditor: { language: "yaml", readOnly: true, resourceKind: "Configuration" },
        headerActions: [
          openUrl(
            "Open in Prometheus",
            `${baseUrl}/targets?pool=${encodeURIComponent(str(f["name"]))}`,
          ),
        ],
      });
    }
    case "prometheus-target":
      return base(joinSubtitle("Target", f["scrapePool"]), {
        status: {
          kind: "status-dot",
          status: healthStatus(str(f["health"])),
          label: str(f["health"]) || "unknown",
        },
        headerActions: [
          ...(f["scrapeUrl"] ? [openUrl("Open scrape URL", str(f["scrapeUrl"]))] : []),
          openUrl("Graph up", graph(`up{job="${str(f["job"])}",instance="${str(f["instance"])}"}`)),
        ],
      });
    case "prometheus-rule-group":
      return base(joinSubtitle("Rule group", f["file"]), {
        status: {
          kind: "status-dot",
          status: Number(f["unhealthy"] ?? 0) ? "error" : "healthy",
          label: Number(f["unhealthy"] ?? 0) ? `${str(f["unhealthy"])} unhealthy` : "ok",
        },
      });
    case "prometheus-rule": {
      const alerting = f["type"] === "alerting";
      return base(joinSubtitle(alerting ? "Alerting rule" : "Recording rule", f["group"]), {
        status: {
          kind: "status-dot",
          status:
            f["health"] && f["health"] !== "ok"
              ? "error"
              : alerting
                ? alertStatus(str(f["state"]))
                : "healthy",
          label:
            f["health"] && f["health"] !== "ok"
              ? str(f["health"])
              : alerting
                ? str(f["state"]) || "inactive"
                : "ok",
        },
        headerActions: [
          openUrl("Graph expression", graph(str(f["query"]))),
          ...(alerting ? silenceAction(`alertname="${str(f["name"])}"`, !!amUrl) : []),
        ],
      });
    }
    case "prometheus-alert":
      return base(joinSubtitle("Alert", f["severity"], f["state"]), {
        status: {
          kind: "status-dot",
          status: alertStatus(str(f["state"])),
          label: str(f["state"]),
        },
        headerActions: silenceAction(str(f["labels"]), !!amUrl),
      });
    case "prometheus-alertmanager":
      return base(joinSubtitle("Alertmanager", f["version"] ? `v${str(f["version"])}` : ""), {
        status: {
          kind: "status-dot",
          status:
            !f["clusterStatus"] ||
            f["clusterStatus"] === "ready" ||
            f["clusterStatus"] === "disabled"
              ? "healthy"
              : "degraded",
          label: str(f["clusterStatus"]) || "ready",
        },
        manifestEditor: { language: "yaml", readOnly: true, resourceKind: "Configuration" },
        headerActions: [openUrl("Open Alertmanager", `${str(f["url"])}/`)],
      });
    case "prometheus-silence": {
      const state = str(f["state"]);
      return base(joinSubtitle("Silence", state), {
        status: {
          kind: "status-dot",
          status: state === "active" ? "healthy" : state === "pending" ? "info" : "unknown",
          label: state || "unknown",
        },
        headerActions:
          state === "expired"
            ? []
            : [
                pluginAction("Expire", "expire", "Silence expired", {
                  confirm: "End this silence now? Matching alerts notify again.",
                }),
              ],
      });
    }
    case "prometheus-am-alert": {
      const state = str(f["state"]);
      return base(joinSubtitle("Alertmanager alert", f["severity"], state), {
        status: {
          kind: "status-dot",
          status: state === "active" ? "error" : state === "suppressed" ? "info" : "unknown",
          label: state || "unknown",
        },
        headerActions: [
          ...(f["generatorUrl"] ? [openUrl("Open source", str(f["generatorUrl"]))] : []),
          ...silenceAction(str(f["labels"]), !!amUrl),
        ],
      });
    }
    case "prometheus-receiver":
      return base("Receiver");
    default:
      return base("Prometheus");
  }
}

export function renderPromSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "prometheus-target") status = healthStatus(str(f["health"]));
  if (r.resourceTypeId === "prometheus-alert") status = alertStatus(str(f["state"]));
  if (r.resourceTypeId === "prometheus-rule" && f["type"] === "alerting")
    status = alertStatus(str(f["state"]));
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
