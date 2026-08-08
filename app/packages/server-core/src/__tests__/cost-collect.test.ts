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

  /**
   * charge_type and commitment_id are not in cost_daily's (frozen) ORDER BY, so
   * they ride in tags_hash instead. These are the cases that keeps honest.
   */
  describe("charge type and commitment folding", () => {
    it("hashes the default charge type exactly as a plain tags map", () => {
      // The compatibility case. If this ever differs, re-collecting a day stops
      // replacing the rows already stored for it and every historical number
      // doubles on the next restatement pass.
      expect(hashTags({ env: "prod" }, { chargeType: "usage" })).toBe(hashTags({ env: "prod" }));
      expect(hashTags({ env: "prod" }, {})).toBe(hashTags({ env: "prod" }));
      expect(hashTags(undefined, { chargeType: "usage", commitmentId: "" })).toBe("0");
      expect(hashTags({}, { chargeType: "usage" })).toBe("0");
    });

    it("separates each non-usage charge type from usage and from the others", () => {
      const usage = hashTags({ env: "prod" });
      const hashes = ["credit", "tax", "refund", "commitment_fee"].map((t) =>
        hashTags({ env: "prod" }, { chargeType: t }),
      );
      for (const h of hashes) expect(h).not.toBe(usage);
      expect(new Set(hashes).size).toBe(hashes.length);
    });

    it("separates charge types on untagged rows too", () => {
      // The untagged path used to short-circuit to "0" before looking at
      // anything else — a credit with no tags would have collapsed onto the
      // usage row it was credited against.
      expect(hashTags(undefined, { chargeType: "credit" })).not.toBe("0");
      expect(hashTags(undefined, { chargeType: "credit" })).not.toBe(
        hashTags(undefined, { chargeType: "tax" }),
      );
    });

    it("separates rows by commitment id, and only when one is set", () => {
      const none = hashTags({ env: "prod" });
      const a = hashTags({ env: "prod" }, { commitmentId: "ri-1" });
      const b = hashTags({ env: "prod" }, { commitmentId: "ri-2" });
      expect(a).not.toBe(none);
      expect(a).not.toBe(b);
      expect(hashTags({ env: "prod" }, { commitmentId: "" })).toBe(none);
    });

    it("is deterministic across calls, so re-ingesting a day replaces it", () => {
      const first = hashTags({ team: "core", env: "prod" }, { chargeType: "credit" });
      const second = hashTags({ env: "prod", team: "core" }, { chargeType: "credit" });
      expect(first).toBe(second);
    });
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
      charge_type: "usage",
      amortized_amount: 0,
      commitment_id: "",
    });
    expect(rows[1]).toMatchObject({ service: "", usage_amount: 3, usage_unit: "GB" });
  });

  it("carries charge type, amortized amount and commitment id through", () => {
    const [row] = toCostDailyRows({ organizationId: "org1", accountId: "acc1", pluginId: "aws" }, [
      {
        date: "2026-07-01",
        service: "AmazonEC2",
        currency: "USD",
        amount: 8760,
        chargeType: "commitment_fee",
        amortizedAmount: 24,
        commitmentId: "ri-abc",
      },
    ]);
    expect(row).toMatchObject({
      charge_type: "commitment_fee",
      amortized_amount: 24,
      commitment_id: "ri-abc",
      amount: 8760,
    });
  });

  it("keeps same-day usage, credit and tax as three distinct rows", () => {
    // The failure this guards: cost_daily is a ReplacingMergeTree keyed on
    // tags_hash (charge_type is NOT in the sort key), so three rows identical
    // in every key column would be treated as three versions of one row and
    // FINAL would keep only the last ingested — the credit would eat the usage.
    const rows = toCostDailyRows({ organizationId: "org1", accountId: "acc1", pluginId: "aws" }, [
      { date: "2026-07-01", service: "AmazonEC2", currency: "USD", amount: 100 },
      {
        date: "2026-07-01",
        service: "AmazonEC2",
        currency: "USD",
        amount: -10,
        chargeType: "credit",
      },
      { date: "2026-07-01", service: "AmazonEC2", currency: "USD", amount: 8, chargeType: "tax" },
    ]);
    expect(new Set(rows.map((r) => r.tags_hash)).size).toBe(3);
  });

  it("keeps two commitments' rows apart on an otherwise identical day", () => {
    const rows = toCostDailyRows({ organizationId: "org1", accountId: "acc1", pluginId: "aws" }, [
      {
        date: "2026-07-01",
        service: "AmazonEC2",
        currency: "USD",
        amount: 5,
        chargeType: "commitment_discount",
        commitmentId: "ri-1",
      },
      {
        date: "2026-07-01",
        service: "AmazonEC2",
        currency: "USD",
        amount: 7,
        chargeType: "commitment_discount",
        commitmentId: "ri-2",
      },
    ]);
    expect(rows[0]!.tags_hash).not.toBe(rows[1]!.tags_hash);
  });

  it("hashes a plain usage row exactly as it did before charge types existed", () => {
    const [tagged] = toCostDailyRows(
      { organizationId: "org1", accountId: "acc1", pluginId: "aws" },
      [{ date: "2026-07-01", currency: "USD", amount: 1, tags: { env: "prod" } }],
    );
    expect(tagged!.tags_hash).toBe(hashTags({ env: "prod" }));
  });
});
