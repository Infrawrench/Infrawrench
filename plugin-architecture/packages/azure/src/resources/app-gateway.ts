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
  ],
  outputs: [o("frontendIp", "Frontend IP")],
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
