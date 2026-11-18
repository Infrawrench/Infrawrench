import { describe, expect, it } from "vitest";
import { metricsRequestRange } from "../metrics-window";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

describe("metricsRequestRange", () => {
  it("covers the window the detail view's caption names", () => {
    expect(metricsRequestRange(30 * DAY, NOW)).toEqual({ startMs: NOW - 30 * DAY, endMs: NOW });
  });

  it("sends no range when the view declares no window", () => {
    expect(metricsRequestRange(undefined, NOW)).toEqual({});
  });

  it("ignores a window that is not a positive duration", () => {
    expect(metricsRequestRange(0, NOW)).toEqual({});
    expect(metricsRequestRange(-5, NOW)).toEqual({});
    expect(metricsRequestRange(Number.NaN, NOW)).toEqual({});
    expect(metricsRequestRange(Number.POSITIVE_INFINITY, NOW)).toEqual({});
  });
});
