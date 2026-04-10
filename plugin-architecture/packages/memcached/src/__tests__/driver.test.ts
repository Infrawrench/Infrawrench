import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();
const mockFlush = vi.fn();
const mockStats = vi.fn();
const mockQuit = vi.fn();

vi.mock("memjs", () => ({
  default: {
    Client: {
      create: vi.fn(() => ({
        get: mockGet,
        set: mockSet,
        delete: mockDelete,
        flush: mockFlush,
        stats: mockStats,
        quit: mockQuit,
      })),
    },
  },
}));

import { driver } from "../driver.js";
import Memjs from "memjs";

describe("memcached driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has id 'memcached'", () => {
    expect(driver.id).toBe("memcached");
  });

  describe("command", () => {
    it("handles GET and returns string value", async () => {
      mockGet.mockResolvedValue({ value: Buffer.from("hello") });

      const result = await driver.command("memcached://localhost:11211", "GET", ["mykey"]);

      expect(result).toBe("hello");
      expect(Memjs.Client.create).toHaveBeenCalledWith(
        "localhost:11211",
        expect.objectContaining({ timeout: 5, retries: 0 }),
      );
    });

    it("handles GET returning null when value is missing", async () => {
      mockGet.mockResolvedValue({ value: null });

      const result = await driver.command("memcached://localhost:11211", "GET", ["missing"]);

      expect(result).toBeNull();
    });

    it("handles SET and returns STORED", async () => {
      mockSet.mockResolvedValue(true);

      const result = await driver.command("memcached://localhost:11211", "SET", ["key", "value", 0]);

      expect(result).toBe("STORED");
      expect(mockSet).toHaveBeenCalledWith("key", "value", { expires: 0 });
    });

    it("handles SET returning NOT STORED", async () => {
      mockSet.mockResolvedValue(false);

      const result = await driver.command("memcached://localhost:11211", "SET", ["key", "value"]);

      expect(result).toBe("NOT STORED");
    });

    it("handles DELETE and returns DELETED", async () => {
      mockDelete.mockResolvedValue(true);

      const result = await driver.command("memcached://localhost:11211", "DELETE", ["key"]);

      expect(result).toBe("DELETED");
    });

    it("handles DEL alias", async () => {
      mockDelete.mockResolvedValue(false);

      const result = await driver.command("memcached://localhost:11211", "DEL", ["key"]);

      expect(result).toBe("NOT FOUND");
    });

    it("handles FLUSH", async () => {
      mockFlush.mockResolvedValue(undefined);

      const result = await driver.command("memcached://localhost:11211", "FLUSH", []);

      expect(result).toBe("OK");
    });

    it("handles FLUSH_ALL alias", async () => {
      mockFlush.mockResolvedValue(undefined);

      const result = await driver.command("memcached://localhost:11211", "FLUSH_ALL", []);

      expect(result).toBe("OK");
    });

    it("handles STATS", async () => {
      mockStats.mockImplementation((cb: Function) => {
        cb(null, "server1:11211", { version: "1.6.0", uptime: "1000" });
        cb(null, null, null);
      });

      const result = await driver.command("memcached://localhost:11211", "STATS", []);

      expect(result).toContain("server1:11211");
      expect(result).toContain("version: 1.6.0");
    });

    it("handles VERSION", async () => {
      mockStats.mockImplementation((cb: Function) => {
        cb(null, "server1:11211", { version: "1.6.0" });
        cb(null, null, null);
      });

      const result = await driver.command("memcached://localhost:11211", "VERSION", []);

      expect(result).toBe("server1:11211: 1.6.0");
    });

    it("throws for unknown commands", async () => {
      await expect(
        driver.command("memcached://localhost:11211", "UNKNOWN", []),
      ).rejects.toThrow("Unknown Memcached command: UNKNOWN");
    });

    it("calls quit() even on error", async () => {
      mockGet.mockRejectedValue(new Error("timeout"));

      await expect(
        driver.command("memcached://localhost:11211", "GET", ["key"]),
      ).rejects.toThrow("timeout");
      expect(mockQuit).toHaveBeenCalled();
    });

    it("handles STATS error", async () => {
      mockStats.mockImplementation((cb: Function) => {
        cb(new Error("connection refused"), null, null);
      });

      await expect(
        driver.command("memcached://localhost:11211", "STATS", []),
      ).rejects.toThrow("connection refused");
    });
  });
});
