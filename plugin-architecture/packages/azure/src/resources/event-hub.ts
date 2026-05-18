import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EventHubNamespaceResourceType: ResourceTypeDefinition = {
  id: "azure-event-hub",
  displayName: "Event Hub Namespace",
  pluralDisplayName: "Event Hub Namespaces",
  description: "An Azure Event Hubs namespace for event streaming",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "isAutoInflateEnabled", label: "Auto-Inflate", kind: "boolean", required: false },
    {
      key: "maximumThroughputUnits",
      label: "Max Throughput Units",
      kind: "number",
      required: false,
    },
  ],
  outputs: [
    { key: "serviceBusEndpoint", label: "Endpoint", sensitive: false },
    { key: "primaryConnectionString", label: "Connection String", sensitive: true },
  ],
  dashboardPinnable: true,
  iconKey: "topic",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "eventhub-connection",
      displayName: "Event Hub Connection",
      description: "Azure Event Hub connection details",
      entries: [
        { envKey: "EVENTHUB_ENDPOINT", outputKey: "serviceBusEndpoint" },
        { envKey: "EVENTHUB_CONNECTION_STRING", outputKey: "primaryConnectionString" },
      ],
    },
  ],
};
