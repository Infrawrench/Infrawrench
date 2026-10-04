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

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "vm":
      switch (String(f["state"] ?? "")) {
        case "running":
          return "healthy";
        case "provisioning":
          return "provisioning";
        case "degraded":
        case "paused":
          return "degraded";
        case "crashed":
          return "error";
        default:
          return "unknown";
      }
    case "kubernetes-cluster":
    case "node-pool": {
      const s = String(f["state"] ?? "").toLowerCase();
      if (resource.resourceTypeId === "node-pool" && f["health"] && f["health"] !== "healthy") {
        return "degraded";
      }
      if (s.includes("error") || s.includes("fail")) return "error";
      if (s.includes("running") || s === "active") return "healthy";
      if (/(provision|creat|updat|upgrad|rotat|delet|pending)/.test(s)) return "provisioning";
      return "unknown";
    }
    case "firewall-rule":
      return f["state"] === "active" ? "healthy" : f["state"] ? "unknown" : "info";
    case "disk":
      return f["attachedVmIds"] ? "healthy" : "info";
    default:
      return "info";
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

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const actions: ActionNode[] = [];
  if (resource.resourceTypeId === "vm") {
    const state = String(f["state"] ?? "");
    if (state === "running" || state === "degraded") {
      actions.push(
        action("Stop", "stop", {
          confirm:
            "Stop this VM? Compute billing stops, but its disks keep billing for storage. A dynamic public IP changes when it starts again.",
          success: "Stop requested.",
          danger: true,
        }),
        action("Reset", "reset", {
          confirm: "Hard reset this VM? Anything not written to disk is lost.",
          success: "Reset requested.",
          danger: true,
        }),
      );
    } else if (state === "stopped" || state === "crashed" || state === "paused") {
      actions.push(action("Start", "start", { success: "Start requested." }));
    }
  }
  if (resource.resourceTypeId === "disk") {
    if (f["attachedVmIds"]) {
      actions.push(
        action("Detach", "detach", {
          confirm:
            "Detach this disk from every VM it is attached to? Unmount it inside the VM first.",
          success: "Disk detached.",
          danger: true,
        }),
      );
    }
    actions.push(
      action("Take snapshot", "snapshot", {
        confirm:
          "Create a snapshot of this disk? Snapshots are billed for their size until deleted.",
        success: "Snapshot requested. It appears under Disk Snapshots when Crusoe finishes it.",
      }),
    );
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function renderCrusoeDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [
        {
          kind: "key-value-list",
          items: labeledFieldItems(f, resourceTypes, resource.resourceTypeId),
        },
      ],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    resourceTypes,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length > 0) {
    sections.push({
      kind: "section",
      title: "Endpoints",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["type"] && resource.resourceTypeId === "vm" ? String(f["type"]) : undefined,
      f["location"] ?? f["locations"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
}

export function renderCrusoeSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
