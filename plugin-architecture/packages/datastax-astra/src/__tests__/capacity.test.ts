import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { mapDatabase } from "../mappers.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";

describe("database storage capacity", () => {
  it("stores used storage beside the storage total and declares it", () => {
    const db = mapDatabase("acct", {
      id: "3c577e51-4ff5-4551-86a4-41d475c61822",
      orgId: "org",
      status: "ACTIVE",
      info: { name: "prod", cloudProvider: "AWS", region: "us-east-2", tier: "serverless" },
      storage: { nodeCount: 3, replicationFactor: 3, totalStorage: 800, usedStorage: 348 },
    });
    expect(db.fields["usedStorageGb"]).toBe(348);
    expect(db.fields["totalStorageGb"]).toBe(800);

    const type = RESOURCE_TYPES.find((t) => t.id === T.database)!;
    const [decl] = capacityDeclarations(type);
    expect(decl?.valueKey).toBe("usedStorageGb");
    expect(resolveCapacityLimit(decl!.declaration.limit, db.fields)?.limit).toBe(800);
  });

  it("leaves both out when the response has no storage block", () => {
    const db = mapDatabase("acct", { id: "x", info: { name: "x" } });
    expect(db.fields["usedStorageGb"]).toBeUndefined();
    expect(db.fields["totalStorageGb"]).toBeUndefined();
  });
});
