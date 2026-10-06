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
    case "pod":
      switch (String(f["status"] ?? "")) {
        case "running":
          return f["maintenance"] ? "degraded" : "healthy";
        case "starting":
          return "provisioning";
        case "stopped":
          return "info";
        case "terminated":
          return "unknown";
        default:
          return "unknown";
      }
    case "serverless-endpoint": {
      if (Number(f["workersUnhealthy"] ?? 0) > 0) return "degraded";
      if (Number(f["workersThrottled"] ?? 0) > 0 && Number(f["jobsInQueue"] ?? 0) > 0) {
        return "degraded";
      }
      return "healthy";
    }
    case "network-volume":
      return f["attachedTo"] ? "healthy" : "info";
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
  if (resource.resourceTypeId === "pod") {
    const status = String(f["status"] ?? "");
    const locked = f["locked"] === true;
    if ((status === "running" || status === "starting") && !locked) {
      actions.push(
        action("Stop", "stop", {
          confirm:
            "Stop this pod? GPU billing stops and the container disk is wiped; the pod volume is kept and keeps billing. When it starts again Runpod may not have a GPU free on the same host.",
          success: "Stop requested.",
          danger: true,
        }),
        action("Restart", "restart", {
          confirm:
            "Restart this pod? Running processes are killed and the container disk is wiped.",
          success: "Restart requested.",
        }),
        action("Reset", "reset", {
          confirm:
            "Reset this pod? The container is recreated from its image; only the pod volume survives.",
          success: "Reset requested.",
          danger: true,
        }),
      );
    } else if (status === "stopped") {
      actions.push(action("Start", "start", { success: "Start requested." }));
    }
    if (status !== "terminated") {
      actions.push(
        locked
          ? action("Unlock", "unlock", { success: "Pod unlocked." })
          : action("Lock", "lock", {
              confirm: "Lock this pod? It cannot be stopped or reset until it is unlocked.",
              success: "Pod locked.",
            }),
      );
    }
  }
  if (resource.resourceTypeId === "serverless-endpoint") {
    actions.push(
      action("Purge Queue", "purge-queue", {
        confirm:
          "Remove every job waiting in this endpoint's queue? Jobs already running are not affected.",
        success: "Queue purged.",
        danger: true,
      }),
    );
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function renderRunpodDetail(
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
      title: resource.resourceTypeId === "pod" ? "Connect" : "Endpoints",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  const gpu = f["gpuType"]
    ? `${Number(f["gpuCount"] ?? 0) > 1 ? `${String(f["gpuCount"])}× ` : ""}${String(f["gpuType"])}`
    : undefined;
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      resource.resourceTypeId === "pod" ? gpu : undefined,
      f["region"] || f["dataCenters"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
}

export function renderRunpodSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
