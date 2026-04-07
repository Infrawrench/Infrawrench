import { MongoClient } from "mongodb";
import type { KvNodeDriver } from "@infrawrench/plugin-base";

/**
 * MongoDB KV-style node driver.
 *
 * Command protocol:
 *   cmd = operation name
 *   args[0] = database name (always required)
 *   args[1..] = operation-specific params (JSON-encoded strings for complex values)
 *
 * Supported commands:
 *   listDatabases     (dbName)                          → { databases: [...] }
 *   listCollections   (dbName)                          → string[]
 *   dbStats           (dbName)                          → { collections, dataSize, ... }
 *   serverVersion     (dbName)                          → string
 *   collectionStats   (dbName, collectionName)          → { count, size, ... }
 *   find              (dbName, collection, filterJson, skip, limit) → document[]
 *   countDocuments    (dbName, collection, filterJson)  → number
 *   insertOne         (dbName, collection, docJson)     → { insertedId }
 *   updateOne         (dbName, collection, filterJson, updateJson) → { modifiedCount }
 *   deleteOne         (dbName, collection, filterJson)  → { deletedCount }
 *   deleteMany        (dbName, collection, filterJson)  → { deletedCount }
 */
export const driver = {
  id: "mongodb",

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const client = new MongoClient(connectionString);

    try {
      await client.connect();
      const dbName = String(args[0] ?? "test");
      const db = client.db(dbName);

      switch (cmd) {
        case "listDatabases": {
          const admin = client.db("admin");
          return admin.command({ listDatabases: 1 });
        }

        case "listCollections": {
          const collections = await db.listCollections().toArray();
          return collections.map((c) => c.name).sort();
        }

        case "dbStats": {
          return db.command({ dbStats: 1 });
        }

        case "serverVersion": {
          const info = await db.command({ buildInfo: 1 });
          return info.version ?? "";
        }

        case "collectionStats": {
          const collName = String(args[1] ?? "");
          if (!collName) throw new Error("collectionStats requires a collection name");
          // Use aggregate $collStats for modern MongoDB compatibility
          const pipeline = [
            { $collStats: { storageStats: {} } },
          ];
          try {
            const cursor = db.collection(collName).aggregate(pipeline);
            const stats = await cursor.toArray();
            const s = stats[0]?.storageStats ?? {};
            return {
              count: s.count ?? 0,
              size: s.size ?? 0,
              avgObjSize: s.avgObjSize ?? 0,
              storageSize: s.storageSize ?? 0,
              nindexes: s.nindexes ?? 0,
              totalIndexSize: s.totalIndexSize ?? 0,
            };
          } catch {
            // Fallback: use countDocuments for basic count
            const count = await db.collection(collName).countDocuments();
            return { count, size: 0, avgObjSize: 0, storageSize: 0, nindexes: 0, totalIndexSize: 0 };
          }
        }

        case "find": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("find requires a collection name");
          const filter = args[2] ? JSON.parse(String(args[2])) : {};
          const skip = Number(args[3] ?? 0);
          const limit = Number(args[4] ?? 50);
          const docs = await db
            .collection(collection)
            .find(filter)
            .skip(skip)
            .limit(limit)
            .toArray();
          return docs;
        }

        case "countDocuments": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("countDocuments requires a collection name");
          const filter = args[2] ? JSON.parse(String(args[2])) : {};
          return db.collection(collection).countDocuments(filter);
        }

        case "insertOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("insertOne requires a collection name");
          const doc = JSON.parse(String(args[2] ?? "{}"));
          const result = await db.collection(collection).insertOne(doc);
          return { insertedId: String(result.insertedId) };
        }

        case "updateOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("updateOne requires a collection name");
          const filter = JSON.parse(String(args[2] ?? "{}"));
          const update = JSON.parse(String(args[3] ?? "{}"));
          const result = await db.collection(collection).updateOne(filter, update);
          return { modifiedCount: result.modifiedCount, matchedCount: result.matchedCount };
        }

        case "deleteOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("deleteOne requires a collection name");
          const filter = JSON.parse(String(args[2] ?? "{}"));
          const result = await db.collection(collection).deleteOne(filter);
          return { deletedCount: result.deletedCount };
        }

        case "deleteMany": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("deleteMany requires a collection name");
          const filter = JSON.parse(String(args[2] ?? "{}"));
          const result = await db.collection(collection).deleteMany(filter);
          return { deletedCount: result.deletedCount };
        }

        default:
          throw new Error(`MongoDB driver: unknown command "${cmd}"`);
      }
    } finally {
      await client.close();
    }
  },
} satisfies KvNodeDriver;
