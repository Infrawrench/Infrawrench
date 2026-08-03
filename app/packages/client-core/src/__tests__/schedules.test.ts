import { describe, expect, it } from "vitest";

import {
  AVERAGE_DAYS_PER_MONTH,
  computeMostRecentTransition,
  computeNextTransition,
  computeUpcomingTransitions,
  formatDaysOfWeek,
  hoursOffPerWeek,
  projectedMonthlySaving,
  timeOfDayMinutes,
  transitionKey,
  validateScheduleTiming,
  wallTimeToUtc,
  weeklyOffFraction,
  type SleepScheduleTiming,
} from "../schedules";

/** Mon–Fri office hours: on at 08:00, off at 19:00, London time. */
const officeHours: SleepScheduleTiming = {
  daysOfWeek: [1, 2, 3, 4, 5],
  stopTime: "19:00",
  startTime: "08:00",
  timezone: "Europe/London",
};

describe("validateScheduleTiming", () => {
  it("accepts the canonical office-hours window", () => {
    expect(validateScheduleTiming(officeHours)).toBeNull();
  });

  it("rejects empty day sets, bad days, dupes, bad times and equal times", () => {
    expect(validateScheduleTiming({ ...officeHours, daysOfWeek: [] })).toMatch(/at least one day/);
    expect(validateScheduleTiming({ ...officeHours, daysOfWeek: [0] })).toMatch(/ISO weekdays/);
    expect(validateScheduleTiming({ ...officeHours, daysOfWeek: [8] })).toMatch(/ISO weekdays/);
    expect(validateScheduleTiming({ ...officeHours, daysOfWeek: [1, 1] })).toMatch(/only once/);
    expect(validateScheduleTiming({ ...officeHours, stopTime: "24:00" })).toMatch(/Off time/);
    expect(validateScheduleTiming({ ...officeHours, startTime: "8:00" })).toMatch(/On time/);
    expect(
      validateScheduleTiming({ ...officeHours, stopTime: "08:00", startTime: "08:00" }),
    ).toMatch(/must differ/);
    expect(validateScheduleTiming({ ...officeHours, timezone: "Not/AZone" })).toMatch(
      /Unknown timezone/,
    );
  });
});

describe("wallTimeToUtc", () => {
  it("maps a summer London wall time to UTC-1h", () => {
    // 2026-08-03 is BST (UTC+1): 19:00 London = 18:00 UTC.
    expect(wallTimeToUtc("Europe/London", 2026, 8, 3, 19, 0)).toBe(
      Date.parse("2026-08-03T18:00:00.000Z"),
    );
  });

  it("maps a winter London wall time to UTC exactly", () => {
    expect(wallTimeToUtc("Europe/London", 2026, 1, 5, 19, 0)).toBe(
      Date.parse("2026-01-05T19:00:00.000Z"),
    );
  });

  it("is DST-correct across the spring-forward boundary in New York", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT. 08:00 that day is EDT (UTC-4).
    expect(wallTimeToUtc("America/New_York", 2026, 3, 8, 8, 0)).toBe(
      Date.parse("2026-03-08T12:00:00.000Z"),
    );
    // The day before is still EST (UTC-5).
    expect(wallTimeToUtc("America/New_York", 2026, 3, 7, 8, 0)).toBe(
      Date.parse("2026-03-07T13:00:00.000Z"),
    );
  });

  it("resolves a spring-forward-skipped time to a real instant", () => {
    // 02:30 on 2026-03-08 does not exist in New York; it must still resolve
    // to a nearby instant so the transition fires once rather than never.
    const resolved = wallTimeToUtc("America/New_York", 2026, 3, 8, 2, 30);
    expect(resolved).toBeGreaterThanOrEqual(Date.parse("2026-03-08T06:30:00.000Z"));
    expect(resolved).toBeLessThanOrEqual(Date.parse("2026-03-08T07:30:00.000Z"));
  });
});

