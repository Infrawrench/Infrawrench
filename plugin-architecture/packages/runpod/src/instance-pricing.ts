import type { InstancePricingCapability, ResourceInstance } from "@infrawrench/plugin-base";

/**
 * The pricing panel's reading of a pod or serverless endpoint. GPU types go by
 * their RunPod id. A CPU pod's price list name is its flavor plus its shape
 * (`cpu3c-2-4`), which the pod's fields carry separately.
 */
export function runpodInstancePricing(
  resource: ResourceInstance,
): InstancePricingCapability | undefined {
  const fields = resource.fields;
  let instanceTypes: string[] = [];
  if (resource.resourceTypeId === "pod") {
    const gpu = String(fields["gpuTypeId"] ?? "");
    const flavor = String(fields["cpuFlavorId"] ?? "");
    if (gpu) instanceTypes = [gpu];
    else if (flavor) {
      instanceTypes = [`${flavor}-${String(fields["vcpus"])}-${String(fields["memoryGb"])}`];
    }
  } else if (resource.resourceTypeId === "serverless-endpoint") {
    instanceTypes = String(fields["gpuTypeIds"] ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (instanceTypes.length === 0) return undefined;
  const cloud = String(fields["cloudType"] ?? "");
  return {
    platform: "runpod",
    instanceTypes,
    region: "global",
    ...(cloud ? { selection: { "variant.cloudType": cloud } } : {}),
  };
}
