import { describe, it, expect, vi, beforeEach } from "vitest";

const mockToArray = vi.fn();
const mockCountDocuments = vi.fn();
const mockEstimatedDocumentCount = vi.fn();
const mockInsertOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockDeleteOne = vi.fn();
const mockDeleteMany = vi.fn();
const mockIndexes = vi.fn();
const mockFind = vi.fn(() => ({
  skip: vi.fn(() => ({
    limit: vi.fn(() => ({
      toArray: mockToArray,
    })),
  })),
}));

const mockCollection = vi.fn(() => ({
  find: mockFind,
  countDocuments: mockCountDocuments,
  estimatedDocumentCount: mockEstimatedDocumentCount,
  insertOne: mockInsertOne,
  updateOne: mockUpdateOne,
  deleteOne: mockDeleteOne,
  deleteMany: mockDeleteMany,
  indexes: mockIndexes,
}));

const mockListCollections = vi.fn(() => ({
  toArray: vi.fn().mockResolvedValue([{ name: "users" }, { name: "posts" }]),
}));

const mockDbCommand = vi.fn();
const mockCreateCollection = vi.fn();

const mockDb = vi.fn(() => ({
  collection: mockCollection,
  listCollections: mockListCollections,
  command: mockDbCommand,
  createCollection: mockCreateCollection,
}));

const mockClose = vi.fn();

vi.mock("mongodb", () => ({
  MongoClient: vi.fn(() => ({
    db: mockDb,
    close: mockClose,
  })),
  ObjectId: class MockObjectId {
    private hex: string;
    constructor(hex?: string) {
      this.hex = hex ?? "507f1f77bcf86cd799439011";
    }
    toHexString() {
      return this.hex;
    }
  },
}));

import { driver } from "../driver.js";

describe("mongodb driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has id 'mongodb'", () => {
    expect(driver.id).toBe("mongodb");
  });

  describe("command", () => {
    it("listCollections returns sorted collection names", async () => {
      const result = await driver.command("mongodb://localhost/test", "listCollections", ["test"]);

      expect(result).toEqual(["posts", "users"]);
    });

    it("listDatabases calls admin command", async () => {
      mockDbCommand.mockResolvedValue({ databases: [{ name: "test" }] });

      const result = await driver.command("mongodb://localhost/test", "listDatabases", ["admin"]);

      expect(result).toEqual({ databases: [{ name: "test" }] });
    });

    it("createCollection creates a new collection", async () => {
      mockCreateCollection.mockResolvedValue(undefined);

      const result = await driver.command("mongodb://localhost/test", "createCollection", [
        "test",
        "newcoll",
      ]);

      expect(result).toEqual({ ok: true });
      expect(mockCreateCollection).toHaveBeenCalledWith("newcoll");
    });

    it("createCollection throws when no collection name given", async () => {
      await expect(
        driver.command("mongodb://localhost/test", "createCollection", ["test"]),
      ).rejects.toThrow("createCollection requires a collection name");
    });

    it("dbStats calls db command", async () => {
      mockDbCommand.mockResolvedValue({ collections: 3, dataSize: 1024 });

      const result = await driver.command("mongodb://localhost/test", "dbStats", ["test"]);

      expect(result).toEqual({ collections: 3, dataSize: 1024 });
    });

    it("serverVersion returns version string", async () => {
      mockDbCommand.mockResolvedValue({ version: "7.0.1" });

      const result = await driver.command("mongodb://localhost/test", "serverVersion", ["test"]);

      expect(result).toBe("7.0.1");
    });

    it("find returns serialized documents", async () => {
      mockToArray.mockResolvedValue([{ _id: "abc", name: "alice" }]);

      const result = await driver.command("mongodb://localhost/test", "find", [
        "test",
        "users",
        "{}",
        0,
        50,
      ]);

      expect(result).toEqual([{ _id: "abc", name: "alice" }]);
    });

    it("find throws when no collection name given", async () => {
      await expect(driver.command("mongodb://localhost/test", "find", ["test"])).rejects.toThrow(
        "find requires a collection name",
      );
    });

    it("countDocuments returns count", async () => {
      mockCountDocuments.mockResolvedValue(42);

      const result = await driver.command("mongodb://localhost/test", "countDocuments", [
        "test",
        "users",
        "{}",
      ]);

      expect(result).toBe(42);
    });

    it("insertOne returns insertedId as hex string", async () => {
      mockInsertOne.mockResolvedValue({
        insertedId: { toHexString: () => "abc123" },
      });

      const result = await driver.command("mongodb://localhost/test", "insertOne", [
        "test",
        "users",
        '{"name":"alice"}',
      ]);

      expect(result).toEqual({ insertedId: "abc123" });
    });

    it("updateOne returns modified and matched counts", async () => {
      mockUpdateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 });

      const result = await driver.command("mongodb://localhost/test", "updateOne", [
        "test",
        "users",
        '{"name":"alice"}',
        '{"$set":{"age":30}}',
      ]);

      expect(result).toEqual({ modifiedCount: 1, matchedCount: 1 });
    });

    it("deleteOne returns deletedCount", async () => {
      mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

      const result = await driver.command("mongodb://localhost/test", "deleteOne", [
        "test",
        "users",
        '{"name":"alice"}',
      ]);

      expect(result).toEqual({ deletedCount: 1 });
    });

    it("deleteMany returns deletedCount", async () => {
      mockDeleteMany.mockResolvedValue({ deletedCount: 5 });

      const result = await driver.command("mongodb://localhost/test", "deleteMany", [
        "test",
        "users",
        '{"active":false}',
      ]);

      expect(result).toEqual({ deletedCount: 5 });
    });

    it("throws for unknown commands", async () => {
      await expect(
        driver.command("mongodb://localhost/test", "dropDatabase", ["test"]),
      ).rejects.toThrow('MongoDB driver: unknown command "dropDatabase"');
    });

    it("collectionStats returns stats object", async () => {
      mockEstimatedDocumentCount.mockResolvedValue(100);
      mockIndexes.mockResolvedValue([{ name: "_id_" }, { name: "name_1" }]);

      const result = await driver.command("mongodb://localhost/test", "collectionStats", [
        "test",
        "users",
      ]);

      expect(result).toEqual(expect.objectContaining({ count: 100, nindexes: 2 }));
    });

    it("collectionStats throws when no collection name given", async () => {
      await expect(
        driver.command("mongodb://localhost/test", "collectionStats", ["test"]),
      ).rejects.toThrow("collectionStats requires a collection name");
    });
  });
});
