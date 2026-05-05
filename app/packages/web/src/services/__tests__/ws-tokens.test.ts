import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWsToken, validateWsToken } from "../ws-tokens";

describe("ws-tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates a token and validates it", () => {
    const token = createWsToken("user1", "org1");
    const result = validateWsToken(token);
    expect(result).toEqual({ userId: "user1", organizationId: "org1" });
  });

  it("tokens are one-time use", () => {
    const token = createWsToken("user1", "org1");
    validateWsToken(token); // first use
    const second = validateWsToken(token);
    expect(second).toBeNull();
  });

  it("returns null for an unknown token", () => {
    expect(validateWsToken("nonexistent")).toBeNull();
  });

  it("expires after 30 seconds", () => {
    const token = createWsToken("user1", "org1");
    vi.advanceTimersByTime(31_000);
    const result = validateWsToken(token);
    expect(result).toBeNull();
  });
});
