import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
const mockClose = vi.fn();

vi.mock("@libsql/client", () => ({
  createClient: vi.fn(() => ({
    execute: mockExecute,
    close: mockClose,
  })),
}));

import { driver } from "../driver.js";
import { createClient } from "@libsql/client";

describe("turso driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has id 'libsql'", () => {
    expect(driver.id).toBe("libsql");
  });

  describe("query", () => {
    it("returns rows mapped by column names", async () => {
      mockExecute.mockResolvedValue({
        columns: ["id", "name"],
        rows: [
          { id: 1, name: "alice" },
          { id: 2, name: "bob" },
        ],
      });

      const result = await driver.query("libsql://localhost", "SELECT * FROM users");

      expect(result).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
      expect(mockExecute).toHaveBeenCalledWith("SELECT * FROM users");
    });

    it("parses authToken from connection string URL", async () => {
      mockExecute.mockResolvedValue({ columns: [], rows: [] });

      await driver.query("libsql://myhost?authToken=secret123", "SELECT 1");

      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ authToken: "secret123" }),
      );
    });

    it("creates client without authToken when not provided", async () => {
      mockExecute.mockResolvedValue({ columns: [], rows: [] });

      await driver.query("libsql://myhost", "SELECT 1");

      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining("libsql://myhost") }),
      );
    });

    it("calls client.close() even on error", async () => {
      mockExecute.mockRejectedValue(new Error("connection refused"));

      await expect(
        driver.query("libsql://localhost", "SELECT 1"),
      ).rejects.toThrow("connection refused");
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    it("returns rowsAffected", async () => {
      mockExecute.mockResolvedValue({ rowsAffected: 5 });

      const result = await driver.execute("libsql://localhost", "UPDATE users SET x = ?", [1]);

      expect(result).toBe(5);
      expect(mockExecute).toHaveBeenCalledWith({
        sql: "UPDATE users SET x = ?",
        args: [1],
      });
    });

    it("calls client.close() even on error", async () => {
      mockExecute.mockRejectedValue(new Error("timeout"));

      await expect(
        driver.execute("libsql://localhost", "DELETE FROM t WHERE id = ?", [1]),
      ).rejects.toThrow("timeout");
      expect(mockClose).toHaveBeenCalled();
    });

    it("handles fallback when connection string is not a valid URL", async () => {
      mockExecute.mockResolvedValue({ rowsAffected: 0 });

      await driver.execute("not-a-url", "SELECT 1", []);

      expect(createClient).toHaveBeenCalledWith({ url: "not-a-url" });
    });
  });
});
