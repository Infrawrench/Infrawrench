import { describe, it, expect } from "vitest";
import { tokenize, formatRedisResult } from "@/components/KvConsole";

describe("tokenize", () => {
  it("splits simple command", () => {
    expect(tokenize("GET key")).toEqual(["GET", "key"]);
  });

  it("handles double-quoted strings", () => {
    expect(tokenize('SET key "hello world"')).toEqual(["SET", "key", "hello world"]);
  });

  it("handles single-quoted strings", () => {
    expect(tokenize("SET key 'hello world'")).toEqual(["SET", "key", "hello world"]);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("trims leading and trailing spaces", () => {
    expect(tokenize("  spaced  ")).toEqual(["spaced"]);
  });

  it("collapses multiple spaces between tokens", () => {
    expect(tokenize("GET   key")).toEqual(["GET", "key"]);
  });

  it("handles mixed quotes", () => {
    expect(tokenize(`SET 'a' "b"`)).toEqual(["SET", "a", "b"]);
  });
});

describe("formatRedisResult", () => {
  it("formats null as (nil)", () => {
    expect(formatRedisResult(null)).toBe("(nil)");
  });

  it("returns string values as-is", () => {
    expect(formatRedisResult("OK")).toBe("OK");
  });

  it("formats numbers as strings", () => {
    expect(formatRedisResult(42)).toBe("42");
  });

  it("formats arrays with 1-indexed numbers", () => {
    const result = formatRedisResult(["a", "b"]);
    expect(result).toBe("1) a\n2) b");
  });

  it("handles nested arrays", () => {
    const result = formatRedisResult(["a", ["x", "y"]]);
    expect(result).toBe("1) a\n2) 1) x\n2) y");
  });

  it("formats arrays with null elements", () => {
    const result = formatRedisResult(["a", null]);
    expect(result).toBe("1) a\n2) (nil)");
  });

  it("formats objects as JSON", () => {
    expect(formatRedisResult({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("returns empty string for empty string input", () => {
    expect(formatRedisResult("")).toBe("");
  });
});
