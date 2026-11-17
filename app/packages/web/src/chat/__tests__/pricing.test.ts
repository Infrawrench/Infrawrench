import { describe, it, expect } from "vitest";
import { computeCostMicros } from "../pricing";

const NONE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const ONE_MILLION_EACH = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
};

describe("computeCostMicros", () => {
  it("returns 0 for an all-zero usage", () => {
    expect(computeCostMicros("claude-opus-5-5", NONE)).toBe(0);
  });

  it("computes Sonnet 5.5 input cost at default markup (2.0 * 1.5 = 3 USD/Mtok)", () => {
    expect(computeCostMicros("claude-sonnet-5-5", { ...NONE, inputTokens: 1_000_000 })).toBe(
      3_000_000,
    );
  });

  it("computes Opus 5.5 output cost at default markup (20 * 1.5 = 30 USD/Mtok)", () => {
    expect(computeCostMicros("claude-opus-5-5", { ...NONE, outputTokens: 1_000_000 })).toBe(
      30_000_000,
    );
  });

  it("prices Sonnet 5.5 across all four buckets at default markup", () => {
    // (2.00 + 10.00 + 0.10 + 2.50) * 1.5 markup
    expect(computeCostMicros("claude-sonnet-5-5", ONE_MILLION_EACH)).toBe(21_900_000);
  });

  it("prices Opus 5.5 across all four buckets at default markup", () => {
    // (4.00 + 20.00 + 0.20 + 5.00) * 1.5 markup
    expect(computeCostMicros("claude-opus-5-5", ONE_MILLION_EACH)).toBe(43_800_000);
  });

  it("prices a Haiku 5.5 prompt of 100K tokens or fewer on the lower card", () => {
    // 100K input at $0.10 + 10K output at $0.50, x1.5 = $0.0225
    const micros = computeCostMicros("claude-haiku-5-5", {
      ...NONE,
      inputTokens: 100_000,
      outputTokens: 10_000,
    });
    expect(micros).toBe(22_500);
  });

  it("prices every token of a longer Haiku 5.5 prompt on the higher card", () => {
    // Cached tokens count toward the prompt length: 60K input + 50K cache
    // read is 110K, so all of it bills at $0.50 / $2.50 (cache read $0.05).
    // (60K * 0.50 + 50K * 0.05 + 10K * 2.50) / 1M * 1.5 = $0.08625
    const micros = computeCostMicros("claude-haiku-5-5", {
      inputTokens: 60_000,
      outputTokens: 10_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(86_250);
  });

  it("falls back to the most expensive tier for unknown models", () => {
    // Retired ids (claude-opus-5, claude-haiku-4-5) included: nothing calls
    // them any more, and an unknown model must never undercharge.
    expect(computeCostMicros("some-unknown-model", { ...NONE, inputTokens: 1_000_000 })).toBe(
      6_000_000, // Opus 5.5 input rate
    );
  });

  it("never returns a negative value", () => {
    expect(computeCostMicros("claude-sonnet-5-5", { ...NONE, inputTokens: -1_000_000 })).toBe(0);
  });

  it("rounds to the nearest micro-dollar", () => {
    // 10 Haiku 5.5 tokens at 0.15 USD/Mtok => 1.5 micros => rounds to 2
    expect(computeCostMicros("claude-haiku-5-5", { ...NONE, inputTokens: 10 })).toBe(2);
  });
});
