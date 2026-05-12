import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FunctionAppResourceType: ResourceTypeDefinition = {
  id: "azure-function-app",
  displayName: "Function App",
  pluralDisplayName: "Function Apps",
  description: "An Azure Function App",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "kind", label: "Kind", kind: "string", required: false },
    { key: "runtime", label: "Runtime", kind: "string", required: false },
    { key: "runtimeVersion", label: "Runtime Version", kind: "string", required: false },
    { key: "appServicePlan", label: "App Service Plan", kind: "string", required: false },
    { key: "httpsOnly", label: "HTTPS Only", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "defaultHostName", label: "Default Hostname", sensitive: false },
    { key: "outboundIpAddresses", label: "Outbound IPs", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "function",
  supportsCreate: true,
  supportsMetrics: true,
};
