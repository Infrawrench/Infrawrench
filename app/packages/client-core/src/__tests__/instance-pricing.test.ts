import { describe, expect, it, vi } from "vitest";
import {
  attributeChangesSql,
  instanceLeaseMonths,
  instancePriceSteps,
  instancePricingPageUrl,
  instanceRegionCountSteps,
  instanceSpecsSql,
  offerMatchesSelection,
  onDemandByRegionSql,
  parseInstanceOffers,
  queryInstancePricing,
  resolveInstanceSelection,
  type InstancePriceOffer,
} from "../instance-pricing";
import { INSTANCE_PRICING_KEY } from "../instance-pricing-key";

const offer = (
  pricing: string,
  dimensions: Record<string, string>,
  effective: number,
): InstancePriceOffer => ({
  pricing,
  lease: "",
  offeringClass: "",
  purchaseOption: "",
  dimensions,
  hourly: effective,
  upfront: 0,
  effective,
});

describe("queryInstancePricing", () => {
  it("posts to the one route with the key as a bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ columns: [], rows: [], truncated: false, elapsedMs: 1 }),
    );
    await queryInstancePricing("https://app.test", "SELECT 1", 10, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://app.test/api/v1/instance-pricing/query");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${INSTANCE_PRICING_KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({ sql: "SELECT 1", maxRows: 10 });
  });

  it("rejects with the API's own message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "warehouse down" }, { status: 502 }),
    );
    await expect(queryInstancePricing("", "SELECT 1", 10, fetchImpl)).rejects.toThrow(
      "warehouse down",
    );
  });
});

describe("the key file", () => {
  it("cannot be mistaken for an API key or agent credential", () => {
    expect(INSTANCE_PRICING_KEY).toMatch(/^iwpub_/);
  });
});

describe("the panel's SQL", () => {
  it("escapes values taken from a resource", () => {
    expect(instanceSpecsSql("ec2", "m5'; DROP TABLE x;--")).toContain(
      "instance_type = 'm5\\'; DROP TABLE x;--'",
    );
    expect(attributeChangesSql("ec2", "m5.large", "a\\'b")).toContain("'a\\\\\\'b'");
  });

  it("filters on columns and map keys, and ignores any other selection key", () => {
    const sql = onDemandByRegionSql("azure", "Standard_D2s_v3", {
      operating_system: "Linux",
      "variant.priority": "Regular",
      "bad key) OR 1=1 --": "x",
    });
    expect(sql).toContain("AND operating_system IN ('Linux', '')");
    expect(sql).toContain("AND variant['priority'] IN ('Regular', '')");
    expect(sql).not.toContain("OR 1=1");
  });
});

describe("parseInstanceOffers", () => {
  it("flattens columns and the variant map into dimensions", () => {
    const [row] = parseInstanceOffers({
      columns: [
        "pricing",
        "lease",
        "operating_system",
        "tenancy",
        "variant",
        "effective_hourly_usd",
      ].map((name) => ({ name, type: "String" })),
      rows: [["on_demand", "", "Linux", "", '{"priority":"Regular"}', 0.5]],
      truncated: false,
      elapsedMs: 1,
    });
    expect(row).toMatchObject({
      pricing: "on_demand",
      effective: 0.5,
      dimensions: { operating_system: "Linux", "variant.priority": "Regular" },
    });
  });
});

