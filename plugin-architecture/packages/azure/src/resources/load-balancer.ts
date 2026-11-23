import { f, o, rt } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "azure-load-balancer",
  description: "An Azure Load Balancer",
  equivalence: "load-balancer",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location", { showcase: true, sizing: "region" }),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State", { showcase: true }),
    // Per-SKU ceilings from the Load Balancer limits, read 2026-11-23 at
    // https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#load-balancer-limits
    // Standard: 600 frontend IP configurations, 1,500 rules (load balancer +
    // inbound NAT) per resource. Basic: 200 and 250. Gateway is left out.
    f("frontendIpCount", "Frontend IPs", {
      showcase: true,
      kind: "number",
      required: false,
      usage: {
        limit: { plan: { field: "sku", allowances: { Standard: 600, Basic: 200 } } },
        unit: "frontend IPs",
      },
    }),
    f("backendPoolCount", "Backend Pools", { showcase: true, kind: "number", required: false }),
    f("ruleCount", "Rules", { kind: "number", required: false }),
    f("inboundNatRuleCount", "Inbound NAT Rules", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("totalRuleCount", "Rules incl. NAT", {
      kind: "number",
      required: false,
      editable: false,
      description:
        "Load-balancing and inbound NAT rules together, as Azure's per-resource limit counts them",
      usage: {
        limit: { plan: { field: "sku", allowances: { Standard: 1500, Basic: 250 } } },
        unit: "rules",
        label: "Rules",
      },
    }),
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
