import { describe, expect, it } from "vitest";
import { bytesToHex, constantTimeEqual, hmacSha256, rejectedPagingWebhook } from "../paging.js";

describe("paging helpers", () => {
  it("computes RFC 4231 test case 2 HMAC-SHA256", async () => {
    const mac = await hmacSha256("Jefe", "what do ya want for nothing?");
    expect(bytesToHex(mac)).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("accepts raw key bytes", async () => {
    const key = new TextEncoder().encode("Jefe") as Uint8Array<ArrayBuffer>;
    const mac = await hmacSha256(key, "what do ya want for nothing?");
    expect(bytesToHex(mac)).toMatch(/^5bdcc146/);
  });

  it("compares strings without short-circuiting on length mismatch", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("rejected result is invalid and empty", () => {
    expect(rejectedPagingWebhook()).toEqual({
      valid: false,
      incidentIds: [],
      acknowledgedDedupKeys: [],
      resolvedDedupKeys: [],
    });
  });
});
