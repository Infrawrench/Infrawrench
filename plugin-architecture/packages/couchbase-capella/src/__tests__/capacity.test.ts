import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapBucket } from "../mappers.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";

describe("bucket capacity", () => {
  it("stores the bucket's memory used beside its memory quota", () => {
    const bucket = mapBucket("acct", "p1", "c1", {
      id: "dHJhdmVsLXNhbXBsZQ==",
      name: "travel-sample",
      type: "couchbase",
      storageBackend: "couchstore",
      memoryAllocationInMb: 2048,
      bucketConflictResolution: "seqno",
      durabilityLevel: "none",
      replicas: 1,
      flushEnabled: false,
      timeToLiveInSeconds: 0,
      evictionPolicy: "fullEviction",
      stats: { itemCount: 63288, opsPerSecond: 12, diskUsedInMib: 410, memoryUsedInMib: 1612 },
    } as Parameters<typeof mapBucket>[3]);
    expect(bucket.fields["memoryUsedMib"]).toBe(1612);
    expect(bucket.fields["memoryAllocationInMb"]).toBe(2048);

    const type = RESOURCE_TYPES.find((t) => t.id === T.bucket)!;
    const [decl] = capacityDeclarations(type);
    expect(decl?.valueKey).toBe("memoryUsedMib");
    expect(resolveCapacityLimit(decl!.declaration.limit, bucket.fields)?.limit).toBe(2048);
  });
});
