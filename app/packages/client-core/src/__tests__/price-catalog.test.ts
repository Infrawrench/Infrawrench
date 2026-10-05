import { describe, expect, it } from "vitest";
import {
  buildCatalogRows,
  formatCatalogSpecs,
  identityConverter,
  normalizePriceCatalogCompareQuery,
  normalizePriceCatalogSearchQuery,
  rankEquivalents,
  resolveCatalogRegion,
  rowMatchesQuery,
  selectCatalogPrice,
  sortCatalogRows,
  summarizeCurrencies,
  type PriceCatalogProduct,
} from "../price-catalog";

const products: PriceCatalogProduct[] = [
  {
    sku: "small",
    name: "small",
    serviceId: "vm",
    family: "compute",
    specs: { vcpus: 2, memoryGb: 4 },
    prices: [
      { region: "r1", rateType: "on-demand", unit: "hour", amount: 0.02, currency: "USD" },
      {
        region: "r1",
        rateType: "reserved",
        term: "3yr",
        unit: "hour",
        amount: 0.01,
        currency: "USD",
      },
      {
        region: "r1",
        rateType: "reserved",
        term: "1yr",
        unit: "hour",
        amount: 0.015,
        currency: "USD",
      },
    ],
  },
  {
    sku: "gpu",
    name: "gpu",
    serviceId: "vm",
    family: "gpu",
    specs: { vcpus: 8, memoryGb: 32, gpuCount: 1, gpuModel: "NVIDIA L4" },
    prices: [{ region: "r1", rateType: "on-demand", unit: "month", amount: 500, currency: "USD" }],
  },
];

function rows(rateType: "on-demand" | "reserved" = "on-demand", term?: string) {
  return buildCatalogRows({
    pluginId: "p",
    pluginName: "P",
    services: [{ id: "vm", label: "VMs", family: "compute" }],
    region: "r1",
    regionLabel: "Region 1",
    products,
    rateType,
    term,
    convert: identityConverter(null),
  });
}

describe("price catalog", () => {
  it("builds one row per priced product with monthly figures", () => {
    const r = rows();
    expect(r.map((x) => x.sku)).toEqual(["small", "gpu"]);
    expect(r[0]!.monthlyAmount).toBeCloseTo(14.6);
    expect(r[0]!.otherPrices).toHaveLength(2);
    expect(r[1]!.monthlyAmount).toBe(500);
  });

  it("selects the cheapest commitment unless a term is asked for", () => {
    expect(selectCatalogPrice(products[0]!.prices, "r1", "reserved")!.term).toBe("3yr");
    expect(selectCatalogPrice(products[0]!.prices, "r1", "reserved", "1yr")!.amount).toBe(0.015);
    expect(rows("reserved").map((x) => x.sku)).toEqual(["small"]);
  });

  it("filters by specs, gpu and price", () => {
    const r = rows();
    expect(r.filter((x) => rowMatchesQuery(x, { gpu: "required" })).map((x) => x.sku)).toEqual([
      "gpu",
    ]);
    expect(r.filter((x) => rowMatchesQuery(x, { gpuModel: "l4" })).map((x) => x.sku)).toEqual([
      "gpu",
    ]);
    expect(r.filter((x) => rowMatchesQuery(x, { maxMonthlyPrice: 20 })).map((x) => x.sku)).toEqual([
      "small",
    ]);
    expect(r.filter((x) => rowMatchesQuery(x, { minMemoryGb: 8 })).map((x) => x.sku)).toEqual([
      "gpu",
    ]);
  });

  it("sorts with missing values last", () => {
    const r = rows();
    expect(sortCatalogRows(r, "price", "desc").map((x) => x.sku)).toEqual(["gpu", "small"]);
    expect(sortCatalogRows(r, "gpus", "asc").map((x) => x.sku)).toEqual(["gpu", "small"]);
  });

  it("ranks equivalents at least as large, cheapest first, excluding GPUs unless asked", () => {
    const r = rows();
    expect(
      rankEquivalents(r, { vcpus: 2, memoryGb: 4, gpuCount: null, gpuModel: null }).map(
        (x) => x.sku,
      ),
    ).toEqual(["small"]);
    expect(
      rankEquivalents(r, { vcpus: null, memoryGb: null, gpuCount: 1, gpuModel: null }).map(
        (x) => x.sku,
      ),
    ).toEqual(["gpu"]);
  });

  it("resolves regions by exact id, then area", () => {
    const regions = [
      { id: "a", label: "A", area: "europe" as const },
      { id: "b", label: "B", area: "north-america" as const },
    ];
    expect(resolveCatalogRegion(regions, { region: "a", area: "north-america" })!.id).toBe("a");
    expect(resolveCatalogRegion(regions, { region: "zz", area: "north-america" })!.id).toBe("b");
    expect(resolveCatalogRegion(regions, { area: "africa" })).toBeNull();
  });

  it("normalizes loose query bags", () => {
    expect(
      normalizePriceCatalogSearchQuery({
        pluginIds: "aws,gcp",
        minVcpus: "4",
        gpu: "required",
        sort: "bogus",
        limit: "9999",
        area: "mars",
      }),
    ).toMatchObject({ pluginIds: ["aws", "gcp"], minVcpus: 4, gpu: "required", limit: 500 });
    expect(
      normalizePriceCatalogCompareQuery({ referencePluginId: "aws", referenceSku: "m7i.large" })
        .reference,
    ).toEqual({ pluginId: "aws", sku: "m7i.large" });
  });

  it("flags mixed currencies and formats specs", () => {
    const r = rows();
    expect(summarizeCurrencies(r)).toEqual({ currencies: ["USD"], mixedCurrencies: false });
    const eur = { ...r[0]!, comparable: { amount: 1, currency: "EUR" } };
    expect(summarizeCurrencies([r[0]!, eur]).mixedCurrencies).toBe(true);
    expect(formatCatalogSpecs(products[1]!.specs)).toBe("8 vCPU · 32 GB · 1× NVIDIA L4");
  });
});
