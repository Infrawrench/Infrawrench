import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  PublishPanelCapability,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableNode,
} from "@infrawrench/plugin-base";
import {
  camelToTitle,
  formatBytes,
  joinSubtitle,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

export const COMMANDS = {
  editDefinition: "edit-definition",
  setPassword: "set-password",
  closeConnection: "close-connection",
} as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const BYTES = new Set([
  "memUsed",
  "memLimit",
  "diskFree",
  "diskFreeLimit",
  "memory",
  "messageBytes",
]);
const HIDDEN = new Set(["sourceRef", "destinationQueueRef", "destinationExchangeRef", "isSelf"]);

function fieldsNode(r: ResourceInstance, skip: string[] = []): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (skip.includes(key) || HIDDEN.has(key) || value === "") continue;
    let text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    if (BYTES.has(key) && typeof value === "number") text = formatBytes(value);
    if (key === "uptimeSeconds" && typeof value === "number") text = duration(value);
    items.push({ key: labels.get(key) ?? camelToTitle(key), value: text });
  }
  return { kind: "key-value-list", items };
}

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
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

const openUrl = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

/** A table from a JSON array the client stashed in `resolvedOutputs` during enrichDetail. */
function stashedTable(
  r: ResourceInstance,
  key: string,
  columns: Array<[string, string]>,
): TableNode | null {
  const raw = r.resolvedOutputs[key];
  if (!raw) return null;
  let rows: Array<Record<string, string>>;
  try {
    rows = JSON.parse(raw) as Array<Record<string, string>>;
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  return {
    kind: "table",
    columns: columns.map(([k, label]) => ({ key: k, label })),
    rows: rows.map((row) => ({
      cells: Object.fromEntries(columns.map(([k]) => [k, str(row[k])])),
    })),
  };
}

function withTables(
  sections: SectionNode[],
  tables: Array<[string, TableNode | null]>,
): SectionNode[] {
  for (const [title, t] of tables) if (t) sections.push(section(title, [t]));
  return sections;
}

function publishPanel(r: ResourceInstance, viaDefault: boolean): PublishPanelCapability {
  return {
    subtitle: viaDefault
      ? `Publishes through the default exchange with routing key "${str(r.fields["name"])}".`
      : `Publishes to the ${str(r.fields["type"])} exchange "${str(r.fields["name"])}".`,
    bodyFormat: "text",
    defaultBody: '{\n  "hello": "world"\n}',
    helpText:
      "The body is sent as-is (UTF-8). The management API publishes with publisher confirms; use a client library for throughput.",
    submitLabel: "Publish",
    extraFields: [
      ...(viaDefault
        ? []
        : [
            {
              key: "routingKey",
              label: "Routing key",
              kind: "text" as const,
              placeholder: "orders.created",
              optional: true,
            },
          ]),
      {
        key: "contentType",
        label: "Content type",
        kind: "text",
        defaultValue: "application/json",
        optional: true,
      },
      {
        key: "deliveryMode",
        label: "Delivery mode",
        kind: "select",
        defaultValue: "2",
        options: [
          { value: "2", label: "Persistent" },
          { value: "1", label: "Transient" },
        ],
      },
      { key: "messageId", label: "Message ID", kind: "text", optional: true },
      { key: "correlationId", label: "Correlation ID", kind: "text", optional: true },
      { key: "headers", label: "Headers", kind: "key-value-list", optional: true },
    ],
  };
}

function queueStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  const state = str(f["state"]);
  if (state && !["running", "idle", "live"].includes(state))
    return { status: "error", label: state };
  if (Number(f["messagesReady"] ?? 0) > 0 && Number(f["consumers"] ?? 0) === 0)
    return { status: "degraded", label: "No consumers" };
  return { status: "healthy", label: state || "running" };
}

function nodeStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  if (f["running"] === false) return { status: "error", label: "Down" };
  if (f["memAlarm"] === true) return { status: "error", label: "Memory alarm" };
  if (f["diskFreeAlarm"] === true) return { status: "error", label: "Disk alarm" };
  if (str(f["partitions"])) return { status: "degraded", label: "Partitioned" };
  return { status: "healthy", label: "Running" };
}

