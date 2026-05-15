import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: mockQuery,
    end: mockEnd,
  })),
}));

import { driver } from "../driver.js";
import { Pool } from "pg";

describe("postgres driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
  });

  it("has id 'postgres'", () => {
    expect(driver.id).toBe("postgres");
  });

  describe("query", () => {
    it("returns rows from the query result", async () => {
      const rows = [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ];
      mockQuery.mockResolvedValue({ rows });

      const result = await driver.query("postgresql://localhost/test", "SELECT * FROM users");

      expect(result).toEqual(rows);
      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({ connectionString: expect.any(String), max: 1 }),
      );
      expect(mockQuery).toHaveBeenCalledWith("SELECT * FROM users");
    });

    it("always calls pool.end() even on error", async () => {
      mockQuery.mockRejectedValue(new Error("connection refused"));

      await expect(driver.query("postgresql://localhost/test", "SELECT 1")).rejects.toThrow(
        "connection refused",
      );
      expect(mockEnd).toHaveBeenCalled();
    });

    it("strips channel_binding from connection string", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await driver.query("postgresql://localhost/test?channel_binding=require", "SELECT 1");

      const call = vi.mocked(Pool).mock.calls[0]![0] as { connectionString: string };
      expect(call.connectionString).not.toContain("channel_binding");
    });
  });

  describe("execute", () => {
    it("returns rowCount from the query result", async () => {
      mockQuery.mockResolvedValue({ rowCount: 3 });

      const result = await driver.execute(
        "postgresql://localhost/test",
        "UPDATE users SET active = $1",
        [true],
      );

      expect(result).toBe(3);
      expect(mockQuery).toHaveBeenCalledWith("UPDATE users SET active = $1", [true]);
    });

    it("returns 0 when rowCount is null", async () => {
      mockQuery.mockResolvedValue({ rowCount: null });

      const result = await driver.execute(
        "postgresql://localhost/test",
        "UPDATE users SET x = $1",
        [1],
      );

      expect(result).toBe(0);
    });

    it("always calls pool.end() even on error", async () => {
      // The driver rewrites timeout-flavoured errors into a friendlier "this
      // instance may be unreachable" message, so assert on the rewritten text.
      mockQuery.mockRejectedValue(new Error("Connection terminated due to connection timeout"));

      await expect(
        driver.execute("postgresql://localhost/test", "DELETE FROM users WHERE id = $1", [1]),
      ).rejects.toThrow(/Couldn't connect to PostgreSQL/);
      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
