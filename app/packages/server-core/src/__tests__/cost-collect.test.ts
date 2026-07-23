import { describe, expect, it } from "vitest";
import { isoDay, monthChunks } from "../cost/dates";
import { hashTags, toCostDailyRows } from "../clickhouse/cost-writers";

describe("monthChunks", () => {
  it("keeps a same-month range as one chunk", () => {
    expect(monthChunks("2026-07-03", "2026-07-20")).toEqual([
      { fromDate: "2026-07-03", toDate: "2026-07-20" },
    ]);
  });

  it("splits on calendar month boundaries with partial edges", () => {
    expect(monthChunks("2026-05-20", "2026-07-10")).toEqual([
      { fromDate: "2026-05-20", toDate: "2026-05-31" },
      { fromDate: "2026-06-01", toDate: "2026-06-30" },
      { fromDate: "2026-07-01", toDate: "2026-07-10" },
    ]);
  });

  it("handles a single day", () => {
    expect(monthChunks("2026-02-28", "2026-02-28")).toEqual([
      { fromDate: "2026-02-28", toDate: "2026-02-28" },
    ]);
  });

  it("handles leap-year February", () => {
    expect(monthChunks("2028-02-27", "2028-03-02")).toEqual([
      { fromDate: "2028-02-27", toDate: "2028-02-29" },
      { fromDate: "2028-03-01", toDate: "2028-03-02" },
    ]);
  });

  it("crosses year boundaries", () => {
    const chunks = monthChunks("2025-11-15", "2026-01-15");
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toEqual({ fromDate: "2026-01-01", toDate: "2026-01-15" });
  });
});

describe("isoDay", () => {
  it("formats UTC dates", () => {
    expect(isoDay(new Date("2026-07-23T15:30:00.000Z"))).toBe("2026-07-23");
  });
});

describe("hashTags", () => {
  it("returns 0 for empty or absent tags", () => {
    expect(hashTags(undefined)).toBe("0");
    expect(hashTags({})).toBe("0");
  });

  it("is order-insensitive and value-sensitive", () => {
    const a = hashTags({ env: "prod", team: "core" });
    const b = hashTags({ team: "core", env: "prod" });
    const c = hashTags({ env: "staging", team: "core" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("stays within UInt64 range", () => {
    const h = BigInt(hashTags({ k: "v".repeat(1000) }));
    expect(h >= 0n && h < 2n ** 64n).toBe(true);
  });
});

describe("toCostDailyRows", () => {
  it("maps CostRows with defaults for absent dimensions", () => {
    const rows = toCostDailyRows({ organizationId: "org1", accountId: "acc1", pluginId: "aws" }, [
      {
        date: "2026-07-01",
        service: "AmazonEC2",
        region: "us-east-1",
        currency: "USD",
        amount: 12.5,
      },
      { date: "2026-07-01", currency: "USD", amount: 1, usageAmount: 3, usageUnit: "GB" },
    ]);
    expect(rows[0]).toMatchObject({
      organization_id: "org1",
      account_id: "acc1",
      plugin_id: "aws",
      day: "2026-07-01",
      service: "AmazonEC2",
      region: "us-east-1",
      resource_id: "",
      tags_hash: "0",
      currency: "USD",
      amount: 12.5,
      usage_amount: 0,
      usage_unit: "",
    });
    expect(rows[1]).toMatchObject({ service: "", usage_amount: 3, usage_unit: "GB" });
  });
});
