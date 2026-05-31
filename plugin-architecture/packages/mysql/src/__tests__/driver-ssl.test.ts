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

describe("mysql driver caCert branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
  });

  it("opens connection with ssl config when caCert provided (query)", async () => {
    mockQuery.mockResolvedValue([[], []]);
    await driver.query("mysql://localhost/test", "SELECT 1", { caCert: "  PEM  " });
    expect(createConnection).toHaveBeenCalledWith({
      uri: "mysql://localhost/test",
      ssl: { ca: "PEM", rejectUnauthorized: true },
    });
  });

  it("opens connection with ssl config when caCert provided (execute)", async () => {
    mockExecute.mockResolvedValue([{ affectedRows: 1 }, []]);
    const n = await driver.execute("mysql://localhost/test", "DELETE FROM t", [], {
      caCert: "CA",
    });
    expect(n).toBe(1);
    expect(createConnection).toHaveBeenCalledWith({
      uri: "mysql://localhost/test",
      ssl: { ca: "CA", rejectUnauthorized: true },
    });
  });

  it("uses plain URI when caCert is whitespace-only", async () => {
    mockQuery.mockResolvedValue([[], []]);
    await driver.query("mysql://localhost/test", "SELECT 1", { caCert: "   " });
    expect(createConnection).toHaveBeenCalledWith("mysql://localhost/test");
  });
});
