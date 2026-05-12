import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AppServiceResourceType: ResourceTypeDefinition = {
  id: "azure-app-service",
  displayName: "App Service",
  pluralDisplayName: "App Services",
  description: "An Azure App Service web app",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "kind", label: "Kind", kind: "string", required: false },
    { key: "appServicePlan", label: "App Service Plan", kind: "string", required: false },
    { key: "httpsOnly", label: "HTTPS Only", kind: "boolean", required: false },
    { key: "linuxFxVersion", label: "Linux FX Version", kind: "string", required: false },
  ],
  outputs: [
    { key: "defaultHostName", label: "Default Hostname", sensitive: false },
    { key: "outboundIpAddresses", label: "Outbound IPs", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "deployment",
  supportsCreate: true,
  supportsMetrics: true,
};
