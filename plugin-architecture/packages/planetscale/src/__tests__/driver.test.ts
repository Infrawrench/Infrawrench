import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockExecute = vi.fn();
const mockEnd = vi.fn();

vi.mock("mysql2/promise", () => ({
  createConnection: vi.fn(() =>
    Promise.resolve({
      query: mockQuery,
      execute: mockExecute,
      end: mockEnd,
    }),
  ),
}));

import { driver } from "../driver.js";
import { createConnection } from "mysql2/promise";

describe("planetscale driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
  });

  it("has id 'mysql-planetscale'", () => {
    expect(driver.id).toBe("mysql-planetscale");
  });

  describe("query", () => {
    it("returns rows from query result", async () => {
      const rows = [{ id: 1, name: "alice" }];
      mockQuery.mockResolvedValue([rows, []]);

      const result = await driver.query("mysql://user:pass@host/db", "SELECT * FROM users");

      expect(result).toEqual(rows);
      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: "mysql://user:pass@host/db",
          ssl: { rejectUnauthorized: true },
        }),
      );
    });

    it("calls conn.end() even on error", async () => {
      mockQuery.mockRejectedValue(new Error("connection refused"));

      await expect(
        driver.query("mysql://user:pass@host/db", "SELECT 1"),
      ).rejects.toThrow("connection refused");
      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    it("returns affectedRows from result", async () => {
      mockExecute.mockResolvedValue([{ affectedRows: 3 }, []]);

      const result = await driver.execute("mysql://user:pass@host/db", "UPDATE t SET x = ?", [1]);

      expect(result).toBe(3);
    });

    it("passes ssl config with rejectUnauthorized", async () => {
      mockExecute.mockResolvedValue([{ affectedRows: 0 }, []]);

      await driver.execute("mysql://user:pass@host/db", "DELETE FROM t WHERE id = ?", [1]);

      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: { rejectUnauthorized: true },
        }),
      );
    });

    it("calls conn.end() even on error", async () => {
      mockExecute.mockRejectedValue(new Error("timeout"));

      await expect(
        driver.execute("mysql://user:pass@host/db", "DELETE FROM t WHERE id = ?", [1]),
      ).rejects.toThrow("timeout");
      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
