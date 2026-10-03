import { describe, it, expect } from "vitest";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers, storageDrivers } from "../drivers";

describe("driver registry", () => {
  it("sqlDrivers contains postgres, mysql, mssql, libsql, and mysql-planetscale", () => {
    const ids = [...sqlDrivers.keys()];
    expect(ids).toContain("postgres");
    expect(ids).toContain("mysql");
    expect(ids).toContain("mssql");
    expect(ids).toContain("libsql");
    expect(ids).toContain("mysql-planetscale");
    expect(sqlDrivers.size).toBe(5);
  });

  it("kvDrivers contains redis, memcached, mongodb, and kafka", () => {
    const ids = [...kvDrivers.keys()];
    expect(ids).toContain("redis");
    expect(ids).toContain("memcached");
    expect(ids).toContain("mongodb");
    expect(ids).toContain("kafka");
    expect(kvDrivers.size).toBe(4);
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

  it("the kubernetes driver is the server one, which refuses exec kubeconfigs", async () => {
    const driver = k8sDrivers.get("kubernetes");
    const kubeconfig = [
      "clusters: [{ name: c, cluster: { server: 'https://127.0.0.1:1' } }]",
      "users: [{ name: u, user: { exec: { command: /bin/true } } }]",
      "contexts: [{ name: x, context: { cluster: c, user: u } }]",
      "current-context: x",
    ].join("\n");
    await expect(driver!.command(kubeconfig, "getVersion")).rejects.toThrow(
      /users\[0\]\.user\.exec/,
    );
  });

  it("the postgres driver is the server one, on every path including the read-only one", async () => {
    const driver = sqlDrivers.get("postgres")!;
    expect(driver.dialTargets?.("postgresql://u:p@db.example.com/app")).toEqual([
      { kind: "host", host: "db.example.com", port: 5432 },
    ]);
    // sql_query relies on queryReadOnly; the server wrapper must keep it.
    expect(typeof driver.queryReadOnly).toBe("function");
    const unsafe = "postgresql://u:p@127.0.0.1:1/db?sslrootcert=/etc/hostname";
    await expect(driver.query(unsafe, "SELECT 1")).rejects.toThrow(/sslrootcert/);
    await expect(driver.queryReadOnly!(unsafe, "SELECT 1")).rejects.toThrow(/sslrootcert/);
    await expect(driver.execute(unsafe, "SELECT 1", [])).rejects.toThrow(/sslrootcert/);
  });

  it("the mongodb driver is the server one, which refuses host-identity auth", async () => {
    const driver = kvDrivers.get("mongodb")!;
    expect(driver.dialTargets?.("mongodb://u:p@db.example.com/app")).toEqual([
      { kind: "host", host: "db.example.com", port: 27017 },
    ]);
    await expect(
      driver.command("mongodb://127.0.0.1:1/?authMechanism=MONGODB-AWS", "listCollections", [
        "app",
      ]),
    ).rejects.toThrow(/MONGODB-AWS/);
  });
});
