import { f, o, rt } from "@infrawrench/plugin-base";

export const NatGatewayResourceType = rt({
  name: "NAT Gateway",
  id: "azure-nat-gateway",
  description: "An Azure NAT Gateway",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU", { required: false }),
    f("provisioningState", "Provisioning State", { required: false }),
    f("idleTimeout", "Idle Timeout", { kind: "number", required: false }),
    f("publicIpCount", "Public IPs", { kind: "number", required: false }),
    f("subnetCount", "Associated Subnets", { kind: "number", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  supportsMetrics: true,
  iconKey: "network",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-subnet",
      matchField: "location",
      verb: "Associate",
    },
  ],
});
