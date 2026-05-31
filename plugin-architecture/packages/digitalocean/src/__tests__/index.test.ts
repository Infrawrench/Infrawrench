import { describe, it, expect } from "vitest";
import * as pkg from "../index.js";

describe("package entrypoint exports", () => {
  it("re-exports the plugin, client, and resource types", () => {
    expect(pkg.plugin).toBeDefined();
    expect(pkg.DigitalOceanClient).toBeTypeOf("function");
    for (const name of [
      "ProjectResourceType",
      "DropletResourceType",
      "DOKSClusterResourceType",
      "ManagedDatabaseResourceType",
      "DatabaseUserResourceType",
      "SpacesResourceType",
      "DomainResourceType",
      "DnsRecordResourceType",
    ] as const) {
      expect(pkg[name]).toBeDefined();
    }
  });
});
