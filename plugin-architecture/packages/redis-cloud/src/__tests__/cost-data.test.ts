import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostFetchResult } from "@infrawrench/plugin-base";
import { fetchRedisCloudCostData, focusRowsToCostRows, splitRange } from "../cost-data.js";
import type { InventorySource } from "../cost-data.js";
import { completed, mockFetch } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const ctx = { accountKey: "a", userKey: "u", sleep: async () => {} };

const noInventory: InventorySource = {
  proSubscriptions: async () => [],
  essentialsSubscriptions: async () => [],
  proPricing: async () => [],
};

describe("splitRange", () => {
  it("cuts long ranges into windows the API accepts", () => {
    expect(splitRange({ fromDate: "2026-01-01", toDate: "2026-03-15" })).toEqual([
      { fromDate: "2026-01-01", toDate: "2026-02-09" },
      { fromDate: "2026-02-10", toDate: "2026-03-15" },
    ]);
  });
});

describe("focusRowsToCostRows", () => {
  it("spreads a multi-day charge period evenly and keeps only days in range", () => {
    const rows = focusRowsToCostRows(
      [
        {
          BilledCost: "30",
          BillingCurrency: "USD",
          ChargePeriodStart: "2026-09-01T00:00:00Z",
          ChargePeriodEnd: "2026-10-01T00:00:00Z",
          ServiceName: "Redis Cloud Essentials",
          RegionId: "us-west-1",
          ResourceId: "77",
          ResourceType: "Subscription",
          ResourceName: "small",
          Tags: { team: "web" },
        },
      ],
      { fromDate: "2026-09-29", toDate: "2026-10-05" },
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-29", "2026-09-30"]);
    expect(rows[0]).toMatchObject({
      amount: 1,
      service: "Redis Cloud Essentials",
      region: "us-west-1",
      resourceId: "77",
      tags: { team: "web", resourceType: "Subscription", resourceName: "small" },
    });
  });

  it("prorates partial days and separates network and tax lines", () => {
    const rows = focusRowsToCostRows(
      [
        {
          BilledCost: 2,
          ChargePeriodStart: "2026-09-01T12:00:00Z",
          ChargePeriodEnd: "2026-09-02T12:00:00Z",
          ServiceName: "Redis Cloud Pro",
          ResourceId: "51",
        },
        {
          BilledCost: 3,
          ChargePeriodStart: "2026-09-01T00:00:00Z",
          ChargePeriodEnd: "2026-09-02T00:00:00Z",
          ServiceName: "Redis Cloud Pro",
          PricingUnit: "Network",
          ResourceId: "1206",
        },
        {
          BilledCost: 1,
          ChargePeriodStart: "2026-09-01T00:00:00Z",
          ChargePeriodEnd: "2026-09-02T00:00:00Z",
          ServiceName: "Redis Cloud Pro",
          ChargeCategory: "Tax",
        },
      ],
      { fromDate: "2026-09-01", toDate: "2026-09-02" },
    );
    const db = rows.filter((r) => r.resourceId === "51");
    expect(db.map((r) => r.amount)).toEqual([1, 1]);
    expect(rows.find((r) => r.service === "Redis Cloud Pro Network")?.amount).toBe(3);
    expect(rows.find((r) => r.chargeType === "tax")?.amount).toBe(1);
  });
});

describe("fetchRedisCloudCostData", () => {
  it("generates, waits for and downloads a JSON report", async () => {
    const { calls } = mockFetch({
      "POST /cost-report": { taskId: "c-1", status: "received" },
      "GET /tasks/c-1": completed({ costReportId: "abc.json" }),
      "GET /cost-report/abc.json": [
        {
          BilledCost: 5,
          ChargePeriodStart: "2026-09-10T00:00:00Z",
          ChargePeriodEnd: "2026-09-11T00:00:00Z",
          ServiceName: "Redis Cloud Pro",
          ResourceId: "51",
        },
      ],
    });
    const rows = await fetchRedisCloudCostData(ctx, noInventory, {
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });
    expect(rows).toEqual([
      expect.objectContaining({ date: "2026-09-10", amount: 5, currency: "USD" }),
    ]);
    expect(calls[0]!.body).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      format: "json",
    });
  });

  it("falls back to a list-price estimate for today when the key may not generate reports", async () => {
    mockFetch({ "POST /cost-report": new Response("{}", { status: 403 }) });
    const src: InventorySource = {
      proSubscriptions: async () => [
        {
          id: 1,
          name: "prod",
          status: "active",
          subscriptionPricing: [
            { pricePerUnit: 0.5, quantity: 2, pricePeriod: "hour", priceCurrency: "USD" },
          ],
        },
      ],
      essentialsSubscriptions: async () => [
        { id: 2, name: "s", price: 30, pricePeriod: "Month", priceCurrency: "USD" },
      ],
      proPricing: async () => [],
    };
    const res = (await fetchRedisCloudCostData(
      ctx,
      src,
      { fromDate: "2026-09-01", toDate: "2026-09-30" },
      new Date("2026-09-15T10:00:00Z"),
    )) as CostFetchResult;
    expect(res.degraded).toBe(true);
    expect(res.rows).toEqual([
      expect.objectContaining({
        date: "2026-09-15",
        service: "Redis Cloud Pro",
        amount: 24,
        tags: expect.objectContaining({ costBasis: "list-price-estimate" }),
      }),
      expect.objectContaining({ service: "Redis Cloud Essentials", amount: 1 }),
    ]);
  });

  it("raises a setup error for a backfill window it cannot estimate", async () => {
    mockFetch({ "POST /cost-report": new Response("{}", { status: 403 }) });
    await expect(
      fetchRedisCloudCostData(
        ctx,
        noInventory,
        { fromDate: "2026-01-01", toDate: "2026-01-31" },
        new Date("2026-09-15T00:00:00Z"),
      ),
    ).rejects.toThrow(/Owner, Viewer or Billing admin/);
  });
});
