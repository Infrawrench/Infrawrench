import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { FirestoreContext } from "../firestore-handlers.js";
import {
  listFirestoreCollections,
  listFirestoreIndexes,
  listFirestoreBackupSchedules,
  listFirestoreTtlConfigs,
  listFirestoreOperations,
  fetchFirestoreRules,
  listFirestoreBackups,
  fetchFirestoreDatabaseExtras,
  fetchFirestoreUsageMetrics,
  fetchFirestoreIamBindings,
  executeFirestoreCommand,
} from "../firestore-handlers.js";

const ctx: FirestoreContext = { project: "proj", token: async () => "tok" };

function res(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:firestore-database:proj/db1",
    pluginId: "gcp",
    resourceTypeId: "firestore-database",
    accountId: "acct",
    displayName: "db1",
    fields: { name: "db1" },
    resolvedOutputs: {},
    secretStates: [],
    externalId: "proj/db1",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  } as ResourceInstance;
}

let fetchSpy: Mock;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("listFirestoreCollections", () => {
  it("paginates standard edition", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ collectionIds: ["a"], nextPageToken: "n" }))
      .mockResolvedValueOnce(json({ collectionIds: ["b"] }));
    expect(await listFirestoreCollections(ctx, res())).toEqual(["a", "b"]);
  });

  it("enterprise does single unpaginated call", async () => {
    fetchSpy.mockResolvedValueOnce(json({ collectionIds: ["x"], nextPageToken: "n" }));
    const out = await listFirestoreCollections(
      ctx,
      res({ fields: { name: "db1", databaseEdition: "ENTERPRISE" } }),
    );
    expect(out).toEqual(["x"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns [] for no db id", async () => {
    expect(await listFirestoreCollections(ctx, res({ fields: {} }))).toEqual([]);
  });

  it("400/404 returns collected; 500 throws", async () => {
    fetchSpy.mockResolvedValueOnce(json({}, 404));
    expect(await listFirestoreCollections(ctx, res())).toEqual([]);
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(listFirestoreCollections(ctx, res())).rejects.toThrow("listCollectionIds 500");
  });
});

describe("listFirestoreIndexes", () => {
  it("wildcard returns indexes", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        indexes: [
          {
            name: "projects/p/databases/db1/collectionGroups/users/indexes/i1",
            queryScope: "COLLECTION",
            state: "READY",
            fields: [
              { fieldPath: "email", order: "ASCENDING" },
              { fieldPath: "tags", arrayConfig: "CONTAINS" },
            ],
          },
        ],
      }),
    );
    const out = await listFirestoreIndexes(ctx, res());
    expect(out[0]!.collectionGroup).toBe("users");
    expect(out[0]!.fieldsDesc).toContain("email ASCENDING");
  });

  it("falls back to per-collection when wildcard empty", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ indexes: [] })) // wildcard
      .mockResolvedValueOnce(json({ collectionIds: ["users"] })) // listCollections
      .mockResolvedValueOnce(
        json({
          indexes: [
            {
              name: "projects/p/databases/db1/collectionGroups/users/indexes/i2",
              state: "READY",
              fields: [],
            },
          ],
        }),
      );
    const out = await listFirestoreIndexes(ctx, res());
    expect(out).toHaveLength(1);
  });

  it("returns [] without db id", async () => {
    expect(await listFirestoreIndexes(ctx, res({ fields: {} }))).toEqual([]);
  });
});

describe("listFirestoreBackupSchedules", () => {
  it("maps daily + weekly recurrence", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        backupSchedules: [
          {
            name: "projects/p/databases/db1/backupSchedules/s1",
            retention: "604800s",
            dailyRecurrence: {},
          },
          {
            name: "projects/p/databases/db1/backupSchedules/s2",
            retention: "1209600s",
            weeklyRecurrence: { day: "MONDAY" },
          },
        ],
      }),
    );
    const out = await listFirestoreBackupSchedules(ctx, res());
    expect(out[0]!.recurrence).toBe("Daily");
    expect(out[1]!.recurrence).toBe("Weekly (MONDAY)");
  });

  it("404 returns []; 500 throws", async () => {
    fetchSpy.mockResolvedValueOnce(json({}, 404));
    expect(await listFirestoreBackupSchedules(ctx, res())).toEqual([]);
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(listFirestoreBackupSchedules(ctx, res())).rejects.toThrow("backup schedules 500");
  });
});

