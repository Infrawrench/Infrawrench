import type {
  InstancePricingCapability,
  InstancePricingUsage,
  ResourceInstance,
} from "@infrawrench/plugin-base";

/** The pricing panel's reading of an ECS instance or an ACK node pool. */
export function alibabaInstancePricing(
  resource: ResourceInstance,
): InstancePricingCapability | undefined {
  const fields = resource.fields;
  const raw =
    resource.resourceTypeId === "ecs-instance"
      ? fields["instanceType"]
      : resource.resourceTypeId === "ack-node-pool"
        ? fields["instanceTypes"]
        : undefined;
  const instanceTypes = String(raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (instanceTypes.length === 0) return undefined;
  return {
    platform: "alibaba",
    instanceTypes,
    region: String(fields["region"] ?? ""),
    selection: {
      operating_system: /windows/i.test(String(fields["osName"] ?? "")) ? "Windows" : "Linux",
      "variant.networkType": "VPC",
    },
  };
}

function count(value: unknown): number | null {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What an ECS instance or ACK node pool pays for by the hour, for the
 * price-change watch. A stopped instance in economical mode (`StopCharging`)
 * pays no compute. A node pool whose instance count is not synced, or that
 * mixes types, counts each type once, so the figure is a lower bound.
 */
export function alibabaInstancePricingUsage(resource: ResourceInstance): InstancePricingUsage[] {
  const fields = resource.fields;
  if (String(fields["stoppedMode"] ?? "") === "StopCharging") return [];
  const panel = alibabaInstancePricing(resource);
  if (!panel || !panel.region) return [];
  const region = panel.region;
  const units = resource.resourceTypeId === "ack-node-pool" ? count(fields["desiredSize"]) : 1;
  const exact = units !== null && panel.instanceTypes.length === 1;
  return panel.instanceTypes.map((instanceType) => ({
    platform: panel.platform,
    instanceType,
    region,
    ...(panel.selection ? { selection: panel.selection } : {}),
    units: exact && units !== null ? units : 1,
    ...(exact ? {} : { approximate: true }),
  }));
}
