import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapService, mapVolume } from "../mappers.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import type { KyDeployment } from "../types.js";

describe("volume capacity", () => {
  it("stores the used and maximum size the volume reports, in GB", () => {
    const vol = mapVolume({ id: "v1", name: "data", max_size: 10, cur_size: 3 }, "acct");
    expect(vol.fields["usedGb"]).toBe(3);
    expect(vol.fields["sizeGb"]).toBe(10);
  });

  it("leaves the used size out when the response has none", () => {
    const vol = mapVolume({ id: "v1", name: "data", max_size: 10 }, "acct");
    expect(vol.fields["usedGb"]).toBeUndefined();
  });
});

describe("database capacity", () => {
  const service = RESOURCE_TYPES.find((t) => t.id === "service")!;
  const decl = capacityDeclarations(service).find((d) => d.key === "dbSizeMb")!;

  function dbService(instanceType: string) {
    const latest = {
      id: "dep1",
      definition: { database: { neon_postgres: { pg_version: 17, instance_type: instanceType } } },
      database_info: {
        neon_postgres: { default_branch_logical_size: String(300 * 1_048_576) },
      },
    } as KyDeployment;
    return mapService(
      { id: "svc1", name: "db", app_id: "app1", type: "DATABASE" },
      undefined,
      latest,
      "acct",
    );
  }

  it("measures a free database's size against the 1 GB cap", () => {
    const svc = dbService("free");
    expect(svc.fields["dbSizeMb"]).toBe(300);
    expect(resolveCapacityLimit(decl.declaration.limit, svc.fields)?.limit).toBe(1000);
  });

  it("states no ceiling for a paid database type", () => {
    const svc = dbService("small");
    expect(resolveCapacityLimit(decl.declaration.limit, svc.fields)).toBeNull();
  });
});
