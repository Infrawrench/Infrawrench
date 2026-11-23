import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapPlatform } from "../mappers.js";
import { PlatformResourceType } from "../resource-types.js";

describe("file store runway", () => {
  it("stores the file store's used bytes against its capacity", () => {
    // The `fileStoreSummary` example from Get Storage Summary Info.
    const platform = mapPlatform("acct", "https://acme.jfrog.io", undefined, {
      fileStoreSummary: {
        storageType: "filesystem",
        totalSpace: "204.28 GB",
        usedSpace: "32.22 GB (15.77%)",
        freeSpace: "172.06 GB (84.23%)",
      },
    });
    const used = Number(platform.fields["fileStoreUsedBytes"]);
    const [decl] = capacityDeclarations(PlatformResourceType);
    expect(decl!.valueKey).toBe("fileStoreUsedBytes");
    const limit = resolveCapacityLimit(decl!.declaration.limit, platform.fields)!.limit;
    expect(used / limit).toBeCloseTo(0.1577, 3);
  });

  it("leaves both out without a storage summary", () => {
    const platform = mapPlatform("acct", "https://acme.jfrog.io", undefined, undefined);
    expect(platform.fields["fileStoreUsedBytes"]).toBeUndefined();
    expect(platform.fields["fileStoreTotalBytes"]).toBeUndefined();
  });
});
