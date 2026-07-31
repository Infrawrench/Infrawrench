import { f, o, rt } from "@infrawrench/plugin-base";

export const AppGatewayResourceType = rt({
  name: "Application Gateway",
  id: "azure-app-gateway",
  description: "An Azure Application Gateway (Layer 7 load balancer)",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("tier", "Tier"),
    f("capacity", "Capacity", { kind: "number", required: false }),
    f("provisioningState", "Provisioning State"),
    f("operationalState", "Operational State", { required: false }),
    f("backendPoolCount", "Backend Pools", { kind: "number", required: false }),
    f("httpListenerCount", "HTTP Listeners", { kind: "number", required: false }),
    f("publicIpNames", "Frontend Public IPs", { required: false }),
    f("subnetRefs", "Subnets", { required: false }),
    f("keyVaults", "Certificate Key Vaults", {
      required: false,
      description: "Key Vaults the listener certificates are sourced from",
    }),
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
    { fieldKey: "subnetRefs", targetTypeId: "azure-subnet", label: "in subnet" },
    {
      fieldKey: "keyVaults",
      targetTypeId: "azure-key-vault",
      targetKey: "name",
      label: "certificates from",
    },
  ],
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
