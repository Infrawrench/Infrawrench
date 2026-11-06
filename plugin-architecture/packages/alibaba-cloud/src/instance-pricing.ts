import type { InstancePricingCapability, ResourceInstance } from "@infrawrench/plugin-base";

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
