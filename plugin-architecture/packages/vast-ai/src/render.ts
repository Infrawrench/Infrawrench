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
    case "instance":
      switch (String(f["status"] ?? "")) {
        case "running":
          return "healthy";
        case "loading":
        case "created":
          return "provisioning";
        case "stopped":
          return "info";
        case "exited":
        case "offline":
          return "error";
        default:
          return "unknown";
      }
    case "volume":
      return f["instanceIds"] ? "healthy" : "info";
    case "serverless-endpoint":
      return String(f["state"] ?? "") === "active" ? "healthy" : "info";
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
  if (resource.resourceTypeId === "instance") {
    const status = String(f["status"] ?? "");
    if (status === "running" || status === "loading") {
      actions.push(
        action("Stop", "stop", {
          confirm:
            "Stop this instance? GPU billing stops and disk billing continues. Another renter can take the GPU while it is stopped, so it may not start again right away.",
          success: "Stop requested.",
          danger: true,
        }),
        action("Reboot", "reboot", {
          confirm: "Restart the container? The GPU stays reserved; running processes are killed.",
          success: "Reboot requested.",
        }),
        action("Recycle", "recycle", {
          confirm:
            "Recreate the container from a freshly pulled image? The GPU stays reserved, but everything on the container disk is lost.",
          success: "Recycle requested.",
          danger: true,
        }),
      );
    } else if (status === "stopped" || status === "exited" || status === "created") {
      actions.push(action("Start", "start", { success: "Start requested." }));
    }
  }
  if (resource.resourceTypeId === "serverless-endpoint") {
    actions.push(
      String(f["state"] ?? "") === "active"
        ? action("Stop Endpoint", "stop", {
            confirm: "Stop this endpoint? Its workers are released until you start it again.",
            success: "Endpoint stopping.",
            danger: true,
          })
        : action("Start Endpoint", "start", { success: "Endpoint starting." }),
    );
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function renderVastDetail(
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
      title: "Connect",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  const gpu =
    resource.resourceTypeId === "instance" && f["gpuName"]
      ? `${Number(f["numGpus"] ?? 1)}x ${String(f["gpuName"])}`
      : undefined;
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      gpu,
      f["location"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
}

export function renderVastSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
