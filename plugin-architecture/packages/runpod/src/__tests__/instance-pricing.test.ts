import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { runpodInstancePricing } from "../instance-pricing.js";

const resource = (resourceTypeId: string, fields: Record<string, unknown>) =>
  ({ resourceTypeId, fields }) as unknown as ResourceInstance;

describe("runpodInstancePricing", () => {
  it("prices a GPU pod by its RunPod id, in its cloud", () => {
    expect(
      runpodInstancePricing(
        resource("pod", { gpuTypeId: "NVIDIA A100 80GB PCIe", cloudType: "Secure Cloud" }),
      ),
    ).toEqual({
      platform: "runpod",
      instanceTypes: ["NVIDIA A100 80GB PCIe"],
      region: "global",
      selection: { "variant.cloudType": "Secure Cloud" },
    });
  });

  it("builds a CPU pod's price list name from its flavor and shape", () => {
    expect(
      runpodInstancePricing(resource("pod", { cpuFlavorId: "cpu3c", vcpus: 2, memoryGb: 4 }))
        ?.instanceTypes,
    ).toEqual(["cpu3c-2-4"]);
  });

  it("lists a serverless endpoint's GPU types, and has nothing for other types", () => {
    expect(
      runpodInstancePricing(resource("serverless-endpoint", { gpuTypeIds: "A, B" }))?.instanceTypes,
    ).toEqual(["A", "B"]);
    expect(runpodInstancePricing(resource("template", {}))).toBeUndefined();
  });
});
