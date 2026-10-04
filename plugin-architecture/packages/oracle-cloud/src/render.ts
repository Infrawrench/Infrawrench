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
import { parseBucketExternalId } from "./listers.js";

/** Fields prefixed with `_` are enrichment payloads for the renderer, not data. */
const PRIVATE_PREFIX = "_";

export function statusOf(state: string): ResourceStatus {
  const s = state.toUpperCase();
  if (["RUNNING", "AVAILABLE", "ACTIVE", "ASSIGNED", "ATTACHED", "OK"].includes(s))
    return "healthy";
  if (["STOPPED", "INACTIVE", "SHUTOFF"].includes(s)) return "unknown";
  if (
    ["FAILED", "FAULTY", "UNAVAILABLE", "INACCESSIBLE", "CRITICAL", "RESTORE_FAILED"].includes(s)
  ) {
    return "error";
  }
  if (
    ["TERMINATING", "DELETING", "WARNING", "AVAILABLE_NEEDS_ATTENTION", "NEEDS_ATTENTION"].includes(
      s,
    )
  ) {
    return "degraded";
  }
  if (
    /ING$/.test(s) ||
    ["PROVISIONING", "SCALE_IN_PROGRESS", "BACKUP_IN_PROGRESS", "MAINTENANCE_IN_PROGRESS"].includes(
      s,
    )
  ) {
    return "provisioning";
  }
  return "info";
}

