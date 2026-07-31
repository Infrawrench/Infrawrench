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
    f("subnetRef", "Integrated Subnet", {
      required: false,
      description: "Subnet the app is regional-VNet-integrated with",
    }),
    f("containerRegistry", "Container Registry", { required: false }),
    f("managedIdentities", "Managed Identities", { required: false }),
  ],
  outputs: [o("defaultHostName", "Default Hostname"), o("outboundIpAddresses", "Outbound IPs")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    { fieldKey: "subnetRef", targetTypeId: "azure-subnet", label: "VNet integrated with" },
    {
      fieldKey: "containerRegistry",
      targetTypeId: "azure-container-registry",
      targetKey: "loginServer",
      label: "pulls from",
    },
    {
      fieldKey: "managedIdentities",
      targetTypeId: "azure-managed-identity",
      targetKey: "name",
      label: "runs as",
    },
  ],
  iconKey: "function",
  supportsCreate: true,
  supportsMetrics: true,
});
