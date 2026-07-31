import { f, o, rt } from "@infrawrench/plugin-base";

export const ServiceBusNamespaceResourceType = rt({
  name: "Service Bus Namespace",
  id: "azure-service-bus",
  description: "An Azure Service Bus messaging namespace",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("status", "Status", { required: false }),
    f("createdAt", "Created", { required: false }),
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
