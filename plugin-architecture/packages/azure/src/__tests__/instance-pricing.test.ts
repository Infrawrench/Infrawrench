import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { azureInstancePricing } from "../instance-pricing.js";

const resource = (resourceTypeId: string, fields: Record<string, unknown>) =>
  ({ resourceTypeId, fields }) as unknown as ResourceInstance;

describe("azureInstancePricing", () => {
  it("reads the size, location and operating system, on regular priority", () => {
    expect(
      azureInstancePricing(
        resource("azure-vm", { vmSize: "Standard_D2s_v3", location: "eastus", osType: "Windows" }),
      ),
    ).toEqual({
      platform: "azure",
      instanceTypes: ["Standard_D2s_v3"],
      region: "eastus",
      selection: { operating_system: "Windows", "variant.priority": "Regular" },
    });
  });

  it("defaults to Linux, and has nothing for other types", () => {
    expect(
      azureInstancePricing(
        resource("azure-aks-cluster", { vmSize: "Standard_D2s_v3", location: "eastus" }),
      )?.selection?.["operating_system"],
    ).toBe("Linux");
    expect(azureInstancePricing(resource("azure-disk", { vmSize: "x" }))).toBeUndefined();
  });
});
