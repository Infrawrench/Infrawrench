import { describe, expect, it } from "vitest";
import { utf8ToBase64 } from "../base64";

describe("utf8ToBase64", () => {
  it("encodes ASCII", () => {
    expect(utf8ToBase64("hello")).toBe("aGVsbG8=");
  });

  it("handles padding for 1- and 2-byte remainders", () => {
    expect(utf8ToBase64("a")).toBe("YQ==");
    expect(utf8ToBase64("ab")).toBe("YWI=");
    expect(utf8ToBase64("abc")).toBe("YWJj");
  });

  it("encodes terminal escape sequences", () => {
    expect(utf8ToBase64("\x1b[A")).toBe("G1tB");
    expect(utf8ToBase64("\x03")).toBe("Aw==");
  });

  it("encodes multi-byte UTF-8", () => {
    expect(utf8ToBase64("🚀")).toBe("8J+agA==");
    expect(utf8ToBase64("")).toBe("");
  });
});
