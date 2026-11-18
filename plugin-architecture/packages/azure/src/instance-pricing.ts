import type {
  InstancePricingCapability,
  InstancePricingUsage,
  ResourceInstance,
} from "@infrawrench/plugin-base";

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

function count(value: unknown): number | null {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a VM or AKS cluster pays for by the hour, for the price-change watch. A
 * deallocated VM pays no compute (a merely stopped one still does). An AKS
 * cluster is its system pool's size at the pool's node count, a lower bound
 * when the count is not synced.
 */
export function azureInstancePricingUsage(resource: ResourceInstance): InstancePricingUsage[] {
  if (/deallocat/i.test(String(resource.fields["powerState"] ?? ""))) return [];
  const panel = azureInstancePricing(resource);
  const instanceType = panel?.instanceTypes[0];
  if (!panel || !instanceType || !panel.region) return [];
  const units =
    resource.resourceTypeId === "azure-aks-cluster" ? count(resource.fields["nodeCount"]) : 1;
  return [
    {
      platform: panel.platform,
      instanceType,
      region: panel.region,
      ...(panel.selection ? { selection: panel.selection } : {}),
      units: units ?? 1,
      ...(units === null ? { approximate: true } : {}),
    },
  ];
}
