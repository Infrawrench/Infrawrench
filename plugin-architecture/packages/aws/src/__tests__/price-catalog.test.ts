import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AWS_PRICE_CATALOG,
  clearAwsPriceCatalogCache,
  ec2SpecsFromAttributes,
  fetchAwsPriceCatalog,
  type AwsPriceCatalogTransport,
} from "../price-catalog.js";
import { AWSClient } from "../client.js";

/**
 * Fixtures follow the documented GetProducts `PriceList` shape (a JSON string
 * per product with `product.attributes` and `terms.OnDemand` /
 * `terms.Reserved`), with fake SKU codes.
 */
function entry(opts: {
  instanceType: string;
  attributes?: Record<string, string>;
  onDemand?: string;
  reserved?: Array<{
    lease: string;
    option: string;
    offeringClass?: string;
    hourly?: string;
    upfront?: string;
  }>;
}): string {
  const reserved: Record<string, unknown> = {};
  (opts.reserved ?? []).forEach((r, i) => {
    const dims: Record<string, unknown> = {};
    if (r.hourly !== undefined) {
      dims[`FAKESKU.R${i}.H`] = { unit: "Hrs", pricePerUnit: { USD: r.hourly } };
    }
    if (r.upfront !== undefined) {
      dims[`FAKESKU.R${i}.U`] = {
        unit: "Quantity",
        description: "Upfront Fee",
        pricePerUnit: { USD: r.upfront },
      };
    }
    reserved[`FAKESKU.R${i}`] = {
      effectiveDate: "2026-09-01T00:00:00Z",
      termAttributes: {
        LeaseContractLength: r.lease,
        OfferingClass: r.offeringClass ?? "standard",
        PurchaseOption: r.option,
      },
      priceDimensions: dims,
    };
  });
  return JSON.stringify({
    product: {
      sku: `FAKESKU-${opts.instanceType}`,
      attributes: {
        instanceType: opts.instanceType,
        operation: "RunInstances",
        ...opts.attributes,
      },
    },
    terms: {
      OnDemand: opts.onDemand
        ? {
            "FAKESKU.OD": {
              effectiveDate: "2026-08-01T00:00:00Z",
              priceDimensions: {
                "FAKESKU.OD.H": { unit: "Hrs", pricePerUnit: { USD: opts.onDemand } },
              },
            },
          }
        : {},
      Reserved: reserved,
    },
  });
}

const M7G = entry({
  instanceType: "m7g.large",
  attributes: {
    instanceFamily: "General purpose",
    vcpu: "2",
    memory: "8 GiB",
    storage: "EBS only",
    physicalProcessor: "AWS Graviton3 Processor",
    processorArchitecture: "64-bit",
    networkPerformance: "Up to 12500 Megabit",
    gpu: "NA",
  },
  onDemand: "0.0816000000",
  reserved: [
    { lease: "1yr", option: "No Upfront", hourly: "0.0500000000" },
    { lease: "1yr", option: "All Upfront", hourly: "0.0000000000", upfront: "438" },
    { lease: "3yr", option: "Partial Upfront", hourly: "0.0100000000", upfront: "262.8" },
    { lease: "1yr", option: "No Upfront", offeringClass: "convertible", hourly: "0.06" },
  ],
});

const P4D = entry({
  instanceType: "p4d.24xlarge",
  attributes: {
    vcpu: "96",
    memory: "1152 GiB",
    gpu: "8",
    gpuMemory: "320 GB",
    storage: "8 x 1000 SSD",
    physicalProcessor: "Intel Xeon Platinum 8275L",
    processorArchitecture: "64-bit",
    networkPerformance: "4x 100 Gigabit",
  },
  onDemand: "32.7726000000",
});

