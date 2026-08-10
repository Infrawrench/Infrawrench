import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "azure-load-balancer",
  description: "An Azure Load Balancer",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("frontendIpCount", "Frontend IPs", { kind: "number", required: false }),
    f("backendPoolCount", "Backend Pools", { kind: "number", required: false }),
    f("ruleCount", "Rules", { kind: "number", required: false }),
    f("publicIpNames", "Frontend Public IPs", { required: false }),
    f("subnetRefs", "Frontend Subnets", { required: false }),
  ],
  outputs: [o("frontendIp", "Frontend IP")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "publicIpNames",
      targetTypeId: "azure-public-ip",
      targetKey: "name",
      label: "fronted by",
    },
    { fieldKey: "subnetRefs", targetTypeId: "azure-subnet", label: "frontend in subnet" },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "network",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      matchField: "location",
      verb: "Add backend",
    },
  ],
});
