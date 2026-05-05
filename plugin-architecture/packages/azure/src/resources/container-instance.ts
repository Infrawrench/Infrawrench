import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ContainerInstanceResourceType: ResourceTypeDefinition = {
  id: "azure-container-instance",
  displayName: "Container Instance",
  pluralDisplayName: "Container Instances",
  description: "An Azure Container Instances group",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "osType", label: "OS Type", kind: "string", required: true },
    { key: "restartPolicy", label: "Restart Policy", kind: "string", required: false },
    { key: "containers", label: "Containers", kind: "number", required: false },
    { key: "ipAddress", label: "IP Address", kind: "string", required: false },
    { key: "fqdn", label: "FQDN", kind: "string", required: false },
  ],
  outputs: [
    { key: "ipAddress", label: "IP Address", sensitive: false },
    { key: "fqdn", label: "FQDN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "container",
  supportsCreate: true,
};
