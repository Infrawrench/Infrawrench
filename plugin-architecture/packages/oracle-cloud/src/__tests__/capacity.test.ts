import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { autonomousStorageFields, type OciAutonomousDatabase } from "../listers.js";
import { plugin } from "../plugin.js";

const base: OciAutonomousDatabase = {
  id: "ocid1.autonomousdatabase.oc1..a",
  displayName: "orders",
  dbName: "ORDERS",
  compartmentId: "ocid1.compartment.oc1..c",
  lifecycleState: "AVAILABLE",
};

describe("autonomous database storage", () => {
  it("measures storage in use against the reserved size, in GB", () => {
    const fields = autonomousStorageFields({
      ...base,
      dataStorageSizeInTBs: 1,
      actualUsedDataStorageSizeInTBs: 0.25,
      allocatedStorageSizeInTBs: 1,
      isAutoScalingForStorageEnabled: false,
    } as OciAutonomousDatabase);
    expect(fields).toEqual({ storageUsedGb: 256, storageLimitGb: 1024 });
    const type = plugin.resourceTypes.find((t) => t.id === "autonomous-database")!;
    const [decl] = capacityDeclarations(type);
    expect(decl!.valueKey).toBe("storageUsedGb");
    expect(resolveCapacityLimit(decl!.declaration.limit, fields)?.limit).toBe(1024);
  });

  it("reads the GB fields an ECPU database reports instead", () => {
    expect(
      autonomousStorageFields({
        ...base,
        dataStorageSizeInGBs: 20,
        usedDataStorageSizeInGBs: 3,
      }),
    ).toEqual({ storageUsedGb: 3, storageLimitGb: 20 });
  });

  it("states no limit while storage auto scaling can grow the database", () => {
    expect(
      autonomousStorageFields({
        ...base,
        dataStorageSizeInTBs: 1,
        actualUsedDataStorageSizeInTBs: 0.5,
        isAutoScalingForStorageEnabled: true,
      }),
    ).toEqual({ storageUsedGb: 512 });
  });

  it("stores nothing when the summary carries no storage", () => {
    expect(autonomousStorageFields(base)).toEqual({});
  });
});
