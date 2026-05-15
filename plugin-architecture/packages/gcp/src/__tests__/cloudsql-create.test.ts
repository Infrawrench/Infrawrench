import { describe, it, expect } from "vitest";
import { parseAuthorizedNetworks } from "../cloudsql-create-handlers.js";

describe("parseAuthorizedNetworks", () => {
  it("returns [] for blank input", () => {
    expect(parseAuthorizedNetworks(undefined)).toEqual([]);
    expect(parseAuthorizedNetworks("")).toEqual([]);
    expect(parseAuthorizedNetworks("   \n  \n")).toEqual([]);
  });

  it("splits on newlines and commas, skipping blanks", () => {
    expect(parseAuthorizedNetworks("1.2.3.4/32\n10.0.0.0/8")).toEqual([
      { name: "infrawrench-1", value: "1.2.3.4/32" },
      { name: "infrawrench-2", value: "10.0.0.0/8" },
    ]);
    expect(parseAuthorizedNetworks("1.2.3.4/32, 5.6.7.8/32")).toEqual([
      { name: "infrawrench-1", value: "1.2.3.4/32" },
      { name: "infrawrench-2", value: "5.6.7.8/32" },
    ]);
  });

  it("accepts IPv4 and IPv6 CIDRs", () => {
    expect(parseAuthorizedNetworks("0.0.0.0/0\n2001:db8::/32")).toEqual([
      { name: "infrawrench-1", value: "0.0.0.0/0" },
      { name: "infrawrench-2", value: "2001:db8::/32" },
    ]);
  });

  it("rejects malformed entries with the bad value in the message", () => {
    expect(() => parseAuthorizedNetworks("not-a-cidr")).toThrow(/"not-a-cidr"/);
    expect(() => parseAuthorizedNetworks("1.2.3.4")).toThrow(/"1.2.3.4"/);
  });
});
