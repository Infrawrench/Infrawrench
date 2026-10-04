import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalQuery,
  crusoeTimestamp,
  goQueryEscape,
  signaturePayload,
  signRequest,
} from "../signing.js";

describe("canonicalQuery", () => {
  it("sorts keys, repeats array values in order and drops empty filters", () => {
    expect(
      canonicalQuery({
        start_date: "2026-01-01",
        projects: ["p 1", "p2"],
        regions: [],
        end_date: "2026-01-31",
        missing: undefined,
      }),
    ).toBe("end_date=2026-01-31&projects=p+1&projects=p2&start_date=2026-01-01");
  });

  it("escapes like Go's url.QueryEscape", () => {
    expect(goQueryEscape("a b/c=d&e*'()!~._-")).toBe("a+b%2Fc%3Dd%26e%2A%27%28%29%21~._-");
  });

  it("is empty for no query", () => {
    expect(canonicalQuery(undefined)).toBe("");
    expect(canonicalQuery({})).toBe("");
  });
});

describe("signRequest", () => {
  it("matches an independently computed HMAC-SHA256 signature", async () => {
    // Expected value computed with Python's hmac/hashlib over the same
    // payload, following Crusoe's documented Python example.
    const headers = await signRequest({
      accessKeyId: "AK",
      secretKey: "c2VjcmV0LWtleS1mb3ItdGVzdHM",
      method: "get",
      path: "/v1/organizations/abc/billing/costs",
      query: "end_date=2026-01-31&projects=p+1&projects=p2&start_date=2026-01-01",
      now: new Date("2026-10-04T12:00:00.123Z"),
    });
    expect(headers["X-Crusoe-Timestamp"]).toBe("2026-10-04T12:00:00Z");
    expect(headers["Authorization"]).toBe(
      "Bearer 1.0:AK:UN19AMkYXW5XBtyne-_0HtEFP5Vdb0ln5C3SnmACs5Q",
    );
  });

  it("explains a secret that is not base64", async () => {
    await expect(
      signRequest({ accessKeyId: "a", secretKey: "%%%", method: "GET", path: "/v1/x", query: "" }),
    ).rejects.toThrow(/not valid base64/);
  });
});

describe("helpers", () => {
  it("builds the four-line payload with a trailing newline", () => {
    expect(signaturePayload("/v1/a", "", "post", "T")).toBe("/v1/a\n\nPOST\nT\n");
  });

  it("round-trips unpadded base64url", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(base64UrlEncode(bytes)).not.toMatch(/[+/=]/);
  });

  it("formats timestamps at second precision", () => {
    expect(crusoeTimestamp(new Date("2026-01-02T03:04:05.999Z"))).toBe("2026-01-02T03:04:05Z");
  });
});
