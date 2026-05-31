import { describe, it, expect, vi, beforeEach } from "vitest";

const mockToArray = vi.fn();
const mockCountDocuments = vi.fn();
const mockEstimatedDocumentCount = vi.fn();
const mockReplaceOne = vi.fn();
const mockDrop = vi.fn();
const mockIndexes = vi.fn();
const mockDropDatabase = vi.fn();
const mockFind = vi.fn(() => ({
  skip: vi.fn(() => ({
    limit: vi.fn(() => ({ toArray: mockToArray })),
  })),
}));

const mockCollection = vi.fn(() => ({
  find: mockFind,
  countDocuments: mockCountDocuments,
  estimatedDocumentCount: mockEstimatedDocumentCount,
  replaceOne: mockReplaceOne,
  drop: mockDrop,
  indexes: mockIndexes,
}));

const mockDbCommand = vi.fn();
const MongoClientCtor = vi.fn();

const mockDb = vi.fn(() => ({
  collection: mockCollection,
  command: mockDbCommand,
  dropDatabase: mockDropDatabase,
}));
const mockClose = vi.fn();

vi.mock("mongodb", () => {
  class MockObjectId {
    hex: string;
    constructor(hex?: string) {
      this.hex = hex ?? "507f1f77bcf86cd799439011";
    }
    toHexString() {
      return this.hex;
    }
  }
  return {
    MongoClient: vi.fn((cs: string) => {
      MongoClientCtor(cs);
      return { db: mockDb, close: mockClose };
    }),
    ObjectId: MockObjectId,
  };
});

import { driver } from "../driver.js";

describe("mongodb driver extra branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaceOne returns modified/matched counts", async () => {
    mockReplaceOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 });
    const res = await driver.command("mongodb://localhost/test", "replaceOne", [
      "test",
      "users",
      '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}',
      '{"name":"bob"}',
    ]);
    expect(res).toEqual({ modifiedCount: 1, matchedCount: 1 });
    // deserializeFilter should turn $oid into an ObjectId instance
    const filterArg = mockReplaceOne.mock.calls[0]![0] as { _id: { toHexString(): string } };
    expect(filterArg._id.toHexString()).toBe("507f1f77bcf86cd799439011");
  });

  it("replaceOne throws without collection", async () => {
    await expect(
      driver.command("mongodb://localhost/test", "replaceOne", ["test"]),
    ).rejects.toThrow("replaceOne requires a collection name");
  });

  it("updateOne throws without collection", async () => {
    await expect(driver.command("mongodb://localhost/test", "updateOne", ["test"])).rejects.toThrow(
      "updateOne requires a collection name",
    );
  });

  it("deleteOne throws without collection", async () => {
    await expect(driver.command("mongodb://localhost/test", "deleteOne", ["test"])).rejects.toThrow(
      "deleteOne requires a collection name",
    );
  });

  it("deleteMany throws without collection", async () => {
    await expect(
      driver.command("mongodb://localhost/test", "deleteMany", ["test"]),
    ).rejects.toThrow("deleteMany requires a collection name");
  });

  it("countDocuments throws without collection", async () => {
    await expect(
      driver.command("mongodb://localhost/test", "countDocuments", ["test"]),
    ).rejects.toThrow("countDocuments requires a collection name");
  });

  it("insertOne throws without collection", async () => {
    await expect(driver.command("mongodb://localhost/test", "insertOne", ["test"])).rejects.toThrow(
      "insertOne requires a collection name",
    );
  });

  it("dropCollection drops the collection", async () => {
    mockDrop.mockResolvedValue(true);
    const res = await driver.command("mongodb://localhost/test", "dropCollection", [
      "test",
      "users",
    ]);
    expect(res).toEqual({ ok: true });
    expect(mockDrop).toHaveBeenCalled();
  });

  it("dropCollection throws without collection name", async () => {
    await expect(
      driver.command("mongodb://localhost/test", "dropCollection", ["test"]),
    ).rejects.toThrow("dropCollection requires a collection name");
  });

  it("dropDatabase drops the db", async () => {
    mockDropDatabase.mockResolvedValue(true);
    const res = await driver.command("mongodb://localhost/test", "dropDatabase", ["test"]);
    expect(res).toEqual({ ok: true });
    expect(mockDropDatabase).toHaveBeenCalled();
  });

  it("collectionStats falls back to countDocuments when estimated fails", async () => {
    mockEstimatedDocumentCount.mockRejectedValue(new Error("no estimate"));
    mockCountDocuments.mockResolvedValue(7);
    mockIndexes.mockRejectedValue(new Error("no indexes"));
    const res = (await driver.command("mongodb://localhost/test", "collectionStats", [
      "test",
      "users",
    ])) as { count: number; nindexes: number };
    expect(res.count).toBe(7);
    expect(res.nindexes).toBe(0);
  });

  it("find serializes ObjectId, Date, and nested docs", async () => {
    const { ObjectId } = await import("mongodb");
    mockToArray.mockResolvedValue([
      {
        _id: new ObjectId("507f1f77bcf86cd799439011"),
        created: new Date("2024-01-01T00:00:00.000Z"),
        nested: { tags: ["a", "b"], n: null },
      },
    ]);
    const res = (await driver.command("mongodb://localhost/test", "find", [
      "test",
      "users",
      "{}",
      0,
      10,
    ])) as Array<Record<string, unknown>>;
    expect(res[0]!["_id"]).toEqual({ $oid: "507f1f77bcf86cd799439011" });
    expect(res[0]!["created"]).toEqual({ $date: "2024-01-01T00:00:00.000Z" });
    expect(res[0]!["nested"]).toEqual({ tags: ["a", "b"], n: null });
  });

  it("reuses pooled client for same connection string", async () => {
    mockDbCommand.mockResolvedValue({ version: "7.0" });
    await driver.command("mongodb://pooltest/db", "serverVersion", ["db"]);
    await driver.command("mongodb://pooltest/db", "serverVersion", ["db"]);
    // Constructed once, reused on the second call
    const calls = MongoClientCtor.mock.calls.filter((c) => c[0] === "mongodb://pooltest/db");
    expect(calls).toHaveLength(1);
  });

  it("defaults db name to test when arg missing", async () => {
    mockDbCommand.mockResolvedValue({ version: "7.0" });
    await driver.command("mongodb://localhost/x", "serverVersion", []);
    expect(mockDb).toHaveBeenCalledWith("test");
  });

  it("serverVersion returns empty string when version absent", async () => {
    mockDbCommand.mockResolvedValue({});
    const res = await driver.command("mongodb://localhost/test", "serverVersion", ["test"]);
    expect(res).toBe("");
  });
});
