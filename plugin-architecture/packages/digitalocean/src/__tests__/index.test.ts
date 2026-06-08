import { describe, it, expect } from "vitest";
import * as pkg from "../index.js";

describe("package entrypoint exports", () => {
  it("declares optional Spaces credentials used by bucket operations", () => {
    const fields = new Map(pkg.plugin.manifest.credentialFields.map((f) => [f.key, f]));
    expect(fields.get("apiToken")?.optional).toBeUndefined();
    expect(fields.get("spacesAccessKeyId")).toMatchObject({
      sensitive: true,
      optional: true,
    });
    expect(fields.get("spacesSecretAccessKey")).toMatchObject({
      sensitive: true,
      optional: true,
    });
  });

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
