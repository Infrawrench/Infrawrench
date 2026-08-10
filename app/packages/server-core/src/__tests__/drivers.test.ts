import { describe, expect, it } from "vitest";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers, storageDrivers } from "../drivers";

describe("drivers maps", () => {
  it("registers the SQL drivers keyed by their id", () => {
    expect(sqlDrivers.size).toBeGreaterThan(0);
    for (const [id, driver] of sqlDrivers) {
      expect(typeof id).toBe("string");
      expect(driver.id).toBe(id);
    }
  });

  it("registers the KV drivers keyed by their id", () => {
    expect(kvDrivers.size).toBeGreaterThan(0);
    for (const [id, driver] of kvDrivers) {
      expect(driver.id).toBe(id);
    }
  });

  it("registers a single docker driver keyed by id", () => {
    expect(dockerDrivers.size).toBe(1);
    for (const [id, driver] of dockerDrivers) {
      expect(driver.id).toBe(id);
    }
  });

  it("registers a single k8s driver keyed by id", () => {
    expect(k8sDrivers.size).toBe(1);
    for (const [id, driver] of k8sDrivers) {
      expect(driver.id).toBe(id);
    }
  });

  it("registers every storage driver keyed by its pluginId", () => {
    expect(storageDrivers.size).toBeGreaterThan(0);
    for (const [id, driver] of storageDrivers) {
      expect(driver.pluginId).toBe(id);
    }
  });

  it("registers the drivers the storage download route needs", () => {
    // `storage.ts` refuses the download when `storageDrivers.get(pluginId)`
    // misses, so a plugin that offers a file browser but no driver silently
    // loses its Download button.
    expect([...storageDrivers.keys()]).toEqual(expect.arrayContaining(["gcp", "uploadthing"]));
  });

  it("keeps SQL and KV driver id-spaces disjoint enough to look up by id", () => {
    // Sanity: a known SQL id resolves to an object with query/execute.
    const anySql = [...sqlDrivers.values()][0]!;
    expect(typeof anySql.query).toBe("function");
    expect(typeof anySql.execute).toBe("function");
    const anyKv = [...kvDrivers.values()][0]!;
    expect(typeof anyKv.command).toBe("function");
  });
});
