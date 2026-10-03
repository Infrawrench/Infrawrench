import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockEnd = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return { query: mockQuery, end: mockEnd };
  }),
}));

import { Pool } from "pg";
import { driver, serverDriver } from "../driver.js";
import { serverPostgresConnectionStringError } from "../uri-policy.js";

describe("serverPostgresConnectionStringError", () => {
  it("accepts ordinary connection strings", () => {
    for (const cs of [
      "postgresql://user:pass@db.example.com:5432/app",
      "postgres://user:pass@db.example.com/app?sslmode=require&application_name=iw",
      "postgresql://user@db.example.com/app?sslmode=verify-full",
      "/var/run/postgresql app",
    ]) {
      expect(serverPostgresConnectionStringError(cs)).toBeNull();
    }
  });

  it.each(["sslrootcert", "sslcert", "sslkey"])("rejects %s", (key) => {
    const error = serverPostgresConnectionStringError(
      `postgresql://u:p@db.example.com/app?sslmode=require&${key}=/etc/passwd`,
    );
    expect(error).toContain(key);
    expect(error).toContain("desktop app");
  });

  it("lists every file parameter at once", () => {
    const error = serverPostgresConnectionStringError(
      "postgresql://u:p@db.example.com/app?sslcert=/a&sslkey=/b",
    );
    expect(error).toContain("sslcert, sslkey are paths");
  });

  it("sees percent-encoded keys the way pg-connection-string does", () => {
    expect(
      serverPostgresConnectionStringError("postgresql://u:p@db.example.com/app?ssl%72ootcert=/x"),
    ).toContain("sslrootcert");
  });

  it("sees parameters on a host-less URI that needs pg's dummy-host fallback", () => {
    expect(
      serverPostgresConnectionStringError("postgresql://u:p@/app?host=db.example.com&sslkey=/k"),
    ).toContain("sslkey");
  });
});

describe("postgres serverDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 });
  });

  it("refuses a file parameter before pg is constructed", async () => {
    await expect(
      serverDriver.query("postgresql://u:p@h/db?sslrootcert=/etc/hostname", "SELECT 1"),
    ).rejects.toThrow(/sslrootcert/);
    await expect(
      serverDriver.execute("postgresql://u:p@h/db?sslkey=/k", "SELECT 1", []),
    ).rejects.toThrow(/sslkey/);
    expect(Pool).not.toHaveBeenCalled();
  });

  it("passes safe connection strings through", async () => {
    await expect(serverDriver.query("postgresql://u:p@h/db", "SELECT 1")).resolves.toEqual([
      { ok: 1 },
    ]);
    expect(Pool).toHaveBeenCalledTimes(1);
  });

  it("leaves the desktop driver unrestricted", async () => {
    await expect(
      driver.query("postgresql://u:p@h/db?sslrootcert=/home/me/ca.pem", "SELECT 1"),
    ).resolves.toEqual([{ ok: 1 }]);
  });
});
