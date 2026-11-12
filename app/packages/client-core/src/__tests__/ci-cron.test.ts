import { describe, expect, it } from "vitest";
import { ciCronDue, nextCiCronDue, parseCiCron } from "../ci-cron";

// The same cases as `iwci-spec/src/cron.rs`, so the two matchers agree.
const at = (iso: string) => new Date(`${iso}:00Z`);

describe("ci cron", () => {
  it("matches fields, steps, ranges, names and shortcuts", () => {
    expect(parseCiCron("0 3 * * *").matches(at("2026-11-08T03:00"))).toBe(true);
    expect(parseCiCron("0 3 * * *").matches(at("2026-11-08T03:01"))).toBe(false);
    const work = parseCiCron("*/15 9-17 * * mon-fri");
    expect(work.matches(at("2026-11-09T09:45"))).toBe(true);
    expect(work.matches(at("2026-11-08T09:45"))).toBe(false);
    expect(work.matches(at("2026-11-09T18:00"))).toBe(false);
    const offset = parseCiCron("5/20 * * * *");
    expect(offset.matches(at("2026-11-09T10:45"))).toBe(true);
    expect(offset.matches(at("2026-11-09T10:50"))).toBe(false);
    const named = parseCiCron("0 0 1,15 jan,JUL *");
    expect(named.matches(at("2026-07-15T00:00"))).toBe(true);
    expect(named.matches(at("2026-08-15T00:00"))).toBe(false);
    expect(parseCiCron("0 0 * * 7").matches(at("2026-11-08T00:00"))).toBe(true);
    expect(parseCiCron("@daily").matches(at("2026-11-08T00:00"))).toBe(true);
    expect(parseCiCron("@weekly").matches(at("2026-11-08T00:00"))).toBe(true);
    expect(parseCiCron("@monthly").matches(at("2026-11-08T00:00"))).toBe(false);
  });

  it("ORs day of month and day of week when both are set", () => {
    const c = parseCiCron("0 0 13 * fri");
    expect(c.matches(at("2026-11-13T00:00"))).toBe(true);
    expect(c.matches(at("2026-11-06T00:00"))).toBe(true);
    expect(c.matches(at("2026-12-13T00:00"))).toBe(true);
    expect(c.matches(at("2026-11-07T00:00"))).toBe(false);
  });

  it("refuses what the runner would refuse, and never fires an unreadable one", () => {
    for (const bad of [
      "0 3 * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "x * * * *",
    ]) {
      expect(() => parseCiCron(bad), bad).toThrow();
    }
    expect(ciCronDue(["nonsense", "0 3 * * *"], at("2026-11-08T03:00"))).toBe(true);
    expect(ciCronDue(["nonsense"], at("2026-11-08T03:00"))).toBe(false);
  });

  it("finds the next minute an expression fires on", () => {
    const after = at("2026-11-08T03:00");
    expect(parseCiCron("0 3 * * *").next(after)?.toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(parseCiCron("*/15 * * * *").next(at("2026-11-08T03:07"))?.toISOString()).toBe(
      "2026-11-08T03:15:00.000Z",
    );
    // Day of month OR day of week: after Friday the 13th, the next Friday.
    expect(parseCiCron("0 0 13 * fri").next(at("2026-11-13T00:00"))?.toISOString()).toBe(
      "2026-11-20T00:00:00.000Z",
    );
    expect(parseCiCron("@yearly").next(after)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(parseCiCron("0 0 29 2 *").next(after)?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(parseCiCron("0 0 30 2 *").next(after)).toBeNull();
    // Agrees with `matches` minute by minute across a day.
    const c = parseCiCron("5,35 */3 * * 1-5");
    let t = at("2026-11-06T00:00");
    for (let i = 0; i < 5; i++) {
      const n = c.next(t);
      expect(n && c.matches(n)).toBe(true);
      for (let m = t.getTime() + 60_000; n && m < n.getTime(); m += 60_000) {
        expect(c.matches(new Date(m))).toBe(false);
      }
      t = n ?? t;
    }
    expect(nextCiCronDue(["nonsense", "0 4 * * *", "30 3 * * *"], after)?.toISOString()).toBe(
      "2026-11-08T03:30:00.000Z",
    );
    expect(nextCiCronDue(["nonsense"], after)).toBeNull();
  });
});
