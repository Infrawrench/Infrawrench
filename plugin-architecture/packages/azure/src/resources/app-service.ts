import { f, o, rt } from "@infrawrench/plugin-base";

export const AppServiceResourceType = rt({
  name: "App Service",
  id: "azure-app-service",
  description: "An Azure App Service web app",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("state", "State"),
    f("kind", "Kind", { required: false }),
    f("appServicePlan", "App Service Plan", { required: false }),
    f("httpsOnly", "HTTPS Only", { kind: "boolean", required: false }),
    f("linuxFxVersion", "Linux FX Version", { required: false }),
  ],
  outputs: [o("defaultHostName", "Default Hostname"), o("outboundIpAddresses", "Outbound IPs")],
  iconKey: "deployment",
  supportsCreate: true,
  supportsMetrics: true,
});
