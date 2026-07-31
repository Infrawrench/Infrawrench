import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../db/schema", () => ({ orgCostAnomalySettings: {} }));

const { anomalyOptionsFor, normalizeAnomalySettings, DEFAULT_COST_ANOMALY_SETTINGS } =
  await import("../cost/anomaly-settings");

describe("normalizeAnomalySettings", () => {
  it("passes sane values through untouched", () => {
    const input = { sigmas: 2.5, minDeltaCents: 500, newSourceMinCents: 10_000 };
    expect(normalizeAnomalySettings(input)).toEqual(input);
  });

  it("clamps a sigma of 0 — every fluctuation would alert", () => {
    expect(normalizeAnomalySettings({ ...DEFAULT_COST_ANOMALY_SETTINGS, sigmas: 0 }).sigmas).toBe(
      1,
    );
  });

  it("clamps negative and absurd floors", () => {
    const safe = normalizeAnomalySettings({
      sigmas: 99,
      minDeltaCents: -5000,
      newSourceMinCents: 999_999_999,
    });
    expect(safe.sigmas).toBe(10);
    expect(safe.minDeltaCents).toBe(100);
    expect(safe.newSourceMinCents).toBe(10_000_000);
  });

  it("falls back to the defaults for non-finite values", () => {
    const safe = normalizeAnomalySettings({
      sigmas: Number.NaN,
      minDeltaCents: Number.POSITIVE_INFINITY,
      newSourceMinCents: Number.NaN,
    });
    expect(safe).toEqual(DEFAULT_COST_ANOMALY_SETTINGS);
  });
});

describe("anomalyOptionsFor", () => {
  it("converts stored cents into the detector's currency units", () => {
    const opts = anomalyOptionsFor({
      sigmas: 2,
      minDeltaCents: 2500,
      newSourceMinCents: 100_000,
    });
    expect(opts.sigmas).toBe(2);
    expect(opts.minDeltaAbs).toBe(25);
    expect(opts.minNewSourceAbs).toBe(1000);
  });

  it("keeps the baseline-day guard fixed — it is not a user knob", () => {
    expect(anomalyOptionsFor(DEFAULT_COST_ANOMALY_SETTINGS).minBaselineDays).toBe(7);
  });

  it("never produces a detector that alerts on everything", () => {
    const opts = anomalyOptionsFor({ sigmas: 0, minDeltaCents: 0, newSourceMinCents: -1 });
    expect(opts.sigmas).toBeGreaterThanOrEqual(1);
    expect(opts.minDeltaAbs).toBeGreaterThan(0);
    expect(opts.minNewSourceAbs).toBeGreaterThan(0);
  });
});
