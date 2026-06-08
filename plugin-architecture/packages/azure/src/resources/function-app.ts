import { f, o, rt } from "@infrawrench/plugin-base";

export const FunctionAppResourceType = rt({
  name: "Function App",
  id: "azure-function-app",
  description: "An Azure Function App",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("state", "State"),
    f("kind", "Kind", { required: false }),
    f("runtime", "Runtime", { required: false }),
    f("runtimeVersion", "Runtime Version", { required: false }),
    f("appServicePlan", "App Service Plan", { required: false }),
    f("httpsOnly", "HTTPS Only", { kind: "boolean", required: false }),
  ],
  outputs: [o("defaultHostName", "Default Hostname"), o("outboundIpAddresses", "Outbound IPs")],
  iconKey: "function",
  supportsCreate: true,
  supportsMetrics: true,
});
