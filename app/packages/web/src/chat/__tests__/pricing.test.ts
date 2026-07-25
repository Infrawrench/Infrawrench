import { describe, it, expect } from "vitest";
import { computeCostMicros } from "../pricing";

describe("computeCostMicros", () => {
  it("returns 0 for an all-zero usage", () => {
    expect(
      computeCostMicros("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });

  it("computes Sonnet 5 input cost at default markup (3.0 * 1.5 = 4.5 USD/Mtok)", () => {
    // 1,000,000 input tokens => 4.5 USD => 4_500_000 micros
    const micros = computeCostMicros("claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(4_500_000);
  });

  it("computes Opus 5 output cost at default markup (25 * 1.5 = 37.5 USD/Mtok)", () => {
    const micros = computeCostMicros("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(37_500_000);
  });

  it("prices Gemini 3.6 Flash input, output, and cached input at default markup", () => {
    const micros = computeCostMicros("gemini-3.6-flash", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    // (1.50 + 7.50 + 0.15) * 1.5 markup
    expect(micros).toBe(13_725_000);
  });

  it("never charges Gemini a cache-write rate", () => {
    const micros = computeCostMicros("gemini-3.6-flash", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(micros).toBe(0);
  });

  it("computes Haiku 4.5 output cost at default markup (5 * 1.5 = 7.5 USD/Mtok)", () => {
    const micros = computeCostMicros("claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(7_500_000);
  });

  it("prices legacy opus-4-8 conversations", () => {
    const micros = computeCostMicros("claude-opus-4-8", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(37_500_000);
  });

  it("prices legacy sonnet-4-6 conversations", () => {
    const micros = computeCostMicros("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(4_500_000);
  });

  it("falls back to the most expensive tier for unknown models", () => {
    const micros = computeCostMicros("some-unknown-model", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(7_500_000); // Opus 5 input rate
  });

  it("sums all four token buckets (Sonnet 5)", () => {
    const micros = computeCostMicros("claude-sonnet-5", {
      inputTokens: 1_000_000, // 4.5
      outputTokens: 1_000_000, // 22.5
      cacheReadTokens: 1_000_000, // 0.3 * 1.5 = 0.45
      cacheWriteTokens: 1_000_000, // 3.75 * 1.5 = 5.625
    });
    // total USD = 4.5 + 22.5 + 0.45 + 5.625 = 33.075 => 33_075_000 micros
    expect(micros).toBe(33_075_000);
  });

  it("never returns a negative value", () => {
    const micros = computeCostMicros("claude-sonnet-5", {
      inputTokens: -1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(micros).toBe(0);
  });

  it("rounds to the nearest micro-dollar", () => {
    const micros = computeCostMicros("claude-sonnet-5", {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 1 token at 4.5 USD/Mtok => 0.0000045 USD => 4.5 micros => rounds to 5 (round-half-up)
    expect(micros).toBe(5);
  });
});
