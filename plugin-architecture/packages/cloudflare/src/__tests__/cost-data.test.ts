import { describe, it, expect, vi } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import { fetchCloudflareCostData } from "../cost-data.js";
import { makeApi } from "./_helpers.js";

interface FakeSub {
  id: string;
  start_timestamp: string;
  billing_cycle_anchor_timestamp: string;
  end_timestamp?: string;
}

function record(over: Record<string, unknown> = {}) {
  return {
    ServiceName: "Workers Standard",
    ServiceFamilyName: "Workers",
    ChargePeriodStart: "2026-08-01T00:00:00Z",
    ChargePeriodEnd: "2026-08-02T00:00:00Z",
    BillingCurrency: "USD",
    ContractedCost: 0.75,
    ConsumedQuantity: 150000,
    ConsumedUnit: "Count",
    PricingQuantity: 150000,
    PricingUnit: "Count",
    ZoneId: null,
    ZoneName: null,
    ...over,
  };
}

function costApi({
  records = [record()],
  covered = true,
  subscriptions = [
    {
      id: "sub1",
      start_timestamp: "2025-01-01T00:00:00Z",
      billing_cycle_anchor_timestamp: "2025-01-01T00:00:00Z",
    },
  ] as FakeSub[],
  usageError = null as unknown,
  infoError = null as unknown,
} = {}) {
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/billable-usage/info")) {
      if (infoError) throw infoError;
      return { success: true, result: { covered, subscriptions }, errors: [] };
    }
    if (usageError) throw usageError;
    return { success: true, result: records, errors: [] };
  });
  return makeApi({ cf: { get } });
}

const range = { fromDate: "2026-08-01", toDate: "2026-08-31" };

describe("fetchCloudflareCostData", () => {
  it("maps billable-usage records to cost rows", async () => {
    const api = costApi({
      records: [
        record(),
        record({
          ServiceName: "R2 Storage",
          ChargePeriodStart: "2026-08-02T00:00:00Z",
          ContractedCost: 1.5,
          ConsumedQuantity: 20,
          ConsumedUnit: "GB-months",
          ZoneName: "a.com",
        }),
      ],
    });
    const rows = await fetchCloudflareCostData(api, range);
    expect(rows).toEqual([
      {
        date: "2026-08-01",
        service: "Workers Standard",
        currency: "USD",
        amount: 0.75,
        usageAmount: 150000,
        usageUnit: "Count",
      },
      {
        date: "2026-08-02",
        service: "R2 Storage",
        tags: { zone: "a.com" },
        currency: "USD",
        amount: 1.5,
        usageAmount: 20,
        usageUnit: "GB-months",
      },
    ]);
  });

  it("falls back to PricingUnit when ConsumedUnit is empty", async () => {
    const api = costApi({ records: [record({ ConsumedUnit: "", PricingUnit: "Count" })] });
    const rows = await fetchCloudflareCostData(api, range);
    expect(rows[0]!.usageUnit).toBe("Count");
  });

  it("merges same-day same-service records and sums usage with matching units", async () => {
    const api = costApi({
      records: [record(), record({ ContractedCost: 0.25, ConsumedQuantity: 50000 })],
    });
    const rows = await fetchCloudflareCostData(api, range);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBeCloseTo(1.0);
    expect(rows[0]!.usageAmount).toBe(200000);
  });

  it("drops usage on unit mismatch but keeps the money", async () => {
    const api = costApi({
      records: [record(), record({ ContractedCost: 0.25, ConsumedUnit: "GB-seconds" })],
    });
    const rows = await fetchCloudflareCostData(api, range);
    expect(rows[0]!.amount).toBeCloseTo(1.0);
    expect(rows[0]!.usageAmount).toBeUndefined();
    expect(rows[0]!.usageUnit).toBeUndefined();
  });

  it("skips zero-cost records and periods outside the requested chunk", async () => {
    const api = costApi({
      records: [
        record({ ContractedCost: 0 }),
        record({ ChargePeriodStart: "2026-07-15T00:00:00Z" }),
        record({ ChargePeriodStart: "2026-08-10T00:00:00Z" }),
      ],
    });
    const rows = await fetchCloudflareCostData(api, range);
    expect(rows).toEqual([expect.objectContaining({ date: "2026-08-10" })]);
  });

  it("widens `from` back to the latest cycle anchor when the range misses it", async () => {
    const api = costApi({
      subscriptions: [
        {
          id: "s",
          start_timestamp: "2025-01-15T00:00:00Z",
          billing_cycle_anchor_timestamp: "2025-01-15T00:00:00Z",
        },
      ],
    });
    await fetchCloudflareCostData(api, { fromDate: "2026-08-01", toDate: "2026-08-03" });
    expect(api.cf.get).toHaveBeenCalledWith("/accounts/acct-cf/billable-usage", {
      query: { from: "2026-07-15", to: "2026-08-03" },
    });
  });

  it("clamps day-31 anchors to the last day of shorter months", async () => {
    const api = costApi({
      subscriptions: [
        {
          id: "s",
          start_timestamp: "2025-01-31T00:00:00Z",
          billing_cycle_anchor_timestamp: "2025-01-31T00:00:00Z",
        },
      ],
    });
    await fetchCloudflareCostData(api, { fromDate: "2026-06-05", toDate: "2026-06-08" });
    expect(api.cf.get).toHaveBeenCalledWith("/accounts/acct-cf/billable-usage", {
      query: { from: "2026-05-31", to: "2026-06-08" },
    });
  });

  it("does not widen when the range already contains the anchor day", async () => {
    const api = costApi({
      subscriptions: [
        {
          id: "s",
          start_timestamp: "2025-01-15T00:00:00Z",
          billing_cycle_anchor_timestamp: "2025-01-15T00:00:00Z",
        },
      ],
    });
    await fetchCloudflareCostData(api, range);
    expect(api.cf.get).toHaveBeenCalledWith("/accounts/acct-cf/billable-usage", {
      query: { from: "2026-08-01", to: "2026-08-31" },
    });
  });

  it("fetches info once per client across chunks", async () => {
    const api = costApi();
    await fetchCloudflareCostData(api, { fromDate: "2026-07-01", toDate: "2026-07-31" });
    await fetchCloudflareCostData(api, range);
    const infoCalls = (api.cf.get as ReturnType<typeof vi.fn>).mock.calls.filter(([p]) =>
      String(p).endsWith("/billable-usage/info"),
    );
    expect(infoCalls).toHaveLength(1);
  });

  it("throws CostSetupError with a help link when the account is not covered", async () => {
    const api = costApi({ covered: false });
    const err = await fetchCloudflareCostData(api, range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as CostSetupError).helpLink?.url).toContain("billable-usage");
  });

  it("maps 403 to a CostSetupError naming the Billing Read permission", async () => {
    const api = costApi({ infoError: Object.assign(new Error("Forbidden"), { status: 403 }) });
    const err = await fetchCloudflareCostData(api, range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as Error).message).toContain("Billing Read");
  });

  it("maps 404 on the usage call to a rollout CostSetupError", async () => {
    const api = costApi({ usageError: Object.assign(new Error("Not Found"), { status: 404 }) });
    const err = await fetchCloudflareCostData(api, range).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostSetupError);
    expect((err as Error).message).toContain("not available for this account");
  });

  it("rethrows non-setup failures as plain errors", async () => {
    const api = costApi({ usageError: Object.assign(new Error("boom"), { status: 500 }) });
    const err = await fetchCloudflareCostData(api, range).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CostSetupError);
  });
});
