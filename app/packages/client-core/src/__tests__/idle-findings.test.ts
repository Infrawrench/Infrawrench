import { describe, expect, it } from "vitest";
import { IDLE_LOOKBACK_LIMITS } from "@infrawrench/plugin-base";

import {
  DEFAULT_IDLE_FINDING_SETTINGS,
  describeIdleEvidence,
  formatIdleValue,
  IDLE_FINDING_LIMITS,
  orphanMonthlyFigure,
} from "../idle-findings";

describe("idle finding limits", () => {
  it("mirror plugin-base's lookback bounds", () => {
    expect(IDLE_FINDING_LIMITS.minLookbackDays).toBe(IDLE_LOOKBACK_LIMITS.min);
    expect(IDLE_FINDING_LIMITS.maxLookbackDays).toBe(IDLE_LOOKBACK_LIMITS.max);
    expect(DEFAULT_IDLE_FINDING_SETTINGS.lookbackDays).toBe(IDLE_LOOKBACK_LIMITS.default);
  });
});

describe("formatIdleValue", () => {
  it("formats bytes with decimal units", () => {
    expect(formatIdleValue(0, "bytes")).toBe("0 B");
    expect(formatIdleValue(999, "bytes")).toBe("999 B");
    expect(formatIdleValue(1_500_000, "bytes")).toBe("1.5 MB");
    expect(formatIdleValue(250_000_000_000, "bytes")).toBe("250 GB");
  });

  it("keeps small percentages visible and groups large counts", () => {
    expect(formatIdleValue(0.4, "percent")).toBe("0.4%");
    expect(formatIdleValue(12_345, "count")).toBe("12,345");
    expect(formatIdleValue(3, "count")).toBe("3");
    expect(formatIdleValue(14, "days")).toBe("14 d");
  });

  it("says no data rather than zero", () => {
    expect(formatIdleValue(null, "bytes")).toBe("no data");
  });
});

describe("describeIdleEvidence", () => {
  it("names the metric, statistic, value and threshold", () => {
    expect(
      describeIdleEvidence({
        metric: "BytesOutToDestination",
        label: "Bytes sent to the internet",
        statistic: "sum",
        value: 0,
        unit: "bytes",
        threshold: 1_000_000,
        comparison: "atMost",
      }),
    ).toBe("Bytes sent to the internet (BytesOutToDestination, sum): 0 B, flags at ≤ 1.0 MB");
  });

  it("omits the threshold for context-only evidence", () => {
    expect(
      describeIdleEvidence({
        metric: "ProvisionedReadCapacityUnits",
        label: "Provisioned reads",
        statistic: "average",
        value: 25,
        unit: "count",
      }),
    ).toBe("Provisioned reads (ProvisionedReadCapacityUnits, average): 25");
  });
});

describe("orphanMonthlyFigure", () => {
  it("prefers billed spend scaled to 30 days", () => {
    expect(
      orphanMonthlyFigure(
        {
          cost: { amount: 15, currency: "USD" },
          estimate: { monthlyAmount: 40, currency: "USD", basis: "list-price" },
        },
        15,
      ),
    ).toEqual({ amount: 30, currency: "USD", basis: "billing" });
  });

  it("falls back to the list-price estimate, then to null", () => {
    expect(
      orphanMonthlyFigure(
        { cost: null, estimate: { monthlyAmount: 32.85, currency: "USD", basis: "list-price" } },
        30,
      ),
    ).toEqual({ amount: 32.85, currency: "USD", basis: "list-price" });
    expect(orphanMonthlyFigure({ cost: null }, 30)).toBeNull();
  });
});
