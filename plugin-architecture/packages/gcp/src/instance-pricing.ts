import type { InstancePricingCapability, ResourceInstance } from "@infrawrench/plugin-base";

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
