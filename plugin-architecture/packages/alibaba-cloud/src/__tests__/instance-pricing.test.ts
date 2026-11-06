import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { alibabaInstancePricing } from "../instance-pricing.js";

const resource = (resourceTypeId: string, fields: Record<string, unknown>) =>
  ({ resourceTypeId, fields }) as unknown as ResourceInstance;

describe("alibabaInstancePricing", () => {
  it("reads an ECS instance on VPC networking", () => {
    expect(
      alibabaInstancePricing(
        resource("ecs-instance", {
          instanceType: "ecs.g7.large",
          region: "us-east-1",
          osName: "Windows Server 2022",
        }),
      ),
    ).toEqual({
      platform: "alibaba",
      instanceTypes: ["ecs.g7.large"],
      region: "us-east-1",
      selection: { operating_system: "Windows", "variant.networkType": "VPC" },
    });
  });

  it("lists a node pool's types, and ignores an EIP's unrelated instanceType field", () => {
    expect(
      alibabaInstancePricing(
        resource("ack-node-pool", { instanceTypes: "ecs.g7.large, ecs.c7.large", region: "r" }),
      )?.instanceTypes,
    ).toEqual(["ecs.g7.large", "ecs.c7.large"]);
    expect(
      alibabaInstancePricing(resource("eip", { instanceType: "EcsInstance" })),
    ).toBeUndefined();
  });
});
