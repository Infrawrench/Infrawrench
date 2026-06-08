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
  ],
  outputs: [o("frontendIp", "Frontend IP")],
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
