import type {
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
  dnsZoneStatus,
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";

const DETAIL_STATUS_MAP: Record<string, ResourceStatus> = {
  // Generic
  running: "healthy",
  active: "healthy",
  "in-use": "healthy",
  available: "healthy",
  issued: "healthy",
  ok: "healthy",
  enabled: "healthy",
  // Degraded / stopped
  stopped: "degraded",
  stopping: "degraded",
  paused: "degraded",
  disabled: "degraded",
  inactive: "degraded",
  insufficient_data: "degraded",
  // Provisioning / in-progress
  pending: "provisioning",
  creating: "provisioning",
  updating: "provisioning",
  provisioning: "provisioning",
  create_in_progress: "provisioning",
  update_in_progress: "provisioning",
  operation_in_progress: "provisioning",
  pending_validation: "provisioning",
  // Error
  "shutting-down": "error",
  terminated: "error",
  deleting: "error",
  deleted: "error",
  failed: "error",
  create_failed: "error",
  delete_failed: "error",
  rollback_complete: "error",
  rollback_failed: "error",
  alarm: "error",
  revoked: "error",
  expired: "error",
};

const SIDEBAR_STATUS_MAP: Record<string, ResourceStatus> = {
  running: "healthy",
  active: "healthy",
  available: "healthy",
  "in-use": "healthy",
  issued: "healthy",
  ok: "healthy",
  enabled: "healthy",
  stopped: "degraded",
  paused: "degraded",
  disabled: "degraded",
  terminated: "error",
  failed: "error",
  deleted: "error",
  alarm: "error",
};

export function renderDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
  region: string,
): DetailViewSchema {
  // Use shared DNS helpers for Route 53 records
  if (resource.resourceTypeId === "route53-record-set") {
    return renderDnsRecordDetail(resource, {});
  }

  const fields = resource.fields;
  // SNS topics and SQS queues have no lifecycle state — if they exist, they
  // are active. Treat a missing state as "active" so the dot renders healthy.
  const alwaysHealthyTypes = new Set(["sns-topic", "sqs-queue"]);
  const state = String(
    fields["state"] ??
      fields["status"] ??
      (alwaysHealthyTypes.has(resource.resourceTypeId) ? "active" : ""),
  );

  const dotStatus = DETAIL_STATUS_MAP[state.toLowerCase()] ?? "info";

  return {
    title: resource.displayName,
    subtitle: `${resourceTypeDisplayName(resourceTypes, resource.resourceTypeId)} · ${region}`,
    status: state
      ? { kind: "status-dot", status: dotStatus, label: state }
      : { kind: "status-dot", status: dotStatus },
    sections: [
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
      ...(Object.keys(resource.resolvedOutputs).length > 0
        ? [
            {
              kind: "section" as const,
              title: "Outputs",
              children: [
                {
                  kind: "key-value-list" as const,
                  items: labeledOutputItems(
                    resource.resolvedOutputs,
                    resourceTypes,
                    resource.resourceTypeId,
                  ),
                },
              ],
            },
          ]
        : []),
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    ...(resource.resourceTypeId === "ecr-repository"
      ? {
          artifactRegistry: {
            format: "docker" as const,
            supportsTags: true,
          },
        }
      : {}),
  };
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  // Use shared DNS helpers for Route 53 records
  if (resource.resourceTypeId === "route53-record-set") {
    return renderDnsRecordSidebar(resource);
  }
  // Route 53 hosted zones use the shared dnsZoneStatus helper
  if (resource.resourceTypeId === "route53-hosted-zone") {
    const isPrivate = resource.fields["isPrivate"];
    const label = isPrivate ? "Private" : "Active";
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: dnsZoneStatus("active"), label },
    };
  }

  const state = String(resource.fields["state"] ?? resource.fields["status"] ?? "");
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: SIDEBAR_STATUS_MAP[state.toLowerCase()] ?? "info" },
  };
}
