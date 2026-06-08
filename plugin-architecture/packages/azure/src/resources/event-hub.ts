import { f, o, rt } from "@infrawrench/plugin-base";

export const EventHubNamespaceResourceType = rt({
  name: "Event Hub Namespace",
  id: "azure-event-hub",
  description: "An Azure Event Hubs namespace for event streaming",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("status", "Status", { required: false }),
    f("isAutoInflateEnabled", "Auto-Inflate", { kind: "boolean", required: false }),
    f("maximumThroughputUnits", "Max Throughput Units", { kind: "number", required: false }),
  ],
  outputs: [
    o("serviceBusEndpoint", "Endpoint"),
    o("primaryConnectionString", "Connection String", { sensitive: true }),
  ],
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
});
