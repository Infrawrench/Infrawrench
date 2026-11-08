import { describe, expect, it } from "vitest";
import { anyDue, parseCron } from "../cron";

// The same cases as `iwci-spec/src/cron.rs`, so the two matchers agree.
const at = (iso: string) => new Date(`${iso}:00Z`);

describe("cron", () => {
  it("matches fields, steps, ranges, names and shortcuts", () => {
    expect(parseCron("0 3 * * *").matches(at("2026-11-08T03:00"))).toBe(true);
    expect(parseCron("0 3 * * *").matches(at("2026-11-08T03:01"))).toBe(false);
    const work = parseCron("*/15 9-17 * * mon-fri");
    expect(work.matches(at("2026-11-09T09:45"))).toBe(true);
    expect(work.matches(at("2026-11-08T09:45"))).toBe(false);
    expect(work.matches(at("2026-11-09T18:00"))).toBe(false);
    const offset = parseCron("5/20 * * * *");
    expect(offset.matches(at("2026-11-09T10:45"))).toBe(true);
    expect(offset.matches(at("2026-11-09T10:50"))).toBe(false);
    const named = parseCron("0 0 1,15 jan,JUL *");
    expect(named.matches(at("2026-07-15T00:00"))).toBe(true);
    expect(named.matches(at("2026-08-15T00:00"))).toBe(false);
    expect(parseCron("0 0 * * 7").matches(at("2026-11-08T00:00"))).toBe(true);
    expect(parseCron("@daily").matches(at("2026-11-08T00:00"))).toBe(true);
    expect(parseCron("@weekly").matches(at("2026-11-08T00:00"))).toBe(true);
    expect(parseCron("@monthly").matches(at("2026-11-08T00:00"))).toBe(false);
  });

  it("ORs day of month and day of week when both are set", () => {
    const c = parseCron("0 0 13 * fri");
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
      expect(() => parseCron(bad), bad).toThrow();
    }
    expect(anyDue(["nonsense", "0 3 * * *"], at("2026-11-08T03:00"))).toBe(true);
    expect(anyDue(["nonsense"], at("2026-11-08T03:00"))).toBe(false);
  });
});
