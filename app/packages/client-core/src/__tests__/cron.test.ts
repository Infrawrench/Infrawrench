import { describe, expect, it } from "vitest";
import {
  isValidCronTimezone,
  nextCronOccurrence,
  nextCronOccurrences,
  parseCronExpression,
  validateCronExpression,
} from "../cron";

/** UTC instant shorthand. */
const utc = (iso: string) => new Date(iso);

const next = (expr: string, fromIso: string, timezone?: string) =>
  nextCronOccurrence(expr, { from: utc(fromIso), ...(timezone ? { timezone } : {}) });

describe("parseCronExpression", () => {
  it("expands *, lists, ranges, and steps", () => {
    const cron = parseCronExpression("*/15 9-17 1,15 * 1-5");
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.daysOfMonth]).toEqual([1, 15]);
    expect(cron.months.size).toBe(12);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(cron.domRestricted).toBe(true);
    expect(cron.dowRestricted).toBe(true);
  });

  it("supports stepped ranges and N/step", () => {
    expect([...parseCronExpression("0 9-17/2 * * *").hours]).toEqual([9, 11, 13, 15, 17]);
    // Vixie extension: 3/7 = every 7th month starting at March.
    expect([...parseCronExpression("0 0 * 3/7 *").months]).toEqual([3, 10]);
  });

  it("accepts month and weekday names, case-insensitively", () => {
    const cron = parseCronExpression("0 9 * JAN,jul Mon-fri");
    expect([...cron.months]).toEqual([1, 7]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the star flag on `*/n` day fields (Vixie dom/dow rule)", () => {
    const cron = parseCronExpression("0 0 1 * */2");
    expect(cron.domRestricted).toBe(true);
    expect(cron.dowRestricted).toBe(false);
  });

  it("folds day-of-week 7 onto Sunday", () => {
    expect([...parseCronExpression("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCronExpression("0 0 * * 5-7").daysOfWeek].sort()).toEqual([0, 5, 6]);
  });

  it.each([
    ["", "5 fields"],
    ["* * * *", "5 fields"],
    ["* * * * * *", "5 fields"],
    ["60 * * * *", "out of range"],
    ["* 24 * * *", "out of range"],
    ["* * 0 * *", "out of range"],
    ["* * 32 * *", "out of range"],
    ["* * * 13 *", "out of range"],
    ["* * * * 8", "out of range"],
    ["*/0 * * * *", "Invalid step"],
    ["*/x * * * *", "Invalid step"],
    ["1//2 * * * *", "Invalid step"],
    ["5-1 * * * *", "reversed"],
    ["1-2-3 * * * *", "Invalid range"],
    ["a * * * *", "Invalid minute"],
    ["0 0 * XYZ *", "Invalid month"],
    ["1,,2 * * * *", "Empty list item"],
  ])("rejects %j", (expr, messagePart) => {
    const error = validateCronExpression(expr);
    expect(error).toContain(messagePart);
    expect(() => parseCronExpression(expr)).toThrow();
  });

  it("validateCronExpression returns null for valid expressions", () => {
    for (const expr of ["* * * * *", "0 9 * * 1", "*/5 * * * *", "0 0 1 * *", "30 4 1,15 * 5"]) {
      expect(validateCronExpression(expr)).toBeNull();
    }
  });
});

describe("nextCronOccurrence (UTC)", () => {
  it("fires every minute", () => {
    expect(next("* * * * *", "2026-07-31T12:00:00Z")).toEqual(utc("2026-07-31T12:01:00Z"));
    // Mid-minute truncates forward to the next whole minute.
    expect(next("* * * * *", "2026-07-31T12:00:30Z")).toEqual(utc("2026-07-31T12:01:00Z"));
  });

  it("is strictly after `from`", () => {
    expect(next("0 12 * * *", "2026-07-31T12:00:00Z")).toEqual(utc("2026-08-01T12:00:00Z"));
  });

  it("handles minute steps", () => {
    expect(next("*/15 * * * *", "2026-07-31T12:07:00Z")).toEqual(utc("2026-07-31T12:15:00Z"));
    expect(next("*/15 * * * *", "2026-07-31T12:45:00Z")).toEqual(utc("2026-07-31T13:00:00Z"));
  });

  it("handles weekly schedules", () => {
    // 2026-07-31 is a Friday; next Monday is Aug 3.
    expect(next("0 9 * * 1", "2026-07-31T00:00:00Z")).toEqual(utc("2026-08-03T09:00:00Z"));
    expect(next("0 9 * * mon", "2026-07-31T00:00:00Z")).toEqual(utc("2026-08-03T09:00:00Z"));
  });

  it("handles monthly schedules and rolls over year end", () => {
    expect(next("0 0 1 * *", "2026-12-15T00:00:00Z")).toEqual(utc("2027-01-01T00:00:00Z"));
  });

  it("skips months without the day", () => {
    // 31st: February, April… are skipped.
    expect(next("0 0 31 * *", "2027-01-31T01:00:00Z")).toEqual(utc("2027-03-31T00:00:00Z"));
    // Feb 29 only exists in leap years: from 2026 → 2028.
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toEqual(utc("2028-02-29T00:00:00Z"));
  });

  it("returns null for schedules that never match", () => {
    expect(next("0 0 30 2 *", "2026-07-31T00:00:00Z")).toBeNull();
  });

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // "the 13th or any Friday": from Wed 2026-08-05, the next Friday (Aug 7)
    // comes before the 13th.
    expect(next("0 0 13 * 5", "2026-08-05T00:00:00Z")).toEqual(utc("2026-08-07T00:00:00Z"));
    // …and from Sat Aug 8 the 13th (a Thursday) comes before the next Friday.
    expect(next("0 0 13 * 5", "2026-08-08T00:00:00Z")).toEqual(utc("2026-08-13T00:00:00Z"));
  });

  it("ANDs day-of-month with day-of-week when only one is restricted", () => {
    expect(next("0 0 * * 0", "2026-08-01T00:00:00Z")).toEqual(utc("2026-08-02T00:00:00Z"));
    expect(next("0 0 15 * *", "2026-08-01T00:00:00Z")).toEqual(utc("2026-08-15T00:00:00Z"));
  });

  it("throws on bad input", () => {
    expect(() => next("not a cron", "2026-01-01T00:00:00Z")).toThrow();
    expect(() => next("* * * * *", "2026-01-01T00:00:00Z", "Not/AZone")).toThrow("timezone");
  });
});