describe("computeUpcomingTransitions", () => {
  it("orders stop tonight before start tomorrow, mid-week", () => {
    // Monday 2026-08-03 12:00 London.
    const now = Date.parse("2026-08-03T11:00:00.000Z");
    const next = computeUpcomingTransitions(officeHours, { now, count: 4 });
    expect(next.map((t) => t.action)).toEqual(["stop", "start", "stop", "start"]);
    expect(next[0]).toEqual({ at: "2026-08-03T18:00:00.000Z", action: "stop" });
    expect(next[1]).toEqual({ at: "2026-08-04T07:00:00.000Z", action: "start" });
  });

  it("skips the weekend: Friday stop is followed by Monday start", () => {
    // Friday 2026-08-07 20:00 London (after the stop already fired).
    const now = Date.parse("2026-08-07T19:30:00.000Z");
    const next = computeUpcomingTransitions(officeHours, { now, count: 2 });
    expect(next[0]).toEqual({ at: "2026-08-10T07:00:00.000Z", action: "start" });
    expect(next[1]).toEqual({ at: "2026-08-10T18:00:00.000Z", action: "stop" });
  });

  it("covers a one-day-a-week schedule", () => {
    const sundayOnly: SleepScheduleTiming = { ...officeHours, daysOfWeek: [7] };
    const now = Date.parse("2026-08-03T11:00:00.000Z"); // Monday
    const next = computeUpcomingTransitions(sundayOnly, { now, count: 2 });
    expect(next[0]).toEqual({ at: "2026-08-09T07:00:00.000Z", action: "start" });
    expect(next[1]).toEqual({ at: "2026-08-09T18:00:00.000Z", action: "stop" });
  });

  it("returns [] for invalid timing rather than guessing", () => {
    expect(computeUpcomingTransitions({ ...officeHours, daysOfWeek: [] })).toEqual([]);
  });

  it("computes transitions in the schedule's zone, not the host's", () => {
    const tokyo: SleepScheduleTiming = { ...officeHours, timezone: "Asia/Tokyo" };
    const now = Date.parse("2026-08-03T00:00:00.000Z"); // Monday 09:00 Tokyo
    const next = computeNextTransition(tokyo, now);
    // Monday 19:00 Tokyo = 10:00 UTC.
    expect(next).toEqual({ at: "2026-08-03T10:00:00.000Z", action: "stop" });
  });
});

describe("computeMostRecentTransition + transitionKey", () => {
  it("finds the transition that just became due", () => {
    // Monday 19:05 London — the 19:00 stop is due.
    const now = Date.parse("2026-08-03T18:05:00.000Z");
    const due = computeMostRecentTransition(officeHours, now);
    expect(due).toEqual({ at: "2026-08-03T18:00:00.000Z", action: "stop" });
    expect(transitionKey(due!)).toBe("2026-08-03T18:00:00.000Z:stop");
  });

  it("returns only the latest missed transition after downtime over a weekend", () => {
    // Sunday: the latest transition is Friday's 19:00 stop, not Friday's start.
    const now = Date.parse("2026-08-09T12:00:00.000Z");
    expect(computeMostRecentTransition(officeHours, now)).toEqual({
      at: "2026-08-07T18:00:00.000Z",
      action: "stop",
    });
  });

  it("agrees with computeUpcomingTransitions at the boundary", () => {
    const at = Date.parse("2026-08-03T18:00:00.000Z");
    // At the exact instant, the transition is due (most-recent), not upcoming.
    expect(computeMostRecentTransition(officeHours, at)?.at).toBe("2026-08-03T18:00:00.000Z");
    expect(computeUpcomingTransitions(officeHours, { now: at, count: 1 })[0]?.at).toBe(
      "2026-08-04T07:00:00.000Z",
    );
  });
});

describe("weeklyOffFraction", () => {
  it("computes the office-hours fraction: off nights + weekends", () => {
    // On 08:00–19:00 Mon–Fri = 55h on per week → 113h off.
    expect(weeklyOffFraction(officeHours)).toBeCloseTo(113 / 168, 10);
    expect(hoursOffPerWeek(officeHours)).toBeCloseTo(113, 10);
  });

  it("handles every-day schedules", () => {
    const daily: SleepScheduleTiming = { ...officeHours, daysOfWeek: [1, 2, 3, 4, 5, 6, 7] };
    // Off 13h per day.
    expect(weeklyOffFraction(daily)).toBeCloseTo((13 * 7) / 168, 10);
  });

  it("handles an overnight on-window (start > stop)", () => {
    // On 20:00 → off 06:00 next morning, every day: on 10h/day → off 14h/day.
    const nightly: SleepScheduleTiming = {
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      stopTime: "06:00",
      startTime: "20:00",
      timezone: "UTC",
    };
    expect(weeklyOffFraction(nightly)).toBeCloseTo((14 * 7) / 168, 10);
  });

  it("returns 0 for invalid timing", () => {
    expect(weeklyOffFraction({ ...officeHours, daysOfWeek: [] })).toBe(0);
  });
});

describe("projectedMonthlySaving", () => {
  it("normalizes a trailing window to a month and applies the fraction", () => {
    const saving = projectedMonthlySaving(60, 30, 0.5);
    expect(saving).toBeCloseTo((60 / 30) * AVERAGE_DAYS_PER_MONTH * 0.5, 10);
  });

  it("quotes nothing when there is no billing data", () => {
    expect(projectedMonthlySaving(null, 30, 0.5)).toBeNull();
    expect(projectedMonthlySaving(10, 0, 0.5)).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("formats day sets", () => {
    expect(formatDaysOfWeek([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(formatDaysOfWeek([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(formatDaysOfWeek([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatDaysOfWeek([6, 7])).toBe("Sat–Sun");
    expect(formatDaysOfWeek([2])).toBe("Tue");
    expect(formatDaysOfWeek([])).toBe("No days");
  });

  it("parses times of day", () => {
    expect(timeOfDayMinutes("19:00")).toBe(1140);
    expect(timeOfDayMinutes("08:05")).toBe(485);
  });
});