describe("listFirestoreTtlConfigs", () => {
  it("wildcard returns ttl fields", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        fields: [
          {
            name: "projects/p/databases/db1/collectionGroups/sessions/fields/expireAt",
            ttlConfig: { state: "ACTIVE" },
          },
        ],
      }),
    );
    const out = await listFirestoreTtlConfigs(ctx, res());
    expect(out[0]!.fieldPath).toBe("expireAt");
    expect(out[0]!.collectionGroup).toBe("sessions");
  });

  it("returns [] without db id", async () => {
    expect(await listFirestoreTtlConfigs(ctx, res({ fields: {} }))).toEqual([]);
  });
});

describe("listFirestoreOperations", () => {
  it("maps and slices to 10", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        operations: [
          {
            name: "projects/p/databases/db1/operations/op1",
            done: false,
            metadata: {
              "@type": "type.googleapis.com/ImportDocumentsMetadata",
              operationState: "PROCESSING",
            },
          },
        ],
      }),
    );
    const out = await listFirestoreOperations(ctx, res());
    expect(out[0]!.kind).toBe("ImportDocumentsMetadata");
    expect(out[0]!.state).toBe("PROCESSING");
  });

  it("non-ok returns []", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 403 }));
    expect(await listFirestoreOperations(ctx, res())).toEqual([]);
  });
});

describe("fetchFirestoreRules", () => {
  it("resolves release then ruleset content (default db)", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ rulesetName: "projects/p/rulesets/rs1", updateTime: "2026" }))
      .mockResolvedValueOnce(json({ source: { files: [{ content: "rules_version='2';" }] } }));
    const out = await fetchFirestoreRules(ctx, res({ fields: { name: "(default)" } }));
    expect(out.content).toContain("rules_version");
    expect(out.rulesetName).toBe("projects/p/rulesets/rs1");
  });

  it("404 release returns empty", async () => {
    fetchSpy.mockResolvedValueOnce(json({}, 404));
    expect((await fetchFirestoreRules(ctx, res())).content).toBe("");
  });

  it("non-404 release error surfaces error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    expect((await fetchFirestoreRules(ctx, res())).error).toBeTruthy();
  });

  it("ruleset fetch error keeps release name", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ rulesetName: "rs1" }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const out = await fetchFirestoreRules(ctx, res());
    expect(out.rulesetName).toBe("rs1");
    expect(out.error).toBeTruthy();
  });
});

describe("listFirestoreBackups", () => {
  it("filters by database path", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        backups: [
          {
            name: "projects/p/locations/us/backups/b1",
            database: "projects/proj/databases/db1",
            snapshotTime: "2026",
            expireTime: "2026",
            state: "READY",
            stats: { sizeBytes: "1024" },
          },
          { name: "projects/p/locations/us/backups/b2", database: "projects/proj/databases/other" },
        ],
      }),
    );
    const out = await listFirestoreBackups(ctx, res());
    expect(out).toHaveLength(1);
    expect(out[0]!.sizeBytes).toBe("1024");
  });

  it("non-ok returns []", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await listFirestoreBackups(ctx, res())).toEqual([]);
  });
});

describe("fetchFirestoreDatabaseExtras", () => {
  it("maps PITR fields", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        earliestVersionTime: "2026",
        versionRetentionPeriod: "3600s",
        pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_ENABLED",
      }),
    );
    const out = await fetchFirestoreDatabaseExtras(ctx, res());
    expect(out.versionRetentionPeriod).toBe("3600s");
  });

  it("non-ok returns empty", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 404 }));
    expect((await fetchFirestoreDatabaseExtras(ctx, res())).versionRetentionPeriod).toBe("");
  });
});

describe("fetchFirestoreUsageMetrics", () => {
  it("sums metric series (native)", async () => {
    fetchSpy.mockImplementation(async () =>
      json({ timeSeries: [{ points: [{ value: { int64Value: "10" } }] }] }),
    );
    const out = await fetchFirestoreUsageMetrics(ctx, res());
    expect(out.available).toBe(true);
    expect(out.reads24h).toBe(10);
  });

  it("all-fail returns error", async () => {
    fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 }));
    const out = await fetchFirestoreUsageMetrics(ctx, res());
    expect(out.available).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it("no db id returns error", async () => {
    expect((await fetchFirestoreUsageMetrics(ctx, res({ fields: {} }))).error).toBe(
      "no database id",
    );
  });
});

