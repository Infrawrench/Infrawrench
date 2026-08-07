import { describe, expect, it } from "vitest";

import { buildCostEstimate, costEstimateDelta } from "../cost.js";

describe("buildCostEstimate", () => {
  it("derives the total from the line items and orders them largest-first", () => {
    const est = buildCostEstimate([
      { label: "Disk", monthlyAmount: 4 },
      { label: "Compute", monthlyAmount: 30.37 },
    ]);
    expect(est?.monthlyAmount).toBe(34.37);
    expect(est?.lineItems.map((l) => l.label)).toEqual(["Compute", "Disk"]);
    expect(est?.currency).toBe("USD");
  });

  it("rounds each line to cents before summing, so the total matches what is shown", () => {
    const est = buildCostEstimate([
      { label: "A", monthlyAmount: 0.005 },
      { label: "B", monthlyAmount: 0.005 },
    ]);
    // Both lines display as $0.01, so the total has to be $0.02 — summing the
    // raw values first would display two 1-cent lines under a 1-cent total.
    expect(est?.lineItems.map((l) => l.monthlyAmount)).toEqual([0.01, 0.01]);
    expect(est?.monthlyAmount).toBe(0.02);
  });

  it("drops unpriced and zero components rather than showing empty rows", () => {
    const est = buildCostEstimate([
      null,
      undefined,
      { label: "Free tier", monthlyAmount: 0 },
      { label: "NaN rate", monthlyAmount: Number.NaN },
      { label: "Compute", monthlyAmount: 5 },
    ]);
    expect(est?.lineItems).toHaveLength(1);
    expect(est?.monthlyAmount).toBe(5);
  });

  it("returns null when nothing could be priced, which is not the same as $0", () => {
    expect(buildCostEstimate([])).toBeNull();
    expect(buildCostEstimate([null, { label: "Free", monthlyAmount: 0 }])).toBeNull();
  });

  it("carries partial and notes only when they say something", () => {
    const bare = buildCostEstimate([{ label: "A", monthlyAmount: 1 }]);
    expect(bare).not.toHaveProperty("partial");
    expect(bare).not.toHaveProperty("notes");

    const flagged = buildCostEstimate([{ label: "A", monthlyAmount: 1 }], {
      partial: true,
      notes: ["Excludes egress."],
      currency: "EUR",
    });
    expect(flagged).toMatchObject({ partial: true, notes: ["Excludes egress."], currency: "EUR" });

    // An explicit `partial: false` is the same as saying nothing.
    expect(
      buildCostEstimate([{ label: "A", monthlyAmount: 1 }], { partial: false }),
    ).not.toHaveProperty("partial");
  });
});

describe("costEstimateDelta", () => {
  const usd = (monthlyAmount: number) => ({
    monthlyAmount,
    currency: "USD",
    lineItems: [{ label: "A", monthlyAmount }],
  });

  it("is the signed monthly difference", () => {
    expect(costEstimateDelta(usd(60), usd(400))).toBe(340);
    expect(costEstimateDelta(usd(400), usd(60))).toBe(-340);
    expect(costEstimateDelta(usd(60), usd(60))).toBe(0);
  });

  it("is null when either side is unpriced — an unknown end makes the delta unknown", () => {
    expect(costEstimateDelta(null, usd(400))).toBeNull();
    expect(costEstimateDelta(usd(60), null)).toBeNull();
    expect(costEstimateDelta(undefined, undefined)).toBeNull();
  });

  it("is null across currencies rather than subtracting unlike units", () => {
    const eur = { monthlyAmount: 400, currency: "EUR", lineItems: [] };
    expect(costEstimateDelta(usd(60), eur)).toBeNull();
  });
});
