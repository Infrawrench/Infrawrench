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

describe("mysql driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
  });

  it("has id 'mysql'", () => {
    expect(driver.id).toBe("mysql");
  });

  describe("query", () => {
    it("returns rows from query result", async () => {
      const rows = [{ id: 1, name: "alice" }];
      mockQuery.mockResolvedValue([rows, []]);

      const result = await driver.query("mysql://localhost/test", "SELECT * FROM users");

      expect(result).toEqual(rows);
      expect(createConnection).toHaveBeenCalledWith("mysql://localhost/test");
      expect(mockQuery).toHaveBeenCalledWith("SELECT * FROM users");
    });

    it("calls conn.end() even on error", async () => {
      mockQuery.mockRejectedValue(new Error("connection refused"));

      await expect(driver.query("mysql://localhost/test", "SELECT 1")).rejects.toThrow(
        "connection refused",
      );
      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    it("returns affectedRows from result", async () => {
      mockExecute.mockResolvedValue([{ affectedRows: 5 }, []]);

      const result = await driver.execute("mysql://localhost/test", "UPDATE users SET x = ?", [1]);

      expect(result).toBe(5);
      expect(mockExecute).toHaveBeenCalledWith("UPDATE users SET x = ?", [1]);
    });

    it("calls conn.end() even on error", async () => {
      mockExecute.mockRejectedValue(new Error("timeout"));

      await expect(
        driver.execute("mysql://localhost/test", "DELETE FROM users WHERE id = ?", [1]),
      ).rejects.toThrow("timeout");
      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
