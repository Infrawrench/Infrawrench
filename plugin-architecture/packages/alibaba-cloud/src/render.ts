import type {
  ActionNode,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { DEFAULT_METRIC_WINDOW_MS } from "./metrics.js";

/** Fields prefixed with `_` are enrichment payloads for the renderer, not data. */
const PRIVATE_PREFIX = "_";

export function statusOf(value: string): ResourceStatus {
  const s = value.toLowerCase();
  if (!s) return "unknown";
  if (
    [
      "running",
      "available",
      "active",
      "normal",
      "inuse",
      "in_use",
      "enable",
      "ok",
      "accomplished",
    ].includes(s)
  ) {
    return "healthy";
  }
  if (["stopped", "inactive", "disable", "deleted", "released"].includes(s)) return "unknown";
  if (["failed", "error", "locked", "unavailable", "abnormal", "flowing_failed"].includes(s)) {
    return "error";
  }
  if (["expired", "overdue", "warning"].includes(s)) return "degraded";
  if (/ing$/.test(s) || ["pending", "initial", "upgrading"].includes(s)) return "provisioning";
  return "info";
}

function statusLabel(status: ResourceStatus, raw: string): string | undefined {
  if (status === "error") return `Alibaba Cloud reports this resource as ${raw}`;
  if (status === "degraded") return `Alibaba Cloud reports this resource as ${raw}`;
  return undefined;
}

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success: string; danger?: boolean },
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      successMessage: opts.success,
    },
    ...(opts.danger ? { variant: "danger" as const } : {}),
  };
}

function regionOf(resource: ResourceInstance): string {
  return String(resource.fields["region"] ?? "");
}

function bareId(resource: ResourceInstance): string {
  const ext = resource.externalId ?? "";
  return ext.slice(ext.lastIndexOf("/") + 1);
}

export function consoleLink(resource: ResourceInstance): string | null {
  const region = encodeURIComponent(regionOf(resource));
  const id = encodeURIComponent(bareId(resource));
  switch (resource.resourceTypeId) {
    case "ecs-instance":
      return `https://ecs.console.alibabacloud.com/server/${id}/detail?regionId=${region}`;
    case "oss-bucket":
      return `https://oss.console.alibabacloud.com/bucket/oss-${region}/${id}/object`;
    case "dns-domain":
      return `https://dns.console.alibabacloud.com/#/dns/setting/${encodeURIComponent(resource.externalId ?? "")}`;
    case "account":
      return "https://usercenter2-intl.aliyun.com/billing";
    default:
      return null;
  }
}

