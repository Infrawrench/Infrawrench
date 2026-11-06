import { hostClient } from "@infrawrench/plugin-base/effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearInstanceRateCache, type HostServices } from "@infrawrench/plugin-base";
import { AlibabaCloudClient } from "../client.js";

const services = (rows: [string, number][]): HostServices => ({
  // The live API is unreachable here, as it is for a key without pricing access.
  http: {
    request: vi.fn(async () => ({ status: 403, headers: {}, body: "{}" })),
  },
  instancePricing: {
    query: vi.fn(async () => ({
      columns: [
        { name: "instanceType", type: "String" },
        { name: "hourly", type: "Float64" },
      ],
      rows,
      truncated: false,
      elapsedMs: 1,
    })),
  },
});

const client = (s: HostServices) =>
  hostClient(new AlibabaCloudClient({ accessKeyId: "id", accessKeySecret: "secret" }, s));

describe("Alibaba Cloud ECS pricing from the warehouse", () => {
  beforeEach(() => clearInstanceRateCache());

  it("prices the size picker without DescribePrice", async () => {
    const s = services([["ecs.g7.large", 0.1]]);
    const prices = await client(s).getCreateSizePricing("ecs-instance", {
      regionId: "us-east-1",
      sizes: [{ id: "ecs.g7.large", vcpus: 2, memoryMb: 8192 }],
    });
    expect(prices).toEqual({ "ecs.g7.large": 73 });
    expect(s.http?.request).not.toHaveBeenCalled();
  });

  it("still estimates when DescribePrice is refused", async () => {
    const estimate = await client(services([["ecs.g7.large", 0.1]])).estimateCost("ecs-instance", {
      region: "us-east-1",
      instanceType: "ecs.g7.large",
    });
    expect(estimate?.monthlyAmount).toBe(73);
  });
});
