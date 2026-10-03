import { describe, expect, it } from "vitest";
import { hostPortDialTarget, urlDialTarget } from "../dial-targets.js";

describe("hostPortDialTarget", () => {
  it("splits host and port", () => {
    expect(hostPortDialTarget("cache.example.com:11212", 11211)).toEqual({
      kind: "host",
      host: "cache.example.com",
      port: 11212,
    });
  });

  it("defaults the port and drops credentials", () => {
    expect(hostPortDialTarget("user:pw@cache.example.com", 11211)).toEqual({
      kind: "host",
      host: "cache.example.com",
      port: 11211,
    });
  });

  it("handles bracketed IPv6", () => {
    expect(hostPortDialTarget("[::1]:9092", 9092)).toEqual({
      kind: "host",
      host: "::1",
      port: 9092,
    });
  });

  it("reports a path as local", () => {
    expect(hostPortDialTarget("/tmp/x.sock", 1).kind).toBe("local");
  });
});

describe("urlDialTarget", () => {
  it("reports a URL without a host as local", () => {
    expect(urlDialTarget(new URL("mysql:///db"), 3306).kind).toBe("local");
  });
});
