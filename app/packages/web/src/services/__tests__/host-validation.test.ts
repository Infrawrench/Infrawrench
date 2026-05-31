import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLookup = vi.fn();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

const { assertHostNotInternal } = await import("../host-validation");

describe("assertHostNotInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects empty host", async () => {
    await expect(assertHostNotInternal("   ")).rejects.toThrow("SSH host is required");
  });

  it("allows a public literal IPv4 without DNS", async () => {
    await expect(assertHostNotInternal("8.8.8.8")).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks loopback literal IPv4", async () => {
    await expect(assertHostNotInternal("127.0.0.1")).rejects.toThrow(/blocked address range/);
  });

  it("blocks RFC1918 10.x literal", async () => {
    await expect(assertHostNotInternal("10.1.2.3")).rejects.toThrow(/blocked address range/);
  });

  it("blocks RFC1918 192.168.x literal", async () => {
    await expect(assertHostNotInternal("192.168.0.5")).rejects.toThrow(/blocked address range/);
  });

  it("blocks 172.16.x RFC1918 literal", async () => {
    await expect(assertHostNotInternal("172.16.5.5")).rejects.toThrow(/blocked address range/);
  });

  it("blocks link-local 169.254.x", async () => {
    await expect(assertHostNotInternal("169.254.169.254")).rejects.toThrow(/blocked address range/);
  });

  it("blocks IPv6 loopback literal", async () => {
    await expect(assertHostNotInternal("::1")).rejects.toThrow(/blocked address range/);
  });

  it("blocks IPv6 unique-local fd00 literal", async () => {
    await expect(assertHostNotInternal("fd00::1")).rejects.toThrow(/blocked address range/);
  });

  it("blocks IPv4-mapped IPv6 pointing at a private v4", async () => {
    await expect(assertHostNotInternal("::ffff:10.0.0.1")).rejects.toThrow(/blocked address range/);
  });

  it("allows a public IPv6 literal", async () => {
    await expect(assertHostNotInternal("2606:4700:4700::1111")).resolves.toBeUndefined();
  });

  it("resolves a hostname and allows public addresses", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertHostNotInternal("example.com")).resolves.toBeUndefined();
    expect(mockLookup).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("rejects a hostname that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    await expect(assertHostNotInternal("internal.local")).rejects.toThrow(
      /resolves to a blocked address/,
    );
  });

  it("rejects when DNS lookup throws", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertHostNotInternal("nope.invalid")).rejects.toThrow(
      /Failed to resolve SSH host/,
    );
  });

  it("rejects a hostname that resolves to no addresses", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(assertHostNotInternal("empty.example")).rejects.toThrow(
      /did not resolve to any address/,
    );
  });
});
