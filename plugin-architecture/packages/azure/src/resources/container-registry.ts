import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ContainerRegistryResourceType: ResourceTypeDefinition = {
  id: "azure-container-registry",
  displayName: "Container Registry",
  pluralDisplayName: "Container Registries",
  description: "An Azure Container Registry (ACR)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "adminEnabled", label: "Admin Enabled", kind: "boolean", required: false },
    { key: "publicNetworkAccess", label: "Public Access", kind: "string", required: false },
  ],
  outputs: [{ key: "loginServer", label: "Login Server", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "container-registry",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "acr-login-server",
      displayName: "ACR Login Server",
      description: "Login server hostname for docker push / pull",
      entries: [{ envKey: "ACR_LOGIN_SERVER", outputKey: "loginServer" }],
    },
  ],
};
