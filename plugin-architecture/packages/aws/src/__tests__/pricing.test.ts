import { afterEach, describe, expect, it, vi } from "vitest";
import { clearEc2PriceCache, fetchEc2MonthlyPrices, parseOnDemandHourlyUsd } from "../pricing.js";
import type { AwsCredentials } from "../auth.js";

function priceListEntry(hourlyUsd: string): string {
  return JSON.stringify({
    product: { sku: "SKU1", attributes: { instanceType: "t4g.small", regionCode: "eu-central-1" } },
    terms: {
      OnDemand: {
        "SKU1.JRTCKXETXF": {
          priceDimensions: {
            "SKU1.JRTCKXETXF.6YS6EN2CT7": {
              unit: "Hrs",
              pricePerUnit: { USD: hourlyUsd },
            },
          },
        },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearEc2PriceCache();
});

describe("parseOnDemandHourlyUsd", () => {
  it("extracts the hourly USD rate from a GetProducts PriceList entry", () => {
    expect(parseOnDemandHourlyUsd([priceListEntry("0.0192000000")])).toBeCloseTo(0.0192);
  });

  it("takes the cheapest positive rate across entries", () => {
    expect(
      parseOnDemandHourlyUsd([priceListEntry("0.0400000000"), priceListEntry("0.0192000000")]),
    ).toBeCloseTo(0.0192);
  });

  it("ignores zero rates, non-hourly units and malformed entries", () => {
    const zero = priceListEntry("0.0000000000");
    const monthly = JSON.stringify({
      terms: {
        OnDemand: {
          t: { priceDimensions: { d: { unit: "Quantity", pricePerUnit: { USD: "9.99" } } } },
        },
      },
    });
    expect(parseOnDemandHourlyUsd([zero, monthly, "{not json"])).toBeNull();
  });
});

describe("fetchEc2MonthlyPrices", () => {
  const creds = {
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    region: "eu-central-1",
  } as AwsCredentials;

  it("signs a GetProducts call against the us-east-1 pricing endpoint and returns monthly prices", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ PriceList: [priceListEntry("0.0192000000")] }), {
        status: 200,
      }),
    );
    const prices = await fetchEc2MonthlyPrices(creds, "eu-central-1", ["t4g.small"]);
    expect(prices).toEqual({ "t4g.small": Number((0.0192 * 730).toFixed(2)) });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://api.pricing.us-east-1.amazonaws.com/");
    const headers = init.headers as Record<string, string>;
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(headerKeys).toContain("x-amz-target");
    expect(headerKeys).toContain("authorization");
    const body = JSON.parse(String(init.body)) as {
      ServiceCode: string;
      Filters: Array<{ Field: string; Value: string }>;
    };
    expect(body.ServiceCode).toBe("AmazonEC2");
    expect(body.Filters).toContainEqual({
      Type: "TERM_MATCH",
      Field: "regionCode",
      Value: "eu-central-1",
    });
    expect(body.Filters).toContainEqual({
      Type: "TERM_MATCH",
      Field: "instanceType",
      Value: "t4g.small",
    });
  });

  it("omits types whose price can't be resolved instead of guessing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ PriceList: [] }), { status: 200 }),
    );
    const prices = await fetchEc2MonthlyPrices(creds, "eu-central-1", ["t9g.imaginary"]);
    expect(prices).toEqual({});
  });
});
