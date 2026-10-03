import { f, o, rt } from "@infrawrench/plugin-base";

export const ContainerAppEnvironmentResourceType = rt({
  name: "Container Apps Environment",
  id: "azure-container-app-environment",
  description:
    "An Azure Container Apps environment: the shared network and logging boundary that container apps and jobs run in",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("provisioningState", "Provisioning State"),
    f("defaultDomain", "Default Domain", { required: false }),
    f("staticIp", "Static IP", { required: false }),
    f("workloadProfiles", "Workload Profiles", {
      required: false,
      description: "Workload profiles configured on the environment (name: type)",
    }),
    f("zoneRedundant", "Zone Redundant", { kind: "boolean", required: false }),
    f("internalOnly", "Internal Only", {
      kind: "boolean",
      required: false,
      description: "Environment has only an internal load balancer and no public static IP",
    }),
    f("publicNetworkAccess", "Public Network Access", { required: false }),
    f("logsDestination", "Logs Destination", { required: false }),
    f("subnetRef", "Infrastructure Subnet", { required: false }),
    f("infrastructureResourceGroup", "Infrastructure Resource Group", { required: false }),
  ],
  outputs: [
    o("defaultDomain", "Default Domain"),
    o("staticIp", "Static IP"),
    o("resourceId", "Resource ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    { fieldKey: "subnetRef", targetTypeId: "azure-subnet", label: "in subnet" },
    {
      fieldKey: "infrastructureResourceGroup",
      targetTypeId: "azure-resource-group",
      label: "infrastructure in",
    },
  ],
  iconKey: "layers",
  supportsMetrics: true,
});
