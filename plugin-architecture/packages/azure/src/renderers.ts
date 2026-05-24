/**
 * Detail-view and sidebar renderers for Azure resources.
 *
 * Both renderers consume the same `ResourceTypeDefinition[]` registry from the
 * plugin and use the same provisioning-state → status-dot mapping. The detail
 * renderer attaches the storage browser / artifact registry features to the
 * relevant resource types.
 */
import type {
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  labeledFieldItems,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";

const DETAIL_STATUS_MAP: Record<string, ResourceStatus> = {
  succeeded: "healthy",
  running: "healthy",
  active: "healthy",
  online: "healthy",
  available: "healthy",
  ready: "healthy",
  creating: "provisioning",
  updating: "provisioning",
  provisioning: "provisioning",
  starting: "provisioning",
  scaling: "provisioning",
  upgrading: "provisioning",
  resuming: "provisioning",
  "vm running": "healthy",
  "vm deallocated": "degraded",
  "vm stopped": "degraded",
  stopped: "degraded",
  stopping: "degraded",
  paused: "degraded",
  pausing: "degraded",
  deallocated: "degraded",
  deleting: "error",
  failed: "error",
  offline: "error",
  inaccessible: "error",
  suspect: "error",
};

const SIDEBAR_STATUS_MAP: Record<string, ResourceStatus> = {
  succeeded: "healthy",
  running: "healthy",
  active: "healthy",
  online: "healthy",
  available: "healthy",
  "vm running": "healthy",
  stopped: "degraded",
  "vm deallocated": "degraded",
  "vm stopped": "degraded",
  paused: "degraded",
  failed: "error",
  deleting: "error",
};

export function renderAzureDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const fields = resource.fields;
  const state = String(
    fields["provisioningState"] ??
      fields["state"] ??
      fields["status"] ??
      fields["powerState"] ??
      "",
  );

  const dotStatus = DETAIL_STATUS_MAP[state.toLowerCase()] ?? "info";

  const sections: DetailViewSchema["sections"] = [
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

  const outputItems = labeledOutputItems(
    resource.resolvedOutputs,
    resourceTypes,
    resource.resourceTypeId,
  );
  if (outputItems.length > 0) {
    sections.push({
      kind: "section",
      title: "Outputs",
      children: [{ kind: "key-value-list", items: outputItems }],
    });
  }

  const detail: DetailViewSchema = {
    title: resource.displayName,
    subtitle: `${resourceTypeDisplayName(resourceTypes, resource.resourceTypeId)} · ${String(fields["location"] ?? fields["resourceGroup"] ?? "")}`,
    status: state
      ? { kind: "status-dot", status: dotStatus, label: state }
      : { kind: "status-dot", status: dotStatus },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };

  // Add storage browser for storage accounts
  if (resource.resourceTypeId === "azure-storage-account") {
    detail.storageBrowser = { bucketName: String(resource.fields["name"] ?? "") };
  }

  if (resource.resourceTypeId === "azure-container-registry") {
    detail.artifactRegistry = { format: "docker", supportsTags: true };
    detail.status = {
      kind: "status-dot",
      status: dotStatus === "info" ? "healthy" : dotStatus,
      ...(state ? { label: state } : {}),
    };
  }

  return detail;
}

export function renderAzureSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  const state = String(
    resource.fields["provisioningState"] ??
      resource.fields["state"] ??
      resource.fields["status"] ??
      resource.fields["powerState"] ??
      "",
  );
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: SIDEBAR_STATUS_MAP[state.toLowerCase()] ?? "info" },
  };
}