function actionsFor(resource: ResourceInstance): ActionNode[] {
  const status = String(resource.fields["status"] ?? "");
  switch (resource.resourceTypeId) {
    case "ecs-instance": {
      if (status === "Stopped") return [action("Start", "start", { success: "Start requested." })];
      if (status !== "Running") return [];
      const payg = resource.fields["chargeType"] === "PostPaid";
      const note = payg
        ? "Pay-as-you-go compute stops billing while stopped (economical mode); disks and public IPs keep billing."
        : "Subscription instances keep billing while stopped.";
      return [
        action("Stop", "stop", {
          confirm: `Shut this instance down? ${note}`,
          success: "Stop requested.",
        }),
        action("Reboot", "reboot", {
          confirm: "Reboot this instance?",
          success: "Reboot requested.",
        }),
        action("Force stop", "stop-force", {
          confirm: `Power this instance off without shutting the OS down? ${note}`,
          success: "Stop requested.",
          danger: true,
        }),
      ];
    }
    case "disk": {
      const out = [
        action("Snapshot", "snapshot", {
          confirm: "Take a snapshot of this disk now?",
          success: "Snapshot requested.",
        }),
      ];
      if (status === "In_use" && resource.fields["diskType"] === "data") {
        out.push(
          action("Detach", "detach", {
            confirm: "Detach this disk from its instance? Unmount it in the OS first.",
            success: "Detach requested.",
            danger: true,
          }),
        );
      }
      return out;
    }
    case "eip":
      return status === "InUse"
        ? [
            action("Unassociate", "unassociate", {
              confirm: "Remove this address from the resource it is associated with?",
              success: "Unassociate requested.",
              danger: true,
            }),
          ]
        : [];
    case "slb":
      return status === "active"
        ? [
            action("Stop", "deactivate", {
              confirm: "Stop this load balancer? It stops forwarding traffic.",
              success: "Load balancer stopped.",
              danger: true,
            }),
          ]
        : status === "inactive"
          ? [action("Start", "activate", { success: "Load balancer started." })]
          : [];
    case "rds-instance":
    case "redis-instance":
      return [
        action("Restart", "restart", {
          confirm: "Restart this instance? Connections drop for a short while.",
          success: "Restart requested.",
        }),
      ];
    case "fc-function":
      return [
        action("Disable invocations", "disable-invocation", {
          confirm: "Reject every new invocation of this function until it is enabled again?",
          success: "Invocations disabled.",
          danger: true,
        }),
        action("Enable invocations", "enable-invocation", { success: "Invocations enabled." }),
      ];
    case "dns-record":
      return status === "DISABLE"
        ? [action("Enable", "enable", { success: "Record enabled." })]
        : [
            action("Disable", "disable", {
              confirm: "Stop resolving this record?",
              success: "Record disabled.",
            }),
          ];
    default:
      return [];
  }
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function extraSections(resource: ResourceInstance): SectionNode[] {
  const sections: SectionNode[] = [];
  if (resource.resourceTypeId === "account") {
    const mtd = parseJson<{ currency: string; spent: number; gross: number }>(
      resource.fields["_mtd"],
    );
    const balance = parseJson<{ remaining: number; currency: string }>(resource.fields["_balance"]);
    const items = [
      ...(mtd ? [{ key: "Billed this month", value: money(mtd.spent, mtd.currency) }] : []),
      ...(mtd && mtd.gross > mtd.spent
        ? [{ key: "Before discounts", value: money(mtd.gross, mtd.currency) }]
        : []),
      ...(balance
        ? [{ key: "Account balance", value: money(balance.remaining, balance.currency) }]
        : []),
    ];
    if (items.length) {
      sections.push({
        kind: "section",
        title: "Billing",
        children: [{ kind: "key-value-list", items }],
      });
    }
  }
  if (resource.resourceTypeId === "slb") {
    const listeners = parseJson<Array<{ port: number; protocol: string }>>(
      resource.fields["_listeners"],
    );
    const backends = parseJson<Array<{ id: string; weight: number; type: string }>>(
      resource.fields["_backends"],
    );
    if (listeners?.length) {
      sections.push({
        kind: "section",
        title: "Listeners",
        children: [
          {
            kind: "table",
            columns: [
              { key: "port", label: "Port" },
              { key: "protocol", label: "Protocol" },
            ],
            rows: listeners.map((l) => ({ cells: { port: String(l.port), protocol: l.protocol } })),
          },
        ],
      });
    }
    if (backends?.length) {
      sections.push({
        kind: "section",
        title: "Backend servers",
        children: [
          {
            kind: "table",
            columns: [
              { key: "id", label: "Server" },
              { key: "type", label: "Type" },
              { key: "weight", label: "Weight" },
            ],
            rows: backends.map((b) => ({
              cells: { id: b.id, type: b.type, weight: String(b.weight) },
            })),
          },
        ],
      });
    }
  }
  if (resource.resourceTypeId === "oss-bucket") {
    const stat = parseJson<{ objects: number; bytes: number }>(resource.fields["_stat"]);
    if (stat) {
      sections.push({
        kind: "section",
        title: "Usage",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Objects", value: stat.objects.toLocaleString("en-US") },
              { key: "Stored", value: `${(stat.bytes / 1024 ** 3).toFixed(2)} GB` },
            ],
          },
        ],
      });
    }
  }
  return sections;
}

export function renderDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const fields = Object.fromEntries(
    Object.entries(resource.fields).filter(([k]) => !k.startsWith(PRIVATE_PREFIX)),
  );
  const raw = String(fields["status"] ?? fields["state"] ?? "");
  const status = statusOf(raw);
  const label = statusLabel(status, raw);
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [
        {
          kind: "key-value-list",
          items: labeledFieldItems(fields, resourceTypes, resource.resourceTypeId),
        },
      ],
    },
  ];
  const outputs = Object.fromEntries(
    Object.entries(resource.resolvedOutputs ?? {}).filter(([, v]) => v !== ""),
  );
  if (Object.keys(outputs).length > 0) {
    sections.push({
      kind: "section",
      title: "Outputs",
      children: [
        {
          kind: "key-value-list",
          items: labeledOutputItems(outputs, resourceTypes, resource.resourceTypeId),
        },
      ],
    });
  }
  sections.push(...extraSections(resource));
  const link = consoleLink(resource);
  const schema: DetailViewSchema = {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      fields["region"],
      fields["zoneId"],
    ),
    status: { kind: "status-dot", status, ...(label ? { label } : {}) },
    sections,
    headerActions: [
      ...actionsFor(resource),
      ...(link
        ? [
            {
              kind: "action" as const,
              label: "Open in Alibaba Cloud console",
              action: { type: "open-url" as const, url: link },
            },
          ]
        : []),
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
    ...(resource.resourceTypeId === "oss-bucket" && resource.externalId
      ? { storageBrowser: { bucketName: resource.externalId } }
      : {}),
  };
  return withMetricsCapability(
    schema,
    resourceTypes,
    resource.resourceTypeId,
    DEFAULT_METRIC_WINDOW_MS,
  );
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  const raw = String(resource.fields["status"] ?? resource.fields["state"] ?? "");
  const status = statusOf(raw);
  const label = statusLabel(status, raw);
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status, ...(label ? { label } : {}) },
  };
}
