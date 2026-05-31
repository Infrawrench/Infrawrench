import { describe, it, expect } from "vitest";
import { computeCostMicros } from "../pricing";

describe("computeCostMicros", () => {
  it("returns 0 for an all-zero usage", () => {
    expect(
      computeCostMicros({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });

  it("computes input cost at default markup (3.0 * 1.5 = 4.5 USD/Mtok)", () => {
    // 1,000,000 input tokens => 4.5 USD => 4_500_000 micros
    const micros = computeCostMicros({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(4_500_000);
  });

  it("computes output cost at default markup (15 * 1.5 = 22.5 USD/Mtok)", () => {
    const micros = computeCostMicros({
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(22_500_000);
  });

  it("sums all four token buckets", () => {
    const micros = computeCostMicros({
      inputTokens: 1_000_000, // 4.5
      outputTokens: 1_000_000, // 22.5
      cacheReadTokens: 1_000_000, // 0.3 * 1.5 = 0.45
      cacheWriteTokens: 1_000_000, // 3.75 * 1.5 = 5.625
    });
    // total USD = 4.5 + 22.5 + 0.45 + 5.625 = 33.075 => 33_075_000 micros
    expect(micros).toBe(33_075_000);
  });

  it("never returns a negative value", () => {
    const micros = computeCostMicros({
      inputTokens: -1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(0);
  });

  it("rounds to the nearest micro-dollar", () => {
    const micros = computeCostMicros({
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 1 token at 4.5 USD/Mtok => 0.0000045 USD => 4.5 micros => rounds to 5 (round-half-up)
    expect(micros).toBe(5);
  });
});
