import { describe, it, expect } from "vitest";
import { safeReturnPath } from "../oauth-state";

describe("safeReturnPath", () => {
  it("accepts a root-relative path", () => {
    expect(safeReturnPath("/org/o1/settings")).toBe("/org/o1/settings");
  });

  it("keeps the query string", () => {
    expect(safeReturnPath("/search?q=a&b=c")).toBe("/search?q=a&b=c");
  });

  it("rejects an empty or missing value", () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("")).toBeNull();
  });

  it.each([
    ["https://evil.test/steal", "absolute URL"],
    ["http://evil.test", "absolute URL"],
    ["//evil.test/steal", "protocol-relative"],
    ["/\\evil.test", "backslash-folded protocol-relative"],
    ["javascript:alert(1)", "javascript scheme"],
    ["org/o1/settings", "not root-relative"],
  ])("rejects %s (%s)", (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it("rejects control characters that could split a redirect header", () => {
    expect(safeReturnPath("/ok\r\nLocation: https://evil.test")).toBeNull();
    expect(safeReturnPath("/ok\nSet-Cookie: a=b")).toBeNull();
    expect(safeReturnPath("/ok\u0000")).toBeNull();
  });

  it("rejects an over-long value", () => {
    expect(safeReturnPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});
