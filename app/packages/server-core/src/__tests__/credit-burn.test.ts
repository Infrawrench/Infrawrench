import { describe, expect, it } from "vitest";

import { MIN_BURN_SPAN_DAYS, estimateBurn, estimateRunway, runwayUrgency } from "../credits/burn";

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-01T00:00:00.000Z");

/** Readings one day apart, newest last. */
function series(...remaining: number[]) {
  return remaining.map((value, i) => ({ at: T0 + i * DAY, remaining: value }));
}

describe("estimateBurn", () => {
  it("returns no rate from a single reading", () => {
    // Not 0 — "nothing is being spent" is a claim, and one reading cannot
    // support it.
    expect(estimateBurn(series(100)).perDay).toBeNull();
  });

  it("returns no rate below the minimum span", () => {
    const twoHours = [
      { at: T0, remaining: 100 },
      { at: T0 + 2 * 3_600_000, remaining: 90 },
    ];
    // Extrapolating a busy afternoon would report a runway of days; a quiet
    // night, years. Neither is a rate.
    expect(estimateBurn(twoHours).perDay).toBeNull();
    expect(MIN_BURN_SPAN_DAYS).toBeGreaterThan(0);
  });

  it("averages spend over the observed span", () => {
    const burn = estimateBurn(series(100, 90, 80, 70, 60));
    expect(burn.perDay).toBeCloseTo(10);
    expect(burn.spanDays).toBeCloseTo(4);
    expect(burn.observations).toBe(5);
  });

  it("counts a top-up as a top-up, never as negative burn", () => {
    // 500 → 300 → 900 → 700 burned 400 and gained 600. The naive
    // first-minus-last answer is -200: a negative burn and an infinite
    // runway, which is the most dangerous possible wrong answer.
    const burn = estimateBurn(series(500, 300, 900, 700));
    expect(burn.topUps).toBe(1);
    expect(burn.toppedUpAmount).toBe(600);
    expect(burn.perDay).toBeCloseTo(400 / 3);
  });

  it("reports a zero rate for a genuinely idle pot", () => {
    const burn = estimateBurn(series(100, 100, 100, 100));
    expect(burn.perDay).toBe(0);
  });

  it("tolerates out-of-order and duplicated readings", () => {
    // Two replicas running the pass must not break the panel.
    const out = estimateBurn([
      { at: T0 + 4 * DAY, remaining: 60 },
      { at: T0, remaining: 100 },
      { at: T0 + 4 * DAY, remaining: 60 },
    ]);
    expect(out.perDay).toBeCloseTo(10);
  });
});

describe("estimateRunway", () => {
  const now = T0 + 4 * DAY;
  const steady = estimateBurn(series(100, 90, 80, 70, 60));

  it("divides the balance by the burn", () => {
    const runway = estimateRunway(60, steady, { now });
    expect(runway.days).toBeCloseTo(6);
    expect(runway.limitedByExpiry).toBe(false);
    expect(runway.exhaustedAt).toBe(new Date(now + 6 * DAY).toISOString());
  });

  it("takes the expiry when the credit lapses first", () => {
    // A trial grant that lapses in two days does not have a six-day runway,
    // however slowly it is being spent.
    const runway = estimateRunway(60, steady, {
      now,
      creditExpiresAt: new Date(now + 2 * DAY).toISOString(),
    });
    expect(runway.days).toBeCloseTo(2);
    expect(runway.limitedByExpiry).toBe(true);
  });

  it("keeps the burn when it runs out before the expiry", () => {
    const runway = estimateRunway(60, steady, {
      now,
      creditExpiresAt: new Date(now + 90 * DAY).toISOString(),
    });
    expect(runway.days).toBeCloseTo(6);
    expect(runway.limitedByExpiry).toBe(false);
  });

  it("says never-empties rather than Infinity for an idle pot", () => {
    const idle = estimateBurn(series(100, 100, 100, 100));
    const runway = estimateRunway(100, idle, { now });
    expect(runway.neverEmpties).toBe(true);
    expect(runway.days).toBeNull();
  });

  it("still names an expiry deadline for an idle pot", () => {
    const idle = estimateBurn(series(100, 100, 100, 100));
    const runway = estimateRunway(100, idle, {
      now,
      creditExpiresAt: new Date(now + 5 * DAY).toISOString(),
    });
    expect(runway.days).toBeCloseTo(5);
    expect(runway.limitedByExpiry).toBe(true);
    expect(runway.neverEmpties).toBe(false);
  });

  it("names an expiry deadline even with no measurable burn", () => {
    const unknown = estimateBurn(series(100));
    const runway = estimateRunway(100, unknown, {
      now,
      creditExpiresAt: new Date(now + 9 * DAY).toISOString(),
    });
    expect(runway.days).toBeCloseTo(9);
    expect(runway.limitedByExpiry).toBe(true);
  });

  it("is unknown when there is neither a burn nor an expiry", () => {
    const runway = estimateRunway(100, estimateBurn(series(100)), { now });
    expect(runway.days).toBeNull();
    expect(runway.neverEmpties).toBe(false);
  });

  it("reports an already-empty pot as zero, not as never-empties", () => {
    const runway = estimateRunway(0, steady, { now });
    expect(runway.days).toBe(0);
    expect(runway.neverEmpties).toBe(false);
  });
});

describe("runwayUrgency", () => {
  const now = T0;
  const steady = estimateBurn(series(100, 90, 80, 70, 60));

  it("is critical inside a week", () => {
    expect(runwayUrgency(estimateRunway(50, steady, { now }))).toBe("critical");
  });

  it("is a warning inside a month", () => {
    expect(runwayUrgency(estimateRunway(200, steady, { now }))).toBe("warning");
  });

  it("is ok beyond a month", () => {
    expect(runwayUrgency(estimateRunway(1000, steady, { now }))).toBe("ok");
  });

  it("is ok for a pot nothing is drawing on", () => {
    const idle = estimateBurn(series(100, 100, 100, 100));
    expect(runwayUrgency(estimateRunway(100, idle, { now }))).toBe("ok");
  });

  it("is unknown rather than ok when the burn cannot be measured", () => {
    // Silence must not read as a pass.
    expect(runwayUrgency(estimateRunway(100, estimateBurn(series(100)), { now }))).toBe("unknown");
  });
});
