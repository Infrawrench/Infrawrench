import type {
  InstancePricingCapability,
  InstancePricingUsage,
  ResourceInstance,
} from "@infrawrench/plugin-base";

/** The pricing panel's reading of a Compute Engine machine or a GKE cluster's nodes. */
export function gcpInstancePricing(
  resource: ResourceInstance,
): InstancePricingCapability | undefined {
  const location =
    resource.resourceTypeId === "gce-instance"
      ? resource.fields["zone"]
      : resource.resourceTypeId === "gke-cluster"
        ? resource.fields["location"]
        : undefined;
  const machineType = String(resource.fields["machineType"] ?? "");
  if (location === undefined || !machineType) return undefined;
  return {
    platform: "gcp",
    instanceTypes: [machineType],
    // Prices are per region; `us-central1-a` is a zone of `us-central1`.
    region: String(location).replace(/-[a-z]$/, ""),
    selection: { "variant.provisioningModel": "Standard" },
  };
}

function count(value: unknown): number | null {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Compute Engine states that stop the machine being billed. */
const NOT_BILLED = new Set(["TERMINATED", "STOPPED", "SUSPENDED", "STOPPING", "SUSPENDING"]);

/**
 * What a machine or GKE cluster pays for by the hour, for the price-change
 * watch. A GKE cluster is its machine type at its node count, a lower bound
 * when the count is not synced.
 */
export function gcpInstancePricingUsage(resource: ResourceInstance): InstancePricingUsage[] {
  if (NOT_BILLED.has(String(resource.fields["status"] ?? "").toUpperCase())) return [];
  const panel = gcpInstancePricing(resource);
  const instanceType = panel?.instanceTypes[0];
  if (!panel || !instanceType || !panel.region) return [];
  const units = resource.resourceTypeId === "gke-cluster" ? count(resource.fields["nodeCount"]) : 1;
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
