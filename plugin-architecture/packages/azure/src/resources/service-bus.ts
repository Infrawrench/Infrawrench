import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServiceBusNamespaceResourceType: ResourceTypeDefinition = {
  id: "azure-service-bus",
  displayName: "Service Bus Namespace",
  pluralDisplayName: "Service Bus Namespaces",
  description: "An Azure Service Bus messaging namespace",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "createdAt", label: "Created", kind: "string", required: false },
  ],
  outputs: [
    { key: "serviceBusEndpoint", label: "Endpoint", sensitive: false },
    { key: "primaryConnectionString", label: "Connection String", sensitive: true },
  ],
  dashboardPinnable: true,
  iconKey: "queue",
  supportsCreate: true,
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
};
