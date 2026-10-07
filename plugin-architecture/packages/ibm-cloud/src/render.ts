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
} from "@infrawrench/plugin-base";

const PRIVATE_PREFIX = "_";

export function statusOf(value: string): ResourceStatus {
  const s = value.toLowerCase();
  if (!s) return "unknown";
  if (
    [
      "running",
      "available",
      "active",
      "stable",
      "normal",
      "ready",
      "online",
      "deployed",
      "attached",
      "bound",
    ].includes(s)
  ) {
    return "healthy";
  }
  if (["stopped", "inactive", "unattached", "unbound"].includes(s)) return "unknown";
  if (
    ["failed", "critical", "error", "unusable", "offline", "deploy_failed", "removed"].includes(s)
  )
    return "error";
  if (["warning", "degraded", "suspended", "maintenance_required"].includes(s)) return "degraded";
  if (/ing$/.test(s) || ["pending", "provisioning", "requested", "updating"].includes(s))
    return "provisioning";
  return "info";
}

function issueLabel(status: ResourceStatus, raw: string): string | undefined {
  return status === "error" || status === "degraded"
    ? `IBM Cloud reports this resource as ${raw}`
    : undefined;
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

function bareId(resource: ResourceInstance): string {
  const ext = resource.externalId ?? "";
  return ext.slice(ext.lastIndexOf("/") + 1);
}

export function consoleLink(resource: ResourceInstance): string | null {
  const id = encodeURIComponent(bareId(resource));
  const crn = encodeURIComponent(resource.externalId ?? "");
  switch (resource.resourceTypeId) {
    case "instance":
      return `https://cloud.ibm.com/vpc-ext/compute/vs/${encodeURIComponent(String(resource.fields["region"] ?? ""))}~${id}/overview`;
    case "kubernetes-cluster":
      return `https://cloud.ibm.com/kubernetes/clusters/${id}/overview`;
    case "database":
    case "service-instance":
      return `https://cloud.ibm.com/services/${encodeURIComponent(String(resource.fields["service"] ?? ""))}/${crn}`;
    case "cos-bucket":
      return "https://cloud.ibm.com/objectstorage";
    case "account":
      return "https://cloud.ibm.com/billing/usage";
    default:
      return null;
  }
}

function actionsFor(resource: ResourceInstance): ActionNode[] {
  const status = String(resource.fields["status"] ?? "");
  if (resource.resourceTypeId !== "instance") return [];
  if (status === "stopped") return [action("Start", "start", { success: "Start requested." })];
  if (status !== "running") return [];
  return [
    action("Stop", "stop", {
      confirm:
        "Shut this server down? Its volumes and floating IPs keep billing while it is stopped.",
      success: "Stop requested.",
    }),
    action("Reboot", "reboot", { confirm: "Reboot this server?", success: "Reboot requested." }),
    action("Force stop", "stop-force", {
      confirm: "Power this server off without shutting the operating system down?",
      success: "Stop requested.",
      danger: true,
    }),
  ];
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
  if (resource.resourceTypeId !== "account") return [];
  const mtd = parseJson<{ currency: string; billable: number; nonBillable: number }>(
    resource.fields["_mtd"],
  );
  if (!mtd) return [];
  return [
    {
      kind: "section",
      title: "This month",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Billable so far", value: money(mtd.billable, mtd.currency) },
            { key: "Covered by free tier or credit", value: money(mtd.nonBillable, mtd.currency) },
          ],
        },
      ],
    },
  ];
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
  const label = issueLabel(status, raw);
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
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      fields["region"] ?? fields["location"],
      fields["zone"],
    ),
    status: { kind: "status-dot", status, ...(label ? { label } : {}) },
    sections,
    headerActions: [
      ...actionsFor(resource),
      ...(link
        ? [
            {
              kind: "action" as const,
              label: "Open in IBM Cloud",
              action: { type: "open-url" as const, url: link },
            },
          ]
        : []),
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
    ],
    ...(resource.resourceTypeId === "cos-bucket" && resource.externalId
      ? { storageBrowser: { bucketName: resource.externalId } }
      : {}),
  };
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  const raw = String(resource.fields["status"] ?? resource.fields["state"] ?? "");
  const status = statusOf(raw);
  const label = issueLabel(status, raw);
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status, ...(label ? { label } : {}) },
  };
}
