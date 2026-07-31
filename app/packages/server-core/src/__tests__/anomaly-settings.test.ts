import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../db/schema", () => ({ orgCostAnomalySettings: {} }));

const { anomalyOptionsFor, normalizeAnomalySettings, smsWantsKind, DEFAULT_COST_ANOMALY_SETTINGS } =
  await import("../cost/anomaly-settings");

describe("normalizeAnomalySettings", () => {
  it("passes sane values through untouched", () => {
    const input = {
      sigmas: 2.5,
      minDeltaCents: 500,
      newSourceMinCents: 10_000,
      smsAlerts: "all",
    } as const;
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
      smsAlerts: "off",
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
      smsAlerts: "off",
    });
    expect(safe).toEqual(DEFAULT_COST_ANOMALY_SETTINGS);
  });
});

describe("normalizeAnomalySettings — the SMS opt-in", () => {
  it("fails closed on a value it does not recognise", () => {
    // A row written by a newer deployment, or by hand. This is the one setting
    // that spends money and wakes people, so anything unknown reads as off.
    const safe = normalizeAnomalySettings({
      ...DEFAULT_COST_ANOMALY_SETTINGS,
      smsAlerts: "everything" as never,
    });
    expect(safe.smsAlerts).toBe("off");
  });

  it("defaults to off, so an existing Twilio setup gains no new pager", () => {
    expect(DEFAULT_COST_ANOMALY_SETTINGS.smsAlerts).toBe("off");
  });

  it("keeps a deliberate opt-in", () => {
    expect(
      normalizeAnomalySettings({ ...DEFAULT_COST_ANOMALY_SETTINGS, smsAlerts: "new_source" })
        .smsAlerts,
    ).toBe("new_source");
  });
});

describe("smsWantsKind", () => {
  it("says no to everything when off", () => {
    expect(smsWantsKind("off", "spike")).toBe(false);
    expect(smsWantsKind("off", "new_source")).toBe(false);
  });

  it("nests: new_source is a subset of all", () => {
    expect(smsWantsKind("new_source", "new_source")).toBe(true);
    expect(smsWantsKind("new_source", "spike")).toBe(false);
    expect(smsWantsKind("all", "spike")).toBe(true);
    expect(smsWantsKind("all", "new_source")).toBe(true);
  });
});

describe("anomalyOptionsFor", () => {
  it("converts stored cents into the detector's currency units", () => {
    const opts = anomalyOptionsFor({
      sigmas: 2,
      minDeltaCents: 2500,
      newSourceMinCents: 100_000,
      smsAlerts: "off",
    });
    expect(opts.sigmas).toBe(2);
    expect(opts.minDeltaAbs).toBe(25);
    expect(opts.minNewSourceAbs).toBe(1000);
  });

  it("keeps the baseline-day guard fixed — it is not a user knob", () => {
    expect(anomalyOptionsFor(DEFAULT_COST_ANOMALY_SETTINGS).minBaselineDays).toBe(7);
  });

  it("never produces a detector that alerts on everything", () => {
    const opts = anomalyOptionsFor({
      sigmas: 0,
      minDeltaCents: 0,
      newSourceMinCents: -1,
      smsAlerts: "off",
    });
    expect(opts.sigmas).toBeGreaterThanOrEqual(1);
    expect(opts.minDeltaAbs).toBeGreaterThan(0);
    expect(opts.minNewSourceAbs).toBeGreaterThan(0);
  });
});
