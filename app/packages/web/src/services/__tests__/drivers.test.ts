import { describe, it, expect } from "vitest";
import { sqlDrivers, kvDrivers, dockerDrivers, storageDrivers } from "../drivers";

describe("driver registry", () => {
  it("sqlDrivers contains postgres, mysql, libsql, and mysql-planetscale", () => {
    const ids = [...sqlDrivers.keys()];
    expect(ids).toContain("postgres");
    expect(ids).toContain("mysql");
    expect(ids).toContain("libsql");
    expect(ids).toContain("mysql-planetscale");
    expect(sqlDrivers.size).toBe(4);
  });

  it("kvDrivers contains redis, memcached, and mongodb", () => {
    const ids = [...kvDrivers.keys()];
    expect(ids).toContain("redis");
    expect(ids).toContain("memcached");
    expect(ids).toContain("mongodb");
    expect(kvDrivers.size).toBe(3);
  });

  it("dockerDrivers contains docker", () => {
    const ids = [...dockerDrivers.keys()];
    expect(ids).toContain("docker");
    expect(dockerDrivers.size).toBe(1);
  });

  it("storageDrivers has at least one entry", () => {
    expect(storageDrivers.size).toBeGreaterThanOrEqual(1);
  });

  it("each SQL driver has query and execute methods", () => {
    for (const [, driver] of sqlDrivers) {
      expect(typeof driver.query).toBe("function");
      expect(typeof driver.execute).toBe("function");
    }
  });

  it("each KV driver has a command method", () => {
    for (const [, driver] of kvDrivers) {
      expect(typeof driver.command).toBe("function");
    }
  });

  it("each Docker driver has a command method", () => {
    for (const [, driver] of dockerDrivers) {
      expect(typeof driver.command).toBe("function");
    }
  });
});
