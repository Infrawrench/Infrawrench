import { f, o, rt } from "@infrawrench/plugin-base";

export const EventHubNamespaceResourceType = rt({
  name: "Event Hub Namespace",
  id: "azure-event-hub",
  description: "An Azure Event Hubs namespace for event streaming",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true }),
    f("sku", "SKU", { showcase: true }),
    f("provisioningState", "Provisioning State"),
    f("status", "Status", { showcase: true, required: false }),
    f("isAutoInflateEnabled", "Auto-Inflate", { kind: "boolean", required: false }),
    f("maximumThroughputUnits", "Max Throughput Units", { kind: "number", required: false }),
    // Throughput units in use against the auto-inflate ceiling. Azure reports the
    // ceiling as 0 when auto-inflate is off, which yields no runway row.
    // https://learn.microsoft.com/rest/api/eventhub/namespaces/list (read 2026-11-23)
    f("throughputUnits", "Throughput Units", {
      kind: "number",
      required: false,
      editable: false,
      description: "Throughput units the Basic or Standard namespace runs on now",
      usage: { limit: { field: "maximumThroughputUnits" }, unit: "throughput units" },
    }),
  ],
  outputs: [
    o("serviceBusEndpoint", "Endpoint"),
    o("primaryConnectionString", "Connection String", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
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
