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
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "machine":
      switch (String(f["state"] ?? "")) {
        case "ready":
          return "healthy";
        case "serviceready":
          return "degraded";
        case "starting":
        case "stopping":
        case "restarting":
        case "upgrading":
        case "provisioning":
          return "provisioning";
        case "off":
          return "info";
        default:
          return "unknown";
      }
    case "deployment":
      return f["enabled"] === false ? "info" : "healthy";
    case "public-ip":
      return f["machineId"] ? "healthy" : "info";
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
  switch (resource.resourceTypeId) {
    case "machine": {
      const state = String(f["state"] ?? "");
      if (state === "ready" || state === "serviceready") {
        actions.push(
          action("Stop", "stop", {
            confirm: "Stop this machine? Compute billing stops; its disk keeps billing.",
            success: "Stop requested.",
            danger: true,
          }),
          action("Restart", "restart", {
            confirm: "Restart this machine? Unsaved work in running sessions is lost.",
            success: "Restart requested.",
          }),
        );
      } else if (state === "off") {
        actions.push(action("Start", "start", { success: "Start requested." }));
      }
      actions.push(
        action("Take Snapshot", "snapshot", {
          confirm: "Snapshot this machine's disk? Snapshots are billed for their size.",
          success: "Snapshot requested. It appears under Snapshots when Paperspace finishes it.",
        }),
      );
      break;
    }
    case "snapshot":
      actions.push(
        action("Restore", "restore", {
          confirm:
            "Restore the machine to this snapshot? Its current disk is replaced; a safety snapshot of it is taken first.",
          success: "Restore requested.",
          danger: true,
        }),
      );
      break;
    case "startup-script":
      if (f["machineIds"]) {
        actions.push(
          action("Unassign From All Machines", "unassign-all", {
            confirm: "Stop running this script on every machine it is assigned to?",
            success: "Script unassigned.",
          }),
        );
      }
      break;
    case "container-registry":
      actions.push(
        action("Test Connection", "test-connection", {
          success: "Paperspace reached the registry.",
        }),
      );
      break;
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function renderPaperspaceDetail(
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
          items: labeledFieldItems(f, resourceTypes, resource.resourceTypeId).filter(
            (i) => i.key !== "Password" && i.key !== "Script",
          ),
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
  const schema: DetailViewSchema = {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      resource.resourceTypeId === "machine" ? f["machineType"] : undefined,
      f["region"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
  return withMetricsCapability(
    schema,
    resourceTypes,
    resource.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

export function renderPaperspaceSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
