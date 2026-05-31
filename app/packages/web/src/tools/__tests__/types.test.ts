import { describe, it, expect } from "vitest";
import { ok, okText, err } from "../types";

describe("tool result helpers", () => {
  it("ok serializes a value to pretty JSON text", () => {
    const result = ok({ a: 1, b: "two" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1, b: "two" });
  });

  it("okText wraps raw text without JSON encoding", () => {
    const result = okText("hello world");
    expect(result.content[0]!.text).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });

  it("err marks the result as an error", () => {
    const result = err("boom");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("boom");
  });
});
