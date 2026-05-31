import { describe, expect, it } from "vitest";
import { tokenize, formatRedisResult } from "../components/KvConsole.utils";

describe("tokenize", () => {
  it("splits a simple command on whitespace", () => {
    expect(tokenize("GET foo bar")).toEqual(["GET", "foo", "bar"]);
  });
  it("collapses repeated spaces", () => {
    expect(tokenize("SET   key    value")).toEqual(["SET", "key", "value"]);
  });
  it("keeps double-quoted segments intact", () => {
    expect(tokenize('SET key "a b c"')).toEqual(["SET", "key", "a b c"]);
  });
  it("keeps single-quoted segments intact", () => {
    expect(tokenize("SET key 'x y'")).toEqual(["SET", "key", "x y"]);
  });
  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
  it("handles trailing token without space", () => {
    expect(tokenize("PING")).toEqual(["PING"]);
  });
});

describe("formatRedisResult", () => {
  it("formats nil", () => {
    expect(formatRedisResult(null)).toBe("(nil)");
  });
  it("formats strings", () => {
    expect(formatRedisResult("hello")).toBe("hello");
  });
  it("formats numbers", () => {
    expect(formatRedisResult(42)).toBe("42");
  });
  it("formats arrays with 1-based indices", () => {
    expect(formatRedisResult(["a", "b"])).toBe("1) a\n2) b");
  });
  it("formats nested arrays recursively", () => {
    expect(formatRedisResult([["x"]])).toBe("1) 1) x");
  });
  it("falls back to JSON for objects", () => {
    expect(formatRedisResult({ k: 1 })).toBe('{"k":1}');
  });
});