describe("fetchFirestoreIamBindings", () => {
  it("filters to firestore-related roles, sorts members", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        bindings: [
          { role: "roles/datastore.user", members: ["user:b@x", "user:a@x"] },
          { role: "roles/storage.admin", members: ["user:c@x"] },
        ],
        etag: "e",
      }),
    );
    const out = await fetchFirestoreIamBindings(ctx);
    expect(out.bindings).toHaveLength(1);
    expect(out.bindings[0]!.members).toEqual(["user:a@x", "user:b@x"]);
  });

  it("non-ok surfaces error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    expect((await fetchFirestoreIamBindings(ctx)).error).toBeTruthy();
  });
});

describe("executeFirestoreCommand", () => {
  const rid = "acct:firestore-database:proj/db1";

  it("rejects bad resource ids", async () => {
    await expect(executeFirestoreCommand(ctx, "bad-id", "acct", "find", [])).rejects.toThrow(
      "Invalid Firestore",
    );
    await expect(
      executeFirestoreCommand(ctx, "acct:firestore-database:noslash", "acct", "find", []),
    ).rejects.toThrow("Malformed");
    await expect(
      executeFirestoreCommand(ctx, "acct:firestore-database:proj/", "acct", "find", []),
    ).rejects.toThrow("empty");
  });

  it("listCollections", async () => {
    fetchSpy.mockResolvedValueOnce(json({ collectionIds: ["z", "a"] }));
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "listCollections", [])) as {
      collections: string[];
    };
    expect(out.collections).toEqual(["a", "z"]);
  });

  it("find decodes documents and reports hasMore", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        documents: [
          {
            name: "projects/p/databases/db1/documents/users/d1",
            fields: {
              age: { integerValue: "30" },
              name: { stringValue: "x" },
              active: { booleanValue: true },
              tags: { arrayValue: { values: [{ stringValue: "a" }] } },
            },
          },
          { name: "projects/p/databases/db1/documents/users/d2", fields: {} },
        ],
      }),
    );
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "find", ["users", 0, 1])) as {
      documents: Array<Record<string, unknown>>;
      hasMore: boolean;
    };
    expect(out.documents[0]!.age).toBe(30);
    expect(out.documents[0]!.tags).toEqual(["a"]);
    expect(out.hasMore).toBe(true);
  });

  it("countDocuments", async () => {
    fetchSpy.mockResolvedValueOnce(
      json([{ result: { aggregateFields: { c: { integerValue: "42" } } } }]),
    );
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "countDocuments", ["users"])) as {
      count: number;
    };
    expect(out.count).toBe(42);
  });

  it("getDocument", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "n", fields: { x: { stringValue: "v" } } }));
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "getDocument", [
      "users/d1",
    ])) as Record<string, unknown>;
    expect(out.x).toBe("v");
  });

  it("insertDocument round-trips fields", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "n", fields: { n: { integerValue: "1" } } }));
    await executeFirestoreCommand(ctx, rid, "acct", "insertDocument", [
      "users",
      JSON.stringify({ n: 1, s: "x", nested: { a: 1 } }),
    ]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.fields.n).toEqual({ integerValue: "1" });
    expect(body.fields.nested.mapValue.fields.a).toEqual({ integerValue: "1" });
  });

  it("updateDocument + deleteDocument", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "n", fields: {} }));
    await executeFirestoreCommand(ctx, rid, "acct", "updateDocument", [
      "users/d1",
      JSON.stringify({ a: true }),
    ]);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("PATCH");
    fetchSpy.mockResolvedValueOnce(json({}));
    const del = (await executeFirestoreCommand(ctx, rid, "acct", "deleteDocument", [
      "users/d1",
    ])) as { ok: boolean };
    expect(del.ok).toBe(true);
  });

  it("deleteCollection requires name + deletes pages", async () => {
    await expect(
      executeFirestoreCommand(ctx, rid, "acct", "deleteCollection", [""]),
    ).rejects.toThrow("requires a collection");
    fetchSpy
      .mockResolvedValueOnce(
        json({ documents: [{ name: "projects/p/databases/db1/documents/users/d1", fields: {} }] }),
      )
      .mockResolvedValueOnce(json({})); // delete d1
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "deleteCollection", [
      "users",
    ])) as { deletedCount: number };
    expect(out.deletedCount).toBe(1);
  });

  it("createIndex + deleteIndex", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "idx1" }));
    await executeFirestoreCommand(ctx, rid, "acct", "createIndex", [
      JSON.stringify({
        collection: "users",
        fields: JSON.stringify([
          { fieldPath: "email", order: "ASCENDING" },
          { fieldPath: "tags", order: "CONTAINS" },
        ]),
        queryScope: "COLLECTION",
      }),
    ]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.fields[1].arrayConfig).toBe("CONTAINS");
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeFirestoreCommand(ctx, rid, "acct", "deleteIndex", [
      JSON.stringify({ indexName: "projects/p/.../indexes/i1" }),
    ]);
  });

  it("createBackupSchedule weekly + deleteBackupSchedule", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "s1" }));
    await executeFirestoreCommand(ctx, rid, "acct", "createBackupSchedule", [
      JSON.stringify({ recurrence: "weekly", retentionSeconds: "604800", weekDay: "TUESDAY" }),
    ]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.weeklyRecurrence.day).toBe("TUESDAY");
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeFirestoreCommand(ctx, rid, "acct", "deleteBackupSchedule", [
      JSON.stringify({ scheduleName: "fs1" }),
    ]);
  });

  it("setTtl + unsetTtl", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "f" }));
    await executeFirestoreCommand(ctx, rid, "acct", "setTtl", [
      JSON.stringify({ collectionGroup: "s", fieldPath: "exp" }),
    ]);
    fetchSpy.mockResolvedValueOnce(json({}));
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "unsetTtl", [
      JSON.stringify({ fieldFullName: "projects/p/.../fields/exp" }),
    ])) as { ok: boolean };
    expect(out.ok).toBe(true);
  });

  it("exportDocuments + importDocuments", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: "op" }));
    await executeFirestoreCommand(ctx, rid, "acct", "exportDocuments", [
      JSON.stringify({ outputUri: "gs://b", collectionIds: "users, orders" }),
    ]);
    expect(fetchSpy.mock.calls[0]![0] as string).toContain(":exportDocuments");
    fetchSpy.mockResolvedValueOnce(json({ name: "op2" }));
    await executeFirestoreCommand(ctx, rid, "acct", "importDocuments", [
      JSON.stringify({ inputUri: "gs://b" }),
    ]);
    expect(fetchSpy.mock.calls[1]![0] as string).toContain(":importDocuments");
  });

  it("deployRules patch-then-fallback to post", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ name: "projects/proj/rulesets/rs1" })) // create ruleset
      .mockResolvedValueOnce(new Response("", { status: 404 })) // patch release 404
      .mockResolvedValueOnce(json({})); // post release
    const out = (await executeFirestoreCommand(ctx, rid, "acct", "deployRules", [
      JSON.stringify({ source: "rules_version='2';" }),
    ])) as { rulesetName?: string };
    expect(out.rulesetName).toBe("projects/proj/rulesets/rs1");
    await expect(
      executeFirestoreCommand(ctx, rid, "acct", "deployRules", [JSON.stringify({ source: "" })]),
    ).rejects.toThrow("Rules source is empty");
  });

  it("grantIamRole + revokeIamMember", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ bindings: [], etag: "e" }))
      .mockResolvedValueOnce(json({}));
    await executeFirestoreCommand(ctx, rid, "acct", "grantIamRole", [
      JSON.stringify({ role: "roles/datastore.user", member: "user:a@x" }),
    ]);
    const setBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(setBody.policy.bindings[0].role).toBe("roles/datastore.user");
    await expect(
      executeFirestoreCommand(ctx, rid, "acct", "grantIamRole", [
        JSON.stringify({ role: "roles/storage.admin", member: "user:a@x" }),
      ]),
    ).rejects.toThrow("not a Firestore-related role");

    fetchSpy.mockClear();
    fetchSpy
      .mockResolvedValueOnce(
        json({
          bindings: [{ role: "roles/datastore.user", members: ["user:a@x", "user:b@x"] }],
          etag: "e",
        }),
      )
      .mockResolvedValueOnce(json({}));
    await executeFirestoreCommand(ctx, rid, "acct", "revokeIamMember", [
      JSON.stringify({ binding: "roles/datastore.user|user:a@x" }),
    ]);
    const revBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(revBody.policy.bindings[0].members).toEqual(["user:b@x"]);
  });

  it("unknown command throws", async () => {
    await expect(executeFirestoreCommand(ctx, rid, "acct", "noSuchCmd", [])).rejects.toThrow(
      "unknown command",
    );
  });
});
