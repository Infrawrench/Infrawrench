import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockInput, mockConnect, mockClose, ConnectionPool } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockInput = vi.fn();
  const mockConnect = vi.fn();
  const mockClose = vi.fn();
  const mockRequest = vi.fn(() => ({ query: mockQuery, input: mockInput }));
  const ConnectionPool = vi.fn(() => ({
    connect: mockConnect,
    close: mockClose,
    request: mockRequest,
  }));
  return { mockQuery, mockInput, mockConnect, mockClose, ConnectionPool };
});

vi.mock("mssql", () => ({
  ConnectionPool,
}));

import { driver } from "../driver.js";

const CS = "mssql://sa:p%40ss@db.example.com:1433/appdb?encrypt=true&trustServerCertificate=true";

describe("mssql driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it("has id 'mssql'", () => {
    expect(driver.id).toBe("mssql");
  });

  describe("connection string parsing", () => {
    it("parses user/password/server/port/db and options", async () => {
      mockQuery.mockResolvedValue({ recordset: [] });
      await driver.query(CS, "SELECT 1");
      expect(ConnectionPool).toHaveBeenCalledWith({
        user: "sa",
        password: "p@ss",
        server: "db.example.com",
        port: 1433,
        database: "appdb",
        options: { encrypt: true, trustServerCertificate: true },
      });
    });

    it("defaults port to 1433, database to master, encrypt true", async () => {
      mockQuery.mockResolvedValue({ recordset: [] });
      await driver.query("mssql://u:p@host/", "SELECT 1");
      expect(ConnectionPool).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 1433,
          database: "master",
          options: { encrypt: true, trustServerCertificate: false },
        }),
      );
    });

    it("encrypt=false disables encryption", async () => {
      mockQuery.mockResolvedValue({ recordset: [] });
      await driver.query("mssql://u:p@host/db?encrypt=false", "SELECT 1");
      const cfg = ConnectionPool.mock.calls[0]![0] as { options: { encrypt: boolean } };
      expect(cfg.options.encrypt).toBe(false);
    });
  });

  describe("query", () => {
    it("returns recordset", async () => {
      const rows = [{ id: 1 }];
      mockQuery.mockResolvedValue({ recordset: rows });
      const res = await driver.query(CS, "SELECT * FROM t");
      expect(res).toEqual(rows);
      expect(mockQuery).toHaveBeenCalledWith("SELECT * FROM t");
      expect(mockClose).toHaveBeenCalled();
    });

    it("returns empty array when recordset missing", async () => {
      mockQuery.mockResolvedValue({});
      expect(await driver.query(CS, "SELECT 1")).toEqual([]);
    });

    it("closes pool even on error", async () => {
      mockQuery.mockRejectedValue(new Error("boom"));
      await expect(driver.query(CS, "SELECT 1")).rejects.toThrow("boom");
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("execute", () => {
    it("binds params and returns rowsAffected[0]", async () => {
      mockQuery.mockResolvedValue({ rowsAffected: [3] });
      const n = await driver.execute(CS, "UPDATE t SET x=@p0", [42]);
      expect(n).toBe(3);
      expect(mockInput).toHaveBeenCalledWith("p0", 42);
    });

    it("returns 0 when rowsAffected empty", async () => {
      mockQuery.mockResolvedValue({ rowsAffected: [] });
      expect(await driver.execute(CS, "X", [])).toBe(0);
    });

    it("closes pool even on error", async () => {
      mockQuery.mockRejectedValue(new Error("fail"));
      await expect(driver.execute(CS, "X", [])).rejects.toThrow("fail");
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
