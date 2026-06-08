import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDel = vi.fn();
const mockMemory = vi.fn();
const mockCall = vi.fn();
const mockOn = vi.fn();

vi.mock("ioredis", () => ({
  default: vi.fn(function () {
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      get: mockGet,
      set: mockSet,
      del: mockDel,
      memory: mockMemory,
      call: mockCall,
      on: mockOn,
    };
  }),
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

    it("splits multi-word command names for typed subcommand methods", async () => {
      mockMemory.mockResolvedValue(128);

      const result = await driver.command("redis://localhost:6379", "MEMORY USAGE", ["foo"]);

      expect(result).toBe(128);
      expect(mockMemory).toHaveBeenCalledWith("USAGE", "foo");
    });

    it("falls back to raw command calls for module commands", async () => {
      mockCall.mockResolvedValue('{"name":"Ada"}');

      const result = await driver.command("redis://localhost:6379", "JSON.GET", ["user:1", "$"]);

      expect(result).toBe('{"name":"Ada"}');
      expect(mockCall).toHaveBeenCalledWith("JSON.GET", "user:1", "$");
    });

    it("falls back to raw command calls for unknown core commands", async () => {
      mockCall.mockResolvedValue("OK");

      const result = await driver.command("redis://localhost:6379", "CLIENT", ["SETNAME", "iw"]);

      expect(result).toBe("OK");
      expect(mockCall).toHaveBeenCalledWith("CLIENT", "SETNAME", "iw");
    });

    it("throws for an empty command", async () => {
      await expect(driver.command("redis://localhost:6379", " ", [])).rejects.toThrow(
        "Redis command is required",
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