export function renderRabbitDetail(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  const ui = `${baseUrl}/#`;
  const vh = encodeURIComponent(str(f["vhost"]) || "/");
  const nm = encodeURIComponent(str(f["name"]));
  const base = (subtitle: string, extra: Partial<DetailViewSchema> = {}): DetailViewSchema =>
    withMetricsCapability(
      {
        title: r.displayName || str(f["name"]) || "RabbitMQ",
        subtitle,
        sections: [section("Details", [fieldsNode(r)])],
        ...extra,
      },
      RESOURCE_TYPES,
      r.resourceTypeId,
    );
  switch (r.resourceTypeId) {
    case "rabbitmq-cluster": {
      const alarms = str(f["alarms"]);
      return base(
        joinSubtitle(
          "RabbitMQ",
          f["rabbitmqVersion"] ? `v${str(f["rabbitmqVersion"])}` : "",
          f["node"],
        ),
        {
          status: {
            kind: "status-dot",
            ...(alarms && alarms !== "none"
              ? { status: "error" as const, label: "Alarm" }
              : { status: "healthy" as const, label: "Healthy" }),
          },
          manifestEditor: { language: "json", resourceKind: "Definitions" },
          headerActions: [
            openUrl("Open management UI", `${baseUrl}/`),
            pluginAction("Rebalance queues", "rebalance", "Queue leader rebalance started", {
              confirm:
                "Move quorum queue and stream leaders so they spread evenly across nodes? Clients may see a brief leader election per queue.",
            }),
          ],
        },
      );
    }
    case "rabbitmq-node":
      return base(joinSubtitle("Node", f["type"]), {
        status: { kind: "status-dot", ...nodeStatus(f) },
        headerActions: [openUrl("Open in management UI", `${ui}/nodes/${nm}`)],
      });
    case "rabbitmq-vhost":
      return base(
        joinSubtitle(
          "Virtual host",
          f["defaultQueueType"] ? `default ${str(f["defaultQueueType"])}` : "",
        ),
        {
          status: {
            kind: "status-dot",
            status: !f["state"] || f["state"] === "running" ? "healthy" : "degraded",
            label: str(f["state"]) || "running",
          },
          headerActions: [openUrl("Open in management UI", `${ui}/vhosts/${nm}`)],
        },
      );
    case "rabbitmq-exchange":
      return base(joinSubtitle(`${str(f["type"])} exchange`, `vhost ${str(f["vhost"])}`), {
        sections: withTables(
          [section("Details", [fieldsNode(r)])],
          [
            [
              "Bindings from this exchange",
              stashedTable(r, "__bindings__", [
                ["destination", "Destination"],
                ["key", "Routing key"],
                ["args", "Arguments"],
              ]),
            ],
          ],
        ),
        publishPanel: publishPanel(r, false),
        headerActions: [openUrl("Open in management UI", `${ui}/exchanges/${vh}/${nm}`)],
      });
    case "rabbitmq-queue": {
      const stream = f["queueType"] === "stream";
      return base(
        joinSubtitle(`${str(f["queueType"]) || "classic"} queue`, `vhost ${str(f["vhost"])}`),
        {
          status: { kind: "status-dot", ...queueStatus(f) },
          sections: withTables(
            [section("Details", [fieldsNode(r)])],
            [
              [
                "Consumers",
                stashedTable(r, "__consumers__", [
                  ["tag", "Consumer tag"],
                  ["connection", "Connection"],
                  ["user", "User"],
                  ["prefetch", "Prefetch"],
                  ["ack", "Ack"],
                  ["active", "Active"],
                ]),
              ],
              [
                "Bindings",
                stashedTable(r, "__bindings__", [
                  ["source", "Exchange"],
                  ["key", "Routing key"],
                  ["args", "Arguments"],
                ]),
              ],
            ],
          ),
          describe: { language: "text" },
          publishPanel: publishPanel(r, true),
          headerActions: [
            openUrl("Open in management UI", `${ui}/queues/${vh}/${nm}`),
            ...(stream
              ? []
              : [
                  pluginAction("Purge", "purge", "Queue purged", {
                    confirm: `Delete every ready message in ${str(f["name"])}? Unacknowledged messages are kept. This cannot be undone.`,
                    destructive: true,
                    variant: "danger",
                  }),
                ]),
          ],
        },
      );
    }
    case "rabbitmq-binding":
      return base(joinSubtitle("Binding", `vhost ${str(f["vhost"])}`));
    case "rabbitmq-policy":
    case "rabbitmq-operator-policy": {
      let pretty = str(f["definition"]) || "{}";
      try {
        pretty = JSON.stringify(JSON.parse(pretty), null, 2);
      } catch {
        // Leave as is.
      }
      const label = r.resourceTypeId === "rabbitmq-policy" ? "Policy" : "Operator policy";
      return base(joinSubtitle(label, `vhost ${str(f["vhost"])}`, f["applyTo"]), {
        sections: [
          section("Details", [fieldsNode(r, ["definition"])]),
          section("Definition", [
            { kind: "text", content: pretty, variant: "mono", copyable: true },
          ]),
        ],
        headerActions: [
          {
            kind: "action",
            label: "Edit definition",
            action: {
              type: "prompt-nosql-command",
              command: COMMANDS.editDefinition,
              title: `Edit ${r.displayName}`,
              description:
                "Saving replaces the definition. Matching queues and exchanges pick it up immediately.",
              submitLabel: "Save definition",
              fields: [
                {
                  key: "definition",
                  label: "Definition (JSON)",
                  kind: "code",
                  codeLanguage: "json",
                  required: true,
                  defaultValue: pretty,
                },
              ],
            },
          },
        ],
      });
    }
    case "rabbitmq-user":
      return base(joinSubtitle("User", f["tags"]), {
        sections: withTables(
          [section("Details", [fieldsNode(r)])],
          [
            [
              "Permissions",
              stashedTable(r, "__permissions__", [
                ["vhost", "Virtual host"],
                ["configure", "Configure"],
                ["write", "Write"],
                ["read", "Read"],
              ]),
            ],
          ],
        ),
        headerActions: [
          {
            kind: "action",
            label: "Set password",
            action: {
              type: "prompt-nosql-command",
              command: COMMANDS.setPassword,
              title: `Set password for ${r.displayName}`,
              description: "Replaces the user's password. Existing connections stay open.",
              submitLabel: "Set password",
              fields: [
                { key: "password", label: "New password", kind: "password", required: true },
              ],
            },
          },
        ],
      });
    case "rabbitmq-permission":
      return base(joinSubtitle("Permission", `vhost ${str(f["vhost"])}`));
    case "rabbitmq-topic-permission":
      return base(joinSubtitle("Topic permission", `vhost ${str(f["vhost"])}`));
    case "rabbitmq-connection":
      return base(joinSubtitle(str(f["protocol"]) || "Connection", f["user"], f["peer"]), {
        status: {
          kind: "status-dot",
          status: !f["state"] || f["state"] === "running" ? "healthy" : "degraded",
          label: str(f["state"]) || "running",
        },
        headerActions: [
          {
            kind: "action",
            label: "Close connection",
            variant: "danger",
            action: {
              type: "prompt-nosql-command",
              command: COMMANDS.closeConnection,
              title: "Close connection",
              description:
                "The client is disconnected and told the reason. Most clients reconnect on their own.",
              submitLabel: "Close",
              danger: true,
              fields: [
                {
                  key: "reason",
                  label: "Reason",
                  kind: "text",
                  required: false,
                  defaultValue: "Closed from Infrawrench",
                },
              ],
            },
          },
        ],
      });
    case "rabbitmq-channel":
      return base(joinSubtitle("Channel", f["user"]));
    case "rabbitmq-shovel": {
      const state = str(f["state"]);
      return base(joinSubtitle("Shovel", `vhost ${str(f["vhost"])}`), {
        status: {
          kind: "status-dot",
          status: state === "running" ? "healthy" : state === "terminated" ? "error" : "degraded",
          label: state || "unknown",
        },
        headerActions: [pluginAction("Restart", "restart", "Shovel restarting")],
      });
    }
    case "rabbitmq-federation-upstream": {
      const status = str(f["linkStatus"]);
      return base(joinSubtitle("Federation upstream", `vhost ${str(f["vhost"])}`), {
        status: {
          kind: "status-dot",
          status: !status
            ? "info"
            : status === "running"
              ? "healthy"
              : status.includes("error")
                ? "error"
                : "degraded",
          label: status || "no links",
        },
      });
    }
    default:
      return base("RabbitMQ");
  }
}

export function renderRabbitSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "rabbitmq-queue") status = queueStatus(f).status;
  if (r.resourceTypeId === "rabbitmq-node") status = nodeStatus(f).status;
  if (r.resourceTypeId === "rabbitmq-shovel")
    status =
      f["state"] === "running" ? "healthy" : f["state"] === "terminated" ? "error" : "degraded";
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
