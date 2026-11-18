import type {
  InstancePricingCapability,
  InstancePricingUsage,
  ResourceInstance,
} from "@infrawrench/plugin-base";

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
      // The document's catalog example already writes an id in that shape.
      instanceTypes = [
        /-\d+-\d+$/.test(flavor)
          ? flavor
          : `${flavor}-${String(fields["vcpus"])}-${String(fields["memoryGb"])}`,
      ];
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

/**
 * What a pod pays for by the hour, for the price-change watch: its GPU type
 * times its GPU count (RunPod prices GPUs each), or its CPU flavor. A stopped
 * pod pays no GPU hours. Serverless endpoints scale with requests, so they are
 * not billed per running hour and have none.
 */
export function runpodInstancePricingUsage(resource: ResourceInstance): InstancePricingUsage[] {
  if (resource.resourceTypeId !== "pod") return [];
  const status = String(resource.fields["status"] ?? "");
  if (status === "stopped" || status === "terminated") return [];
  const panel = runpodInstancePricing(resource);
  const instanceType = panel?.instanceTypes[0];
  if (!panel || !instanceType) return [];
  const gpus = Math.floor(Number(resource.fields["gpuCount"] ?? 0));
  const isGpu = String(resource.fields["gpuTypeId"] ?? "") !== "";
  return [
    {
      platform: panel.platform,
      instanceType,
      region: panel.region ?? "global",
      ...(panel.selection ? { selection: panel.selection } : {}),
      units: isGpu && gpus > 0 ? gpus : 1,
    },
  ];
}
