import { describe, expect, it } from "vitest";
import { buildLkeNodeRates } from "../lke-node-rates.js";
import type { PriceCatalog } from "../pricing.js";

const catalog: PriceCatalog = {
  linodeTypes: [
    {
      id: "g6-standard-2",
      label: "Linode 4GB",
      price: { hourly: 0.036, monthly: 24 },
      region_prices: [{ id: "br-gru", hourly: 0.05, monthly: 33.6 }],
    },
  ],
  volumeTypes: [
    { id: "volume", label: "Storage Volume", price: { hourly: 0.00015, monthly: 0.1 } },
  ],
  nodeBalancerTypes: [
    { id: "nodebalancer", label: "NodeBalancer", price: { hourly: 0.015, monthly: 10 } },
  ],
  lkeTypes: [
    { id: "lke-sa", label: "LKE Standard", price: { hourly: 0, monthly: 0 } },
    { id: "lke-ha", label: "LKE HA", price: { hourly: 0.09, monthly: 60 } },
    { id: "lke-e", label: "LKE Enterprise", price: { hourly: 0.45, monthly: 300 } },
  ],
  objectStorageTypes: [],
  transferPrices: [],
  reservedIpTypes: [],
  databaseTypes: [],
};

describe("buildLkeNodeRates", () => {
  it("emits the rate table the Kubernetes peer parses, not a bare plan map", () => {
    const raw = buildLkeNodeRates(
      { id: 1, region: "us-east", control_plane: { high_availability: true } },
      [{ id: 10, type: "g6-standard-2" }],
      catalog,
    );
    expect(JSON.parse(raw)).toEqual({
      currency: "USD",
      source: "billed",
      byInstanceType: { "g6-standard-2": 0.036 },
      byNodeName: {},
      controlPlaneHourly: 0.09,
      loadBalancerHourly: 0.015,
      storageGiBMonth: { "*": 0.1 },
    });
  });

  it("uses the regional override and the free standard control plane", () => {
    const parsed = JSON.parse(
      buildLkeNodeRates({ id: 1, region: "br-gru" }, [{ id: 10, type: "g6-standard-2" }], catalog),
    );
    expect(parsed.byInstanceType).toEqual({ "g6-standard-2": 0.05 });
    expect(parsed.controlPlaneHourly).toBe(0);
  });

  it("prices an enterprise cluster's control plane at lke-e", () => {
    const parsed = JSON.parse(
      buildLkeNodeRates(
        { id: 1, region: "us-east", tier: "enterprise" },
        [{ id: 10, type: "g6-standard-2" }],
        catalog,
      ),
    );
    expect(parsed.controlPlaneHourly).toBe(0.45);
  });

  it("returns empty when no pool plan is priced", () => {
    expect(buildLkeNodeRates({ id: 1 }, [{ id: 10, type: "g6-unknown" }], catalog)).toBe("");
  });
});