describe("resolveInstanceSelection", () => {
  const offers = [
    offer("on_demand", { operating_system: "Linux", tenancy: "Shared" }, 1),
    offer("on_demand", { operating_system: "Linux", tenancy: "Dedicated" }, 2),
    offer("on_demand", { operating_system: "Windows", tenancy: "Shared" }, 3),
    offer("reserved", { operating_system: "SUSE", tenancy: "Shared" }, 0.5),
  ];

  it("keeps what is sold and opens the rest on the cheapest", () => {
    const { selection, choices } = resolveInstanceSelection(offers, {
      operating_system: "Windows",
    });
    expect(selection).toEqual({ operating_system: "Windows", tenancy: "Shared" });
    // Windows has no Dedicated row, so tenancy has nothing to pick between.
    expect(choices.map((c) => c.key)).toEqual(["operating_system"]);
  });

  it("never loses a wanted value to a dimension nobody asked about", () => {
    // The cheapest license row only exists for MariaDB, so narrowing on license
    // first would turn an Oracle database into a MariaDB one.
    const rds = [
      offer("on_demand", { database_engine: "MariaDB", license_model: "No license" }, 1),
      offer("on_demand", { database_engine: "Oracle", license_model: "BYOL" }, 2),
    ];
    const { selection } = resolveInstanceSelection(rds, { database_engine: "Oracle" });
    expect(selection).toEqual({ database_engine: "Oracle", license_model: "BYOL" });
  });

  it("lets the last pick, put first, win over an older one it cannot sit with", () => {
    const { selection } = resolveInstanceSelection(offers, {
      tenancy: "Dedicated",
      operating_system: "Windows",
    });
    expect(selection).toEqual({ operating_system: "Linux", tenancy: "Dedicated" });
  });

  it("falls back when the wanted value is not sold in this region", () => {
    const { selection } = resolveInstanceSelection(offers, { operating_system: "AIX" });
    expect(selection["operating_system"]).toBe("Linux");
  });

  it("offers on-demand combinations only, not reserved-only values", () => {
    const { choices } = resolveInstanceSelection(offers, {});
    expect(choices[0]!.values).toEqual(["Linux", "Windows"]);
  });

  it("treats a dimension a row leaves unset as matching", () => {
    expect(
      offerMatchesSelection(offer("spot", { operating_system: "Linux" }, 1), {
        operating_system: "Linux",
        tenancy: "Shared",
      }),
    ).toBe(true);
    expect(
      offerMatchesSelection(offer("spot", { operating_system: "Windows" }, 1), {
        operating_system: "Linux",
      }),
    ).toBe(false);
  });
});

describe("instancePriceSteps", () => {
  it("steps through changes, gaps and overlaps", () => {
    expect(
      instancePriceSteps([
        { validFrom: 10, validTo: 20, price: 5 },
        { validFrom: 20, validTo: 30, price: 4 },
        { validFrom: 25, validTo: null, price: 3 },
      ]),
    ).toEqual([
      [10, 5],
      [20, 4],
      [25, 3],
    ]);
    expect(
      instancePriceSteps([
        { validFrom: 10, validTo: 20, price: 5 },
        { validFrom: 30, validTo: null, price: 5 },
      ]),
    ).toEqual([
      [10, 5],
      [20, null],
      [30, 5],
    ]);
  });
});

describe("instanceRegionCountSteps", () => {
  it("counts a region once across price changes, and drops it when it stops", () => {
    expect(
      instanceRegionCountSteps([
        { region: "a", validFrom: 10, validTo: 20, price: 5 },
        { region: "a", validFrom: 20, validTo: null, price: 4 },
        { region: "b", validFrom: 15, validTo: 30, price: 6 },
      ]),
    ).toEqual([
      [10, 1],
      [15, 2],
      [30, 1],
    ]);
  });
});

describe("small helpers", () => {
  it("orders leases by length", () => {
    expect(instanceLeaseMonths("3mo")).toBe(3);
    expect(instanceLeaseMonths("1yr")).toBe(12);
    expect(instanceLeaseMonths("")).toBe(Number.POSITIVE_INFINITY);
  });

  it("builds each cloud's page path", () => {
    expect(instancePricingPageUrl("ec2", "m5.large", "us-east-1")).toBe(
      "https://instances.infrawrench.com/aws/ec2/m5.large?region=us-east-1",
    );
    expect(instancePricingPageUrl("azure", "Standard_D2s_v3")).toBe(
      "https://instances.infrawrench.com/azure/vms/Standard_D2s_v3",
    );
    expect(instancePricingPageUrl("runpod", "NVIDIA H100 80GB HBM3")).toBe(
      "https://instances.infrawrench.com/runpod/pods/NVIDIA%20H100%2080GB%20HBM3",
    );
  });
});
