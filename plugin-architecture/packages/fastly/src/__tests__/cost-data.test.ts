import { describe, expect, it } from "vitest";
import { CostSetupError } from "@infrawrench/plugin-base";
import {
  chargeTypeOf,
  fetchFastlyBillingSummary,
  fetchFastlyCostData,
  linesToRows,
  monthStartOf,
  periodStartsInRange,
} from "../cost-data.js";
import { ctxWith, makeHttp } from "./helpers.js";

const NOW = new Date("2026-10-04T12:00:00Z");

const SEPT_INVOICE = {
  invoice_id: "4183280",
  billing_start_date: "2026-09-01T00:00:00Z",
  billing_end_date: "2026-09-30T23:59:59Z",
  invoice_posted_on: "2026-10-02T00:00:00Z",
  currency_code: "EUR",
  monthly_transaction_amount: 182.5,
  statement_number: "ST-9",
  transaction_line_items: [
    {
      amount: 100,
      units: 1000,
      usage_type: "bandwidth",
      product_name: "CDN",
      product_line: "Network Services",
      product_group: "Full-Site Delivery",
      region: "North America",
    },
    {
      amount: 50,
      units: 2_000_000,
      usage_type: "requests",
      product_name: "CDN",
      product_line: "Network Services",
      product_group: "Full-Site Delivery",
      region: "North America",
    },
    {
      amount: 40,
      units: 10,
      usage_type: "requests",
      product_name: "Compute",
      product_line: "Compute",
      product_group: "Compute",
      region: "",
    },
    { amount: -7.5, product_name: "Promotional credit", credit_coupon_code: "WELCOME" },
    { amount: 0, product_name: "Free tier" },
  ],
};

const MTD = {
  billing_start_date: "2026-10-01T00:00:00Z",
  monthly_transaction_amount: "12.34",
  transaction_line_items: [
    {
      amount: 12.34,
      units: 3,
      usage_type: "bandwidth",
      product_name: "CDN",
      product_line: "Network Services",
      product_group: "Full-Site Delivery",
      region: "Europe",
    },
  ],
};

function billingRoute(url: URL) {
  if (url.pathname === "/billing/v3/invoices/month-to-date") return { body: MTD };
  if (url.pathname === "/billing/v3/invoices") return { body: { data: [SEPT_INVOICE], meta: {} } };
  if (url.pathname === "/billing/v3/usage-metrics") {
    return {
      body: {
        data: [
          { product_id: "compute", name: "Compute Requests", unit: "unit", quantity: 5 },
          { product_id: "cdn_usage", name: "Zero", quantity: 0 },
        ],
      },
    };
  }
  return { status: 404, body: { msg: "not found" } };
}

describe("period helpers", () => {
  it("lists only the month starts inside the range", () => {
    expect(periodStartsInRange({ fromDate: "2026-08-15", toDate: "2026-10-04" })).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(periodStartsInRange({ fromDate: "2026-09-02", toDate: "2026-09-30" })).toEqual([]);
  });

  it("reads the month of an ISO timestamp in UTC", () => {
    expect(monthStartOf("2026-09-01T00:00:00Z")).toBe("2026-09-01");
    expect(monthStartOf("2026-09-01T00:00:00-08:00")).toBe("2026-09-01");
    expect(monthStartOf("2026-09")).toBe("2026-09-01");
    expect(monthStartOf(undefined)).toBe("");
  });

  it("classifies credits, tax and support", () => {
    expect(chargeTypeOf({ amount: -1 })).toBe("credit");
    expect(chargeTypeOf({ amount: 5, credit_coupon_code: "X" })).toBe("credit");
    expect(chargeTypeOf({ amount: 5, product_name: "Sales Tax" })).toBe("tax");
    expect(chargeTypeOf({ amount: 5, product_name: "Gold Support" })).toBe("support");
    expect(chargeTypeOf({ amount: 5, product_name: "CDN" })).toBe("usage");
  });
});

describe("linesToRows", () => {
  it("aggregates by product, region and line, summing units of one unit only", () => {
    const rows = linesToRows(SEPT_INVOICE.transaction_line_items, "2026-09-01", "EUR");
    const cdn = rows.find((r) => r.service === "CDN");
    expect(cdn).toMatchObject({
      date: "2026-09-01",
      region: "North America",
      currency: "EUR",
      amount: 150,
      tags: { productLine: "Network Services", productGroup: "Full-Site Delivery" },
    });
    // bandwidth and requests mixed: no single unit to report
    expect(cdn?.usageAmount).toBeUndefined();
    expect(rows.find((r) => r.service === "Compute")).toMatchObject({
      amount: 40,
      usageAmount: 10,
      usageUnit: "requests",
    });
    expect(rows.find((r) => r.chargeType === "credit")?.amount).toBe(-7.5);
    expect(rows.some((r) => r.service === "Free tier")).toBe(false);
    const total = rows.reduce((s, r) => s + r.amount, 0);
    expect(total).toBeCloseTo(182.5);
  });
});

describe("fetchFastlyCostData", () => {
  it("files closed months from invoices and the current month from the estimate", async () => {
    const { http, calls } = makeHttp(billingRoute);
    const rows = await fetchFastlyCostData(
      ctxWith(http),
      { fromDate: "2026-08-20", toDate: "2026-10-04" },
      NOW,
    );
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-09-01", "2026-10-01"]));
    const oct = rows.filter((r) => r.date === "2026-10-01");
    expect(oct).toHaveLength(1);
    // The estimate has no currency; the latest invoice's is used.
    expect(oct[0]).toMatchObject({ currency: "EUR", amount: 12.34, region: "Europe" });

    const list = calls.find((c) => c.url.pathname === "/billing/v3/invoices");
    expect(list?.url.searchParams.get("billing_start_date")).toBe("2026-09-01");
    expect(list?.url.searchParams.get("billing_end_date")).toBe("2026-10-01");
    expect(calls.every((c) => c.headers["Fastly-Key"] === "test-token")).toBe(true);
  });

  it("returns nothing for a chunk with no month start in it", async () => {
    const { http, calls } = makeHttp(billingRoute);
    const rows = await fetchFastlyCostData(
      ctxWith(http),
      { fromDate: "2026-09-02", toDate: "2026-09-30" },
      NOW,
    );
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("leaves a closed month without a posted invoice alone", async () => {
    const { http } = makeHttp((url) =>
      url.pathname === "/billing/v3/invoices" ? { body: { data: [] } } : billingRoute(url),
    );
    const rows = await fetchFastlyCostData(
      ctxWith(http),
      { fromDate: "2026-09-01", toDate: "2026-09-30" },
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("turns a permission refusal into a setup error", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { msg: "Forbidden" } }));
    await expect(
      fetchFastlyCostData(ctxWith(http), { fromDate: "2026-10-01", toDate: "2026-10-04" }, NOW),
    ).rejects.toBeInstanceOf(CostSetupError);
  });
});

describe("fetchFastlyBillingSummary", () => {
  it("summarises the month to date, invoices and usage", async () => {
    const { http } = makeHttp(billingRoute);
    const summary = await fetchFastlyBillingSummary(ctxWith(http), NOW);
    expect(summary.currency).toBe("EUR");
    expect(summary.monthToDate).toBe(12.34);
    expect(summary.monthToDateByProduct[0]).toMatchObject({ product: "CDN", amount: 12.34 });
    expect(summary.invoices[0]).toMatchObject({ month: "2026-09", total: 182.5 });
    expect(summary.usage).toEqual([
      { productId: "compute", name: "Compute Requests", region: "", unit: "", quantity: 5 },
    ]);
  });
});
