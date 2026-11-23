import { f, o, rt } from "@infrawrench/plugin-base";

export const ServiceBusNamespaceResourceType = rt({
  name: "Service Bus Namespace",
  id: "azure-service-bus",
  description: "An Azure Service Bus messaging namespace",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true }),
    f("sku", "SKU", { showcase: true }),
    f("provisioningState", "Provisioning State"),
    f("status", "Status", { showcase: true, required: false }),
    f("createdAt", "Created", { required: false }),
    // Read from the namespace's queue and topic lists (`sizeInBytes` against
    // `maxSizeInMegabytes`); an entity at its maximum size refuses new messages.
    // https://learn.microsoft.com/rest/api/servicebus/controlplane-stable/queues/list-by-namespace
    // (read 2026-11-23)
    f("fullestEntityPercent", "Fullest Entity Used (%)", {
      kind: "number",
      required: false,
      editable: false,
      description: "How full the queue or topic closest to its maximum size is",
      usage: { limit: { constant: 100 }, unit: "%", label: "Fullest queue or topic" },
    }),
    f("fullestEntity", "Fullest Entity", {
      required: false,
      editable: false,
      description: "The queue or topic closest to its maximum size",
    }),
  ],
  outputs: [
    o("serviceBusEndpoint", "Endpoint"),
    o("primaryConnectionString", "Connection String", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "queue",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "servicebus-connection",
      displayName: "Service Bus Connection",
      description: "Azure Service Bus connection details",
      entries: [
        { envKey: "SERVICEBUS_ENDPOINT", outputKey: "serviceBusEndpoint" },
        { envKey: "SERVICEBUS_CONNECTION_STRING", outputKey: "primaryConnectionString" },
      ],
    },
  ],
});
