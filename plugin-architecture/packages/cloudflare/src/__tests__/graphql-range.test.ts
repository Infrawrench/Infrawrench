import { describe, expect, it } from "vitest";
import { clampGraphqlRange, rangeLimitFromError } from "../graphql-range.js";

const DAY = 24 * 3_600_000;
const end = Date.UTC(2026, 9, 3);

describe("clampGraphqlRange", () => {
  it("leaves ranges inside the dataset limit alone", () => {
    const r = { startMs: end - 7 * DAY, endMs: end };
    expect(clampGraphqlRange("worker", r)).toBe(r);
  });

  it("clamps adaptive datasets to 31 days, keeping the end", () => {
    expect(clampGraphqlRange("worker", { startMs: end - 90 * DAY, endMs: end })).toEqual({
      startMs: end - 31 * DAY,
      endMs: end,
    });
  });

  it("clamps Turnstile to 7 days", () => {
    expect(clampGraphqlRange("turnstile-widget", { startMs: end - 30 * DAY, endMs: end })).toEqual({
      startMs: end - 7 * DAY,
      endMs: end,
    });
  });

  it("does not touch zones or Analytics Engine datasets", () => {
    const r = { startMs: end - 90 * DAY, endMs: end };
    expect(clampGraphqlRange("zone", r)).toBe(r);
    expect(clampGraphqlRange("analytics-engine-dataset", r)).toBe(r);
    expect(clampGraphqlRange("worker", undefined)).toBeUndefined();
  });
});

describe("rangeLimitFromError", () => {
  it("parses Cloudflare's compound durations", () => {
    const msg = (d: string) =>
      `zone "abc" cannot request a time range wider than ${d}, but your query time range spans 4w2d`;
    expect(rangeLimitFromError(msg("3d"))).toBe(3 * DAY);
    expect(rangeLimitFromError(msg("1w1h"))).toBe(7 * DAY + 3_600_000);
    expect(rangeLimitFromError(msg("4w4d"))).toBe(32 * DAY);
  });

  it("ignores other errors", () => {
    expect(rangeLimitFromError('unknown field "count"')).toBeUndefined();
  });
});
