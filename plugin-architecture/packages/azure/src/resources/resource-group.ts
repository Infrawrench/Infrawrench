import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ResourceGroupResourceType: ResourceTypeDefinition = {
  id: "azure-resource-group",
  displayName: "Resource Group",
  pluralDisplayName: "Resource Groups",
  description: "An Azure Resource Group",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
  ],
  outputs: [
    { key: "resourceId", label: "Resource ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "project",
  supportsCreate: true,
};