describe("nextCronOccurrence (timezones)", () => {
  it("evaluates wall times in the given zone", () => {
    // 09:00 in New York during EDT (UTC-4) is 13:00 UTC.
    expect(next("0 9 * * *", "2026-07-31T00:00:00Z", "America/New_York")).toEqual(
      utc("2026-07-31T13:00:00Z"),
    );
    // …and during EST (UTC-5) it's 14:00 UTC.
    expect(next("0 9 * * *", "2026-01-15T00:00:00Z", "America/New_York")).toEqual(
      utc("2026-01-15T14:00:00Z"),
    );
  });

  it("skips wall times that fall in the spring-forward gap", () => {
    // 2026-03-08 02:30 never happens in New York (02:00 jumps to 03:00);
    // the next 02:30 is on March 9 (EDT, UTC-4).
    expect(next("30 2 * * *", "2026-03-08T00:00:00Z", "America/New_York")).toEqual(
      utc("2026-03-09T06:30:00Z"),
    );
  });

  it("uses the earlier instant of a fall-back repeated wall time", () => {
    // 2026-11-01 01:30 happens twice in New York; cron fires the first
    // (EDT, UTC-4 → 05:30 UTC), not the second (EST, 06:30 UTC).
    expect(next("30 1 * * *", "2026-11-01T00:00:00Z", "America/New_York")).toEqual(
      utc("2026-11-01T05:30:00Z"),
    );
  });

  it("handles zones ahead of UTC across the date line", () => {
    // 09:00 Monday in Tokyo (UTC+9) is Sunday 24:00 UTC.
    expect(next("0 9 * * 1", "2026-07-31T00:00:00Z", "Asia/Tokyo")).toEqual(
      utc("2026-08-03T00:00:00Z"),
    );
  });
});

describe("nextCronOccurrences", () => {
  it("returns consecutive occurrences", () => {
    expect(nextCronOccurrences("*/30 * * * *", 3, { from: utc("2026-07-31T12:00:00Z") })).toEqual([
      utc("2026-07-31T12:30:00Z"),
      utc("2026-07-31T13:00:00Z"),
      utc("2026-07-31T13:30:00Z"),
    ]);
  });

  it("stops early when the schedule runs out", () => {
    expect(nextCronOccurrences("0 0 30 2 *", 3, { from: utc("2026-07-31T12:00:00Z") })).toEqual([]);
  });
});

describe("isValidCronTimezone", () => {
  it("accepts IANA zones and UTC, rejects junk", () => {
    expect(isValidCronTimezone("UTC")).toBe(true);
    expect(isValidCronTimezone("Europe/London")).toBe(true);
    expect(isValidCronTimezone("America/New_York")).toBe(true);
    expect(isValidCronTimezone("Not/AZone")).toBe(false);
    expect(isValidCronTimezone("")).toBe(false);
  });
});