function transport(
  pages: Array<{ PriceList: string[]; NextToken?: string }>,
  spot?: Record<string, unknown> | Error,
): AwsPriceCatalogTransport & {
  getProducts: ReturnType<typeof vi.fn>;
  describeSpotPriceHistory: ReturnType<typeof vi.fn>;
} {
  let page = 0;
  return {
    getProducts: vi.fn(async () => pages[page++] ?? { PriceList: [] }),
    describeSpotPriceHistory: vi.fn(async () => {
      if (spot instanceof Error) throw spot;
      return spot ?? {};
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAwsPriceCatalogCache();
});

describe("AWS_PRICE_CATALOG", () => {
  it("declares a credentialed EC2 catalog with us-east-1 first", () => {
    expect(AWS_PRICE_CATALOG.requiresCredentials).toBe(true);
    expect(AWS_PRICE_CATALOG.permission).toBe("pricing:GetProducts");
    expect(AWS_PRICE_CATALOG.services.map((s) => s.id)).toEqual(["ec2"]);
    expect(AWS_PRICE_CATALOG.regions[0]?.id).toBe("us-east-1");
    const byId = new Map(AWS_PRICE_CATALOG.regions.map((r) => [r.id, r.area]));
    expect(byId.get("ap-southeast-2")).toBe("oceania");
    expect(byId.get("eu-west-1")).toBe("europe");
    expect(byId.get("il-central-1")).toBe("middle-east");
  });
});

describe("ec2SpecsFromAttributes", () => {
  it("parses memory, storage, architecture and per-GPU memory", () => {
    expect(
      ec2SpecsFromAttributes({
        vcpu: "96",
        memory: "1,152 GiB",
        gpu: "8",
        gpuMemory: "320 GB",
        storage: "8 x 1000 SSD",
        physicalProcessor: "Intel Xeon Platinum 8275L",
        networkPerformance: "4x 100 Gigabit",
      }),
    ).toEqual({
      vcpus: 96,
      memoryGb: 1152,
      gpuCount: 8,
      gpuMemoryGb: 40,
      storageGb: 8000,
      storageType: "ssd",
      architecture: "x86_64",
      network: "4x 100 Gigabit",
    });
    expect(ec2SpecsFromAttributes({ storage: "1 x 1900 NVMe SSD" })).toMatchObject({
      storageGb: 1900,
      storageType: "nvme ssd",
    });
  });
});

describe("fetchAwsPriceCatalog", () => {
  it("maps specs, on-demand, reserved, spot and the estimate link", async () => {
    const t = transport([{ PriceList: [M7G, P4D] }], {
      spotPriceHistorySet: {
        item: [
          {
            instanceType: "m7g.large",
            productDescription: "Linux/UNIX",
            spotPrice: "0.0300",
            timestamp: "2026-10-05T01:00:00.000Z",
            availabilityZone: "eu-central-1a",
          },
          {
            instanceType: "m7g.large",
            productDescription: "Linux/UNIX",
            spotPrice: "0.0250",
            timestamp: "2026-10-05T02:00:00.000Z",
            availabilityZone: "eu-central-1b",
          },
        ],
      },
    });
    const result = await fetchAwsPriceCatalog(t, { serviceId: "ec2", region: "eu-central-1" });
    expect(result.truncated).toBeUndefined();

    const body = t.getProducts.mock.calls[0]![0] as {
      ServiceCode: string;
      Filters: Array<{ Field: string; Value: string }>;
    };
    expect(body.ServiceCode).toBe("AmazonEC2");
    expect(body.Filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Field: "regionCode", Value: "eu-central-1" }),
        expect.objectContaining({ Field: "tenancy", Value: "Shared" }),
        expect.objectContaining({ Field: "operatingSystem", Value: "Linux" }),
        expect.objectContaining({ Field: "preInstalledSw", Value: "NA" }),
        expect.objectContaining({ Field: "capacitystatus", Value: "Used" }),
      ]),
    );
    expect(t.describeSpotPriceHistory).toHaveBeenCalledWith(
      "eu-central-1",
      expect.objectContaining({ "ProductDescription.1": "Linux/UNIX" }),
    );

    const m7g = result.products.find((p) => p.sku === "m7g.large")!;
    expect(m7g).toMatchObject({
      name: "m7g.large",
      serviceId: "ec2",
      family: "compute",
      series: "m7g",
      specs: {
        vcpus: 2,
        memoryGb: 8,
        storageType: "ebs-only",
        architecture: "arm64",
        network: "Up to 12500 Megabit",
      },
      estimate: {
        resourceTypeId: "ec2-instance",
        fields: { region: "{region}", instanceType: "m7g.large" },
      },
    });
    const onDemand = m7g.prices.find((p) => p.rateType === "on-demand")!;
    expect(onDemand).toEqual({
      region: "eu-central-1",
      rateType: "on-demand",
      unit: "hour",
      amount: 0.0816,
      currency: "USD",
      effectiveDate: "2026-08-01T00:00:00Z",
    });

    const reserved = m7g.prices.filter((p) => p.rateType === "reserved");
    // The convertible term is skipped.
    expect(reserved).toHaveLength(3);
    const noUpfront = reserved.find((p) => p.paymentOption === "No Upfront")!;
    expect(noUpfront.term).toBe("1yr");
    expect(noUpfront.amount).toBeCloseTo(0.05);
    // 438 / 8760 = 0.05
    expect(reserved.find((p) => p.paymentOption === "All Upfront")!.amount).toBeCloseTo(0.05);
    // 0.01 + 262.8 / 26280 = 0.02
    const partial = reserved.find((p) => p.paymentOption === "Partial Upfront")!;
    expect(partial.term).toBe("3yr");
    expect(partial.amount).toBeCloseTo(0.02);

    const spot = m7g.prices.find((p) => p.rateType === "spot")!;
    expect(spot.amount).toBeCloseTo(0.025);
    expect(spot.effectiveDate).toBe("2026-10-05T02:00:00.000Z");

    const p4d = result.products.find((p) => p.sku === "p4d.24xlarge")!;
    expect(p4d.family).toBe("gpu");
    expect(p4d.specs.gpuCount).toBe(8);
    expect(p4d.prices.map((p) => p.rateType)).toEqual(["on-demand"]);
  });

  it("pages NextToken and marks the result truncated at the page cap", async () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      PriceList: [entry({ instanceType: `t9.fake${i}`, onDemand: "0.01" })],
      NextToken: `fake-token-${i}`,
    }));
    const t = transport(pages);
    const result = await fetchAwsPriceCatalog(t, { serviceId: "ec2", region: "us-east-1" });
    expect(t.getProducts).toHaveBeenCalledTimes(30);
    expect(result.truncated).toBe(true);
    expect(result.products).toHaveLength(30);
    expect(t.getProducts.mock.calls[1]![0]).toMatchObject({ NextToken: "fake-token-0" });
  });

  it("keeps on-demand and reserved when spot is refused, and caches the price list", async () => {
    const t = transport([{ PriceList: [M7G] }], new Error("UnauthorizedOperation"));
    const first = await fetchAwsPriceCatalog(t, { serviceId: "ec2" });
    expect(first.products[0]!.prices.some((p) => p.rateType === "spot")).toBe(false);
    expect(first.products[0]!.prices[0]!.region).toBe("us-east-1");
    await fetchAwsPriceCatalog(t, { serviceId: "ec2" });
    expect(t.getProducts).toHaveBeenCalledTimes(1);
    // Spot failures are not cached.
    expect(t.describeSpotPriceHistory).toHaveBeenCalledTimes(2);
  });

  it("drops products with no usable price and unknown services", async () => {
    const t = transport([
      { PriceList: [entry({ instanceType: "x9.fake", onDemand: "0" }), "{bad"] },
    ]);
    expect((await fetchAwsPriceCatalog(t, { serviceId: "ec2" })).products).toEqual([]);
    expect((await fetchAwsPriceCatalog(t, { serviceId: "s3" })).products).toEqual([]);
  });
});

describe("AWSClient.fetchPriceCatalog", () => {
  it("signs GetProducts against the pricing endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.pricing.us-east-1.amazonaws.com/")) {
        return new Response(JSON.stringify({ PriceList: [M7G] }), { status: 200 });
      }
      return new Response(
        `<DescribeSpotPriceHistoryResponse><spotPriceHistorySet/><nextToken/></DescribeSpotPriceHistoryResponse>`,
        { status: 200 },
      );
    });
    const client = new AWSClient({
      accessKeyId: "AKIAFAKEFAKEFAKE",
      secretAccessKey: "fake-secret",
      region: "eu-west-1",
    });
    const result = await client.fetchPriceCatalog({ serviceId: "ec2", region: "eu-west-1" });
    expect(result.products.map((p) => p.sku)).toEqual(["m7g.large"]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("Action=DescribeSpotPriceHistory"))).toBe(true);
  });
});
