import { describe, expect, it } from "vitest";
import {
  formatPriceChangeHourly,
  formatPriceChangePercent,
  formatPriceChangeUsd,
  priceChangeCrossesThreshold,
  priceChangeKey,
  priceChangeMonthlyImpact,
  priceChangePercent,
  priceChangePlatformLabel,
  priceChangeSentence,
  priceChangeSettingsError,
  priceChangeVariantLabel,
  sortPriceChanges,
} from "../price-changes";

describe("priceChangeKey", () => {
  it("is the same for the same variant however the selection is ordered", () => {
    const base = {
      platform: "ec2",
      instanceType: "m5.large",
      region: "us-east-1",
      effectiveAt: new Date("2026-11-01T00:00:00Z"),
    };
    expect(
      priceChangeKey({ ...base, selection: { tenancy: "Shared", operating_system: "Linux" } }),
    ).toBe(
      priceChangeKey({
        ...base,
        selection: { operating_system: "Linux", tenancy: "Shared" },
        effectiveAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    expect(priceChangeKey({ ...base, selection: { operating_system: "Windows" } })).not.toBe(
      priceChangeKey({ ...base, selection: { operating_system: "Linux" } }),
    );
  });
});

describe("figures", () => {
  it("states a month at 730 hours per unit", () => {
    expect(priceChangeMonthlyImpact(0.096, 0.105, 6)).toBeCloseTo(39.42, 2);
    expect(priceChangeMonthlyImpact(0.105, 0.096, 1)).toBeCloseTo(-6.57, 2);
    expect(priceChangePercent(0.1, 0.11)).toBeCloseTo(10, 6);
    expect(priceChangePercent(0, 1)).toBe(0);
  });

  it("needs both thresholds, in either direction", () => {
    const settings = { minMonthlyImpactCents: 1000, minPercent: 1 };
    expect(priceChangeCrossesThreshold({ monthlyImpactUsd: 10, percent: 1 }, settings)).toBe(true);
    expect(priceChangeCrossesThreshold({ monthlyImpactUsd: -10, percent: -5 }, settings)).toBe(
      true,
    );
    expect(priceChangeCrossesThreshold({ monthlyImpactUsd: 9.99, percent: 50 }, settings)).toBe(
      false,
    );
    expect(priceChangeCrossesThreshold({ monthlyImpactUsd: 500, percent: 0.5 }, settings)).toBe(
      false,
    );
  });

  it("formats money, hourly prices and percentages", () => {
    expect(formatPriceChangeUsd(39.42, { signed: true })).toBe("+$39.42");
    expect(formatPriceChangeUsd(-1234.5, { signed: true })).toBe("-$1,234.50");
    expect(formatPriceChangeUsd(-3)).toBe("-$3.00");
    expect(formatPriceChangeHourly(0.096)).toBe("$0.096/hr");
    expect(formatPriceChangeHourly(12.5)).toBe("$12.5/hr");
    expect(formatPriceChangePercent(9.375)).toBe("+9.4%");
    expect(formatPriceChangePercent(-3)).toBe("-3%");
  });
});

describe("words", () => {
  it("names a platform, falling back to its code", () => {
    expect(priceChangePlatformLabel("ec2")).toBe("Amazon EC2");
    expect(priceChangePlatformLabel("newcloud")).toBe("newcloud");
  });

  it("names the variant from the keys that tell variants apart", () => {
    expect(
      priceChangeVariantLabel({
        deployment_option: "Multi-AZ",
        database_engine: "PostgreSQL",
        tenancy: "Shared",
      }),
    ).toBe("PostgreSQL, Multi-AZ");
    expect(priceChangeVariantLabel({})).toBe("");
  });

  it("writes the one-line summary the alert and the digest use", () => {
    expect(
      priceChangeSentence({
        platform: "ec2",
        instanceType: "m5.large",
        region: "us-east-1",
        oldHourlyUsd: 0.096,
        newHourlyUsd: 0.105,
        effectiveAt: "2026-12-01T00:00:00.000Z",
        upcoming: true,
        monthlyImpactUsd: 39.42,
        units: 6,
        approximate: false,
      }),
    ).toBe(
      "m5.large in us-east-1 (Amazon EC2) goes from $0.096/hr to $0.105/hr on 2026-12-01, +$39.42/mo for your 6 instances",
    );
    expect(
      priceChangeSentence({
        platform: "runpod",
        instanceType: "NVIDIA H100",
        region: "global",
        oldHourlyUsd: 2.99,
        newHourlyUsd: 2.69,
        effectiveAt: "2026-11-01T00:00:00.000Z",
        upcoming: false,
        monthlyImpactUsd: -219,
        units: 1,
        approximate: true,
      }),
    ).toBe(
      "NVIDIA H100 (RunPod) went from $2.99/hr to $2.69/hr on 2026-11-01, -$219.00/mo for at least 1 instance you run",
    );
  });

  it("sorts by the size of the impact, then the newest", () => {
    const sorted = sortPriceChanges([
      { monthlyImpactUsd: 5, effectiveAt: "2026-11-02" },
      { monthlyImpactUsd: -50, effectiveAt: "2026-11-01" },
      { monthlyImpactUsd: 5, effectiveAt: "2026-11-03" },
    ]);
    expect(sorted.map((c) => c.effectiveAt)).toEqual(["2026-11-01", "2026-11-03", "2026-11-02"]);
  });
});

describe("priceChangeSettingsError", () => {
  it("accepts in-range values and refuses the rest", () => {
    expect(priceChangeSettingsError({ minMonthlyImpactCents: 0, minPercent: 100 })).toBeNull();
    expect(priceChangeSettingsError({ minMonthlyImpactCents: 1.5 })).toMatch(/whole number/);
    expect(priceChangeSettingsError({ minMonthlyImpactCents: -1 })).toMatch(/from 0/);
    expect(priceChangeSettingsError({ minPercent: 101 })).toMatch(/from 0 to 100/);
  });
});