function consoleLink(resource: ResourceInstance): string | null {
  const id = resource.externalId ?? "";
  const region = String(resource.fields["region"] ?? "");
  const q = region ? `?region=${encodeURIComponent(region)}` : "";
  switch (resource.resourceTypeId) {
    case "instance":
      return `https://cloud.oracle.com/compute/instances/${id}${q}`;
    case "boot-volume":
      return `https://cloud.oracle.com/block-storage/boot-volumes/${id}${q}`;
    case "block-volume":
      return `https://cloud.oracle.com/block-storage/volumes/${id}${q}`;
    case "vcn":
      return `https://cloud.oracle.com/networking/vcns/${id}${q}`;
    case "load-balancer":
      return `https://cloud.oracle.com/networking/load-balancers/${id}${q}`;
    case "autonomous-database":
      return `https://cloud.oracle.com/db/adbs/${id}${q}`;
    case "oke-cluster":
      return `https://cloud.oracle.com/containers/clusters/${id}${q}`;
    case "compartment":
      return `https://cloud.oracle.com/identity/compartments/${id}`;
    case "budget":
      return `https://cloud.oracle.com/usage/budgets/${id}`;
    case "bucket": {
      const { region: r, name } = parseBucketExternalId(id);
      const ns = String(resource.fields["namespace"] ?? "");
      return `https://cloud.oracle.com/object-storage/buckets/${ns}/${name}/objects?region=${encodeURIComponent(r)}`;
    }
    default:
      return null;
  }
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

function lifecycleActions(resource: ResourceInstance): ActionNode[] {
  const status = String(resource.fields["status"] ?? "").toUpperCase();
  if (resource.resourceTypeId === "instance") {
    if (status === "STOPPED") return [action("Start", "START", { success: "Start requested." })];
    if (status !== "RUNNING") return [];
    const billed = resource.fields["billedWhenStopped"] === true;
    const stopNote = billed
      ? "This shape keeps billing for compute while stopped."
      : "Compute billing pauses while stopped; the boot volume keeps billing.";
    return [
      action("Stop", "SOFTSTOP", {
        confirm: `Shut this instance down gracefully? OCI waits up to 15 minutes for the OS, then powers off. ${stopNote}`,
        success: "Stop requested.",
      }),
      action("Reboot", "SOFTRESET", {
        confirm: "Reboot this instance gracefully?",
        success: "Reboot requested.",
      }),
      action("Force stop", "STOP", {
        confirm: `Power this instance off immediately, without shutting the OS down? ${stopNote}`,
        success: "Stop requested.",
        danger: true,
      }),
      action("Reset", "RESET", {
        confirm: "Hard reset this instance? Unsaved data in memory is lost.",
        success: "Reset requested.",
        danger: true,
      }),
    ];
  }
  if (resource.resourceTypeId === "autonomous-database") {
    if (status === "STOPPED") return [action("Start", "start", { success: "Start requested." })];
    if (status !== "AVAILABLE") return [];
    return [
      action("Stop", "stop", {
        confirm: "Stop this database? Compute billing pauses; storage keeps billing.",
        success: "Stop requested.",
      }),
      action("Restart", "restart", {
        confirm: "Restart this database? Open sessions are disconnected.",
        success: "Restart requested.",
      }),
    ];
  }
  return [];
}

interface TenancyExtras {
  mtd?: { currency: string; spent: number; forecast?: number } | undefined;
  carbon?: { method: string; rows: Array<{ service: string; tonnes: number }> } | undefined;
  commitments?:
    | Array<{
        label: string;
        remaining: number;
        granted?: number;
        currency: string;
        expiresAt?: string;
      }>
    | undefined;
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

function tenancySections(resource: ResourceInstance): SectionNode[] {
  const extras: TenancyExtras = {
    mtd: parseJson(resource.fields["_mtd"]),
    carbon: parseJson(resource.fields["_carbon"]),
    commitments: parseJson(resource.fields["_commitments"]),
  };
  const sections: SectionNode[] = [];
  if (extras.mtd) {
    sections.push({
      kind: "section",
      title: "This month",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Spend so far", value: money(extras.mtd.spent, extras.mtd.currency) },
            ...(extras.mtd.forecast !== undefined
              ? [
                  {
                    key: "OCI month-end forecast",
                    value: money(extras.mtd.forecast, extras.mtd.currency),
                  },
                ]
              : []),
          ],
        },
      ],
    });
  }
  if (extras.commitments && extras.commitments.length > 0) {
    sections.push({
      kind: "section",
      title: "Subscription commitments",
      children: [
        {
          kind: "table",
          columns: [
            { key: "line", label: "Commitment" },
            { key: "remaining", label: "Remaining" },
            { key: "granted", label: "Committed" },
            { key: "ends", label: "Ends" },
          ],
          rows: extras.commitments.map((c) => ({
            cells: {
              line: c.label,
              remaining: money(c.remaining, c.currency),
              granted: c.granted !== undefined ? money(c.granted, c.currency) : "",
              ends: c.expiresAt ? c.expiresAt.slice(0, 10) : "",
            },
          })),
        },
      ],
    });
  }
  if (extras.carbon && extras.carbon.rows.length > 0) {
    const total = extras.carbon.rows.reduce((s, r) => s + r.tonnes, 0);
    sections.push({
      kind: "section",
      title: "Carbon emissions this month (reported by OCI)",
      children: [
        {
          kind: "text",
          variant: "muted",
          content: `${total.toFixed(4)} t CO2e, location-based, ${extras.carbon.method === "POWER_BASED" ? "power-based" : "spend-based"} calculation`,
        },
        {
          kind: "table",
          columns: [
            { key: "service", label: "Service" },
            { key: "tonnes", label: "t CO2e" },
          ],
          rows: extras.carbon.rows.map((r) => ({
            cells: { service: r.service, tonnes: r.tonnes.toFixed(4) },
          })),
        },
      ],
    });
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
  const status = statusOf(String(fields["status"] ?? fields["health"] ?? ""));
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
  if (resource.resourceTypeId === "tenancy") sections.push(...tenancySections(resource));

  const link = consoleLink(resource);
  const schema: DetailViewSchema = {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      fields["region"] ?? fields["homeRegion"],
      fields["compartmentName"],
    ),
    status: { kind: "status-dot", status },
    sections,
    headerActions: [
      ...lifecycleActions(resource),
      ...(link
        ? [
            {
              kind: "action" as const,
              label: "Open in OCI Console",
              action: { type: "open-url" as const, url: link },
            },
          ]
        : []),
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
    ...(resource.resourceTypeId === "bucket" && resource.externalId
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
  return {
    id: resource.id,
    label: resource.displayName,
    status: {
      kind: "status-dot",
      status: statusOf(String(resource.fields["status"] ?? resource.fields["health"] ?? "")),
    },
  };
}
