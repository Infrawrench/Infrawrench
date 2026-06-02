import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockGet = vi.fn();
const mockOn = vi.fn();

vi.mock("ioredis", () => ({
  default: vi.fn(function () {
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      get: mockGet,
      on: mockOn,
    };
  }),
}));

import { driver } from "../driver.js";

describe("redis driver error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("retries once on transient errors and succeeds", async () => {
    mockGet.mockRejectedValueOnce(new Error("Connection is closed")).mockResolvedValueOnce("ok");
    const result = await driver.command("redis://localhost:6379", "GET", ["k"]);
    expect(result).toBe("ok");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("maps ETIMEDOUT to a tunnel hint with host", async () => {
    mockConnect.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:6380"));
    await expect(driver.command("redis://cache.example.com:6380/0", "GET", ["k"])).rejects.toThrow(
      /Timed out connecting to Redis at cache.example.com:6380/,
    );
  });

  it("maps ECONNREFUSED", async () => {
    mockConnect.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    await expect(driver.command("redis://localhost:6379", "GET", ["k"])).rejects.toThrow(
      /Connection refused by Redis at localhost:6379/,
    );
  });

  it("maps ENOTFOUND", async () => {
    mockConnect.mockRejectedValue(new Error("getaddrinfo ENOTFOUND nope.invalid"));
    await expect(driver.command("redis://nope.invalid:6379", "GET", ["k"])).rejects.toThrow(
      /Cannot resolve Redis host/,
    );
  });

  it("rethrows non-transient generic errors unchanged", async () => {
    mockConnect.mockRejectedValue(new Error("WRONGPASS invalid credentials"));
    await expect(driver.command("redis://localhost:6379", "GET", ["k"])).rejects.toThrow(
      "WRONGPASS invalid credentials",
    );
  });

  it("retries transient error then maps the retry failure", async () => {
    mockGet
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    await expect(driver.command("redis://localhost:6379", "GET", ["k"])).rejects.toThrow(
      /Connection refused by Redis/,
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("uses no-host phrasing when connection string is unparseable", async () => {
    mockConnect.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await expect(driver.command("garbage", "GET", ["k"])).rejects.toThrow(
      /Timed out connecting to Redis\./,
    );
  });
});
