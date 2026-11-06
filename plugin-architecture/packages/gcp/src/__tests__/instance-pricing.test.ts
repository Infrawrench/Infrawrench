import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { gcpInstancePricing } from "../instance-pricing.js";

const resource = (resourceTypeId: string, fields: Record<string, unknown>) =>
  ({ resourceTypeId, fields }) as unknown as ResourceInstance;

describe("gcpInstancePricing", () => {
  it("prices a zonal instance in its region, on Standard provisioning", () => {
    expect(
      gcpInstancePricing(
        resource("gce-instance", { zone: "us-central1-a", machineType: "n2-standard-2" }),
      ),
    ).toEqual({
      platform: "gcp",
      instanceTypes: ["n2-standard-2"],
      region: "us-central1",
      selection: { "variant.provisioningModel": "Standard" },
    });
  });

  it("leaves a regional GKE location alone", () => {
    expect(
      gcpInstancePricing(
        resource("gke-cluster", { location: "europe-west1", machineType: "e2-medium" }),
      )?.region,
    ).toBe("europe-west1");
  });

  it("has nothing for other types or a missing machine type", () => {
    expect(gcpInstancePricing(resource("gcs-bucket", { machineType: "x" }))).toBeUndefined();
    expect(gcpInstancePricing(resource("gce-instance", { zone: "us-central1-a" }))).toBeUndefined();
  });
});
