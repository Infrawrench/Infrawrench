import { describe, expect, it } from "vitest";

import {
  WALLBOARD_LIMITS,
  clampWallboardSeconds,
  formatWallDuration,
  rotationIndex,
  wallboardStatus,
  type WallboardFailureLine,
  type WallboardIncidentLine,
} from "../wallboard";

const incident = (over: Partial<WallboardIncidentLine> = {}): WallboardIncidentLine => ({
  id: "i1",
  title: "Checkout latency",
  severity: "sev2",
  startedAt: "2026-08-17T10:00:00.000Z",
  status: "open",
  ...over,
});

const failure = (over: Partial<WallboardFailureLine> = {}): WallboardFailureLine => ({
  id: "f1",
  label: "orders monitor",
  detail: "breaching",
  since: null,
  ...over,
});

describe("wallboardStatus", () => {
  const base = { incidents: [], failures: [], failedSources: [], probesDown: 0 };

  it("is ok when nothing is wrong", () => {
    expect(wallboardStatus(base)).toBe("ok");
  });

  it("is down when a probe is down", () => {
    expect(wallboardStatus({ ...base, probesDown: 1 })).toBe("down");
  });

  it("is down for a sev1 and degraded for anything softer", () => {
    expect(wallboardStatus({ ...base, incidents: [incident({ severity: "sev1" })] })).toBe("down");
    expect(wallboardStatus({ ...base, incidents: [incident({ severity: "SEV1" })] })).toBe("down");
    expect(wallboardStatus({ ...base, incidents: [incident({ severity: "sev3" })] })).toBe(
      "degraded",
    );
  });

  it("is degraded for a failure with no incident", () => {
    expect(wallboardStatus({ ...base, failures: [failure()] })).toBe("degraded");
  });

  it("is never ok when a source could not be read", () => {
    // A wall showing green because a query threw is worse than a blank one —
    // it is actively telling the room the wrong thing.
    expect(wallboardStatus({ ...base, failedSources: ["probes"] })).toBe("degraded");
  });
});

describe("rotationIndex", () => {
  it("is derived from the clock, so every screen agrees", () => {
    // Two televisions in one room rotating out of step is the sort of thing
    // people notice and nobody can explain.
    const at = Date.parse("2026-08-17T10:00:07.000Z");
    expect(rotationIndex(at, 3, 20)).toBe(rotationIndex(at, 3, 20));
    expect(rotationIndex(at, 3, 20)).toBe(rotationIndex(at + 5_000, 3, 20));
  });

  it("advances once per period and wraps", () => {
    const start = 0;
    expect(rotationIndex(start, 3, 10)).toBe(0);
    expect(rotationIndex(start + 10_000, 3, 10)).toBe(1);
    expect(rotationIndex(start + 20_000, 3, 10)).toBe(2);
    expect(rotationIndex(start + 30_000, 3, 10)).toBe(0);
  });

  it("is 0 with no panels and survives a zero period", () => {
    expect(rotationIndex(1234, 0, 10)).toBe(0);
    expect(rotationIndex(1234, 3, 0)).toBe(rotationIndex(1234, 3, 1));
  });
});

describe("clampWallboardSeconds", () => {
  const bounds = {
    min: WALLBOARD_LIMITS.minRefreshSeconds,
    max: WALLBOARD_LIMITS.maxRefreshSeconds,
    fallback: WALLBOARD_LIMITS.defaultRefreshSeconds,
  };

  it("clamps rather than rejecting", () => {
    // A wallboard URL is typed onto a television with a remote control; a 400
    // there is a black screen nobody can debug.
    expect(clampWallboardSeconds(1, bounds)).toBe(bounds.min);
    expect(clampWallboardSeconds(99_999, bounds)).toBe(bounds.max);
    expect(clampWallboardSeconds(45, bounds)).toBe(45);
  });

  it("falls back on junk", () => {
    expect(clampWallboardSeconds("abc", bounds)).toBe(bounds.fallback);
    expect(clampWallboardSeconds(undefined, bounds)).toBe(bounds.fallback);
    expect(clampWallboardSeconds(Number.NaN, bounds)).toBe(bounds.fallback);
  });

  it("accepts a numeric string, because it comes from a query parameter", () => {
    expect(clampWallboardSeconds("45", bounds)).toBe(45);
  });
});

describe("formatWallDuration", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");

  it("reads as a person would say it", () => {
    expect(formatWallDuration("2026-08-17T11:19:00.000Z", now)).toBe("41m");
    expect(formatWallDuration("2026-08-17T08:48:00.000Z", now)).toBe("3h 12m");
    expect(formatWallDuration("2026-08-15T12:00:00.000Z", now)).toBe("2d");
  });

  it("is empty rather than wrong for an absent or unparseable instant", () => {
    expect(formatWallDuration(null, now)).toBe("");
    expect(formatWallDuration("soon", now)).toBe("");
  });

  it("never goes negative on a clock skew", () => {
    expect(formatWallDuration("2026-08-17T12:05:00.000Z", now)).toBe("0m");
  });
});
