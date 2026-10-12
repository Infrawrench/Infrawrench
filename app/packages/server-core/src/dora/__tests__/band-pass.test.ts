import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));

import { DORA_BAND_WINDOW_DAYS, doraBandChangeTitle, doraBandWindows } from "../band-pass";

describe("doraBandWindows", () => {
  it("compares two UTC-day-aligned 30-day windows a day apart", () => {
    const w = doraBandWindows(new Date("2026-10-12T17:45:00Z"));
    expect(w.current.from.toISOString()).toBe("2026-09-12T00:00:00.000Z");
    expect(w.current.to.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(w.previous.from.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(w.previous.to.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(w.date).toBe("2026-10-12");
    expect(w.windowStart).toBe("2026-09-12");
    expect(w.windowEnd).toBe("2026-10-11");
    const days = (w.current.to.getTime() - w.current.from.getTime()) / 86_400_000;
    expect(days).toBe(DORA_BAND_WINDOW_DAYS);
  });

  it("gives every run on the same day the same comparison", () => {
    // What makes the per-day idempotency key safe across replicas and restarts.
    const early = doraBandWindows(new Date("2026-10-12T00:00:01Z"));
    const late = doraBandWindows(new Date("2026-10-12T23:59:59Z"));
    expect(late).toEqual(early);
  });
});

describe("doraBandChangeTitle", () => {
  it("formats the value in the metric's own unit", () => {
    const base = { previousValue: 0, sample: 4 } as const;
    expect(
      doraBandChangeTitle({
        ...base,
        metric: "lead_time",
        previousBand: "high",
        band: "elite",
        direction: "improved",
        value: 6.5,
      }),
    ).toBe("Lead time for changes improved from high to elite (6.5h)");
    expect(
      doraBandChangeTitle({
        ...base,
        metric: "change_failure_rate",
        previousBand: "elite",
        band: "medium",
        direction: "worsened",
        value: 0.125,
      }),
    ).toBe("Change failure rate worsened from elite to medium (12.5%)");
    expect(
      doraBandChangeTitle({
        ...base,
        metric: "deployment_frequency",
        previousBand: "high",
        band: "elite",
        direction: "improved",
        value: 2,
      }),
    ).toBe("Deployment frequency improved from high to elite (2/day)");
  });
});
