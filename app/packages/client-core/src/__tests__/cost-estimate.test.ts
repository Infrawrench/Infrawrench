import { describe, expect, it } from "vitest";

import {
  describeMonthlyDelta,
  formatMonthlyDelta,
  formatMonthlyEstimate,
  partialEstimatePrefix,
} from "../cost-estimate";

describe("formatMonthlyEstimate", () => {
  it("shows cents when there are any and drops them when there are none", () => {
    expect(formatMonthlyEstimate(30.37)).toBe("$30.37");
    expect(formatMonthlyEstimate(12)).toBe("$12");
  });

  it("keeps cents above $10, unlike the reported-spend formatter", () => {
    // A create form's estimate has to move visibly when a disk slider adds
    // $0.37/month; rounding to whole dollars would make that look like a
    // no-op. This is the reason this module doesn't reuse `formatMoney`.
    expect(formatMonthlyEstimate(1109.6)).toBe("$1,109.60");
  });

  it("honours a non-USD currency and survives a bogus one", () => {
    expect(formatMonthlyEstimate(12, "EUR")).toBe("€12");
    expect(formatMonthlyEstimate(12.5, "not-a-currency")).toBe("12.50");
  });
});

describe("formatMonthlyDelta", () => {
  it("signs the change and uses a real minus sign so columns align", () => {
    expect(formatMonthlyDelta(340)).toBe("+$340");
    expect(formatMonthlyDelta(-12.5)).toBe("−$12.50");
    expect(formatMonthlyDelta(0)).toBe("no change");
  });
});

describe("describeMonthlyDelta", () => {
  it("says adds or saves, in the user's own words", () => {
    expect(describeMonthlyDelta(340)).toBe("This change adds $340/month");
    expect(describeMonthlyDelta(-12.5)).toBe("This change saves $12.50/month");
  });

  it("says nothing when there is nothing to say", () => {
    expect(describeMonthlyDelta(null)).toBeNull();
    expect(describeMonthlyDelta(0)).toBeNull();
    // Sub-cent noise from a rate multiplication is not a change worth a line.
    expect(describeMonthlyDelta(0.004)).toBeNull();
  });
});

describe("partialEstimatePrefix", () => {
  it("qualifies a floor and leaves a complete estimate alone", () => {
    expect(partialEstimatePrefix({ monthlyAmount: 5, currency: "USD", lineItems: [] })).toBeNull();
    expect(
      partialEstimatePrefix({ monthlyAmount: 5, currency: "USD", lineItems: [], partial: true }),
    ).toBe("at least");
    expect(partialEstimatePrefix(null)).toBeNull();
  });
});
