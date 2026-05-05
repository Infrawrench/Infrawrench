import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDel = vi.fn();
const mockOn = vi.fn();

vi.mock("ioredis", () => ({
  default: vi.fn(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    get: mockGet,
    set: mockSet,
    del: mockDel,
    on: mockOn,
  })),
}));

import { driver } from "../driver.js";
import Redis from "ioredis";

describe("redis driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("has id 'redis'", () => {
    expect(driver.id).toBe("redis");
  });

  describe("command", () => {
    it("routes GET command to client.get", async () => {
      mockGet.mockResolvedValue("bar");

      const result = await driver.command("redis://localhost:6379", "GET", ["foo"]);

      expect(result).toBe("bar");
      expect(Redis).toHaveBeenCalledWith(
        "redis://localhost:6379",
        expect.objectContaining({
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          enableReadyCheck: false,
        }),
      );
      expect(mockConnect).toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledWith("foo");
    });

    it("routes SET command to client.set", async () => {
      mockSet.mockResolvedValue("OK");

      const result = await driver.command("redis://localhost:6379", "SET", ["foo", "bar"]);

      expect(result).toBe("OK");
      expect(mockSet).toHaveBeenCalledWith("foo", "bar");
    });

    it("converts command name to lowercase", async () => {
      mockDel.mockResolvedValue(1);

      const result = await driver.command("redis://localhost:6379", "DEL", ["key1"]);

      expect(result).toBe(1);
      expect(mockDel).toHaveBeenCalledWith("key1");
    });

    it("throws for unknown commands", async () => {
      await expect(driver.command("redis://localhost:6379", "UNKNOWNCMD", [])).rejects.toThrow(
        "Unknown Redis command: UNKNOWNCMD",
      );
    });

    it("disconnects even on error", async () => {
      mockConnect.mockRejectedValue(new Error("connection refused"));

      await expect(driver.command("redis://localhost:6379", "GET", ["foo"])).rejects.toThrow(
        "connection refused",
      );
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });
});
