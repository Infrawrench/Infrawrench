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
        case "active":
          return "healthy";
        case "booting":
          return "provisioning";
        case "unhealthy":
          return "degraded";
        case "preempted":
          return "error";
        case "terminating":
        case "terminated":
          return "unknown";
        default:
          return "unknown";
      }
    case "filesystem":
      return f["inUse"] === true ? "healthy" : "info";
    case "firewall-ruleset":
    case "global-firewall":
      return f["sshOpenToInternet"] === true ? "degraded" : "info";
    default:
      return "info";
  }
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const actions: ActionNode[] = [];
  if (resource.resourceTypeId === "instance") {
    const status = String(f["status"] ?? "");
    if ((status === "active" || status === "unhealthy") && !f["restartBlocked"]) {
      actions.push({
        kind: "action",
        label: "Restart",
        action: {
          type: "plugin-action",
          actionId: "restart",
          confirmMessage:
            "Restart this instance? Running processes are stopped; data on the instance and its filesystems is kept.",
          successMessage: "Restart requested.",
        },
      });
    }
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function renderLambdaDetail(
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
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      resource.resourceTypeId === "instance" ? f["instanceType"] : undefined,
      f["region"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
}

export function renderLambdaSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
