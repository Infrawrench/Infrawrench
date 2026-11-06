import type { InstancePricingCapability, ResourceInstance } from "@infrawrench/plugin-base";

/** The pricing panel's reading of a VM or an AKS cluster's system pool. */
export function azureInstancePricing(
  resource: ResourceInstance,
): InstancePricingCapability | undefined {
  if (resource.resourceTypeId !== "azure-vm" && resource.resourceTypeId !== "azure-aks-cluster") {
    return undefined;
  }
  const vmSize = String(resource.fields["vmSize"] ?? "");
  if (!vmSize) return undefined;
  const os = String(resource.fields["osType"] ?? "");
  return {
    platform: "azure",
    instanceTypes: [vmSize],
    region: String(resource.fields["location"] ?? ""),
    selection: {
      operating_system: /windows/i.test(os) ? "Windows" : "Linux",
      "variant.priority": "Regular",
    },
  };
}
