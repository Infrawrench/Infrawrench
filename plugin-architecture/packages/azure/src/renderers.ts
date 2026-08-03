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

  if (resource.resourceTypeId === "azure-vm") {
    const power = String(fields["powerState"] ?? "");
    if (power === "VM running") {
      detail.headerActions = [
        {
          kind: "action",
          label: "Stop",
          action: {
            type: "plugin-action",
            actionId: "deallocate",
            confirmMessage:
              "Stop this VM? Deallocating releases the compute so VM billing stops; disks and public IPs keep billing.",
            successMessage: "Deallocate requested.",
          },
          variant: "danger",
        },
        ...(detail.headerActions ?? []),
      ];
    } else if (power === "VM deallocated" || power === "VM stopped") {
      detail.headerActions = [
        {
          kind: "action",
          label: "Start",
          action: {
            type: "plugin-action",
            actionId: "start",
            successMessage: "Start requested.",
          },
        },
        ...(detail.headerActions ?? []),
      ];
    }
  }

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

  if (resource.resourceTypeId === "azure-service-bus") {
    detail.publishPanel = {
      tabLabel: "Send",
      subtitle: `Send a message into a queue or topic inside ${resource.displayName}`,
      bodyFormat: "json",
      defaultBody: '{\n  "hello": "world"\n}',
      helpText:
        "Posted to the Service Bus REST API. The body becomes the message payload — JSON is recommended for SDK consumers.",
      submitLabel: "Send",
      extraFields: [
        {
          key: "entity",
          label: "Queue or topic name",
          kind: "text",
          placeholder: "my-queue",
          helpText: "The queue or topic inside this namespace that the message should land in.",
        },
        {
          key: "properties",
          label: "Application properties",
          kind: "key-value-list",
          helpText: "Sent as BrokerProperties on the message.",
        },
      ],
    };
  }

  if (resource.resourceTypeId === "azure-event-hub") {
    detail.publishPanel = {
      tabLabel: "Send",
      subtitle: `Send an event into a hub inside ${resource.displayName}`,
      bodyFormat: "json",
      defaultBody: '{\n  "event": "test"\n}',
      helpText: "Posted to the Event Hubs REST API. The body becomes the event payload.",
      submitLabel: "Send event",
      extraFields: [
        {
          key: "hub",
          label: "Event hub name",
          kind: "text",
          placeholder: "my-hub",
          helpText: "The event hub inside this namespace that should receive the event.",
        },
        {
          key: "partitionKey",
          label: "Partition key",
          kind: "text",
          optional: true,
          helpText: "Optional. Events with the same key land on the same partition.",
        },
      ],
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
