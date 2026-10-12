import type { MongoClient } from "mongodb";
import { hostPortDialTarget, type DialTarget, type KvNodeDriver } from "@infrawrench/plugin-base";

import {
  findServerUnsafeMongoOptions,
  mongoRejectionMessage,
  serverMongoUriError,
} from "./uri-policy.js";
export { findServerUnsafeMongoOptions, serverMongoUriError } from "./uri-policy.js";

type Mongo = typeof import("mongodb");

/**
 * The driver, loaded on first use rather than with this module. Importing it
 * runs bson's `ObjectId` setup, which draws the random process id and counter
 * every ObjectId this process mints carries; a host that snapshots the
 * process after loading its drivers (the Lambda gateway on SnapStart) would
 * otherwise hand every copy the same ones.
 */
let mongo: Promise<Mongo> | undefined;
function loadMongo(): Promise<Mongo> {
  mongo ??= import("mongodb");
  return mongo;
}

/** Convert ObjectId instances to { $oid: "hex" } for JSON-safe serialization */
function serializeDoc(ObjectId: Mongo["ObjectId"], doc: unknown): unknown {
  if (doc === null || doc === undefined) return doc;
  if (doc instanceof ObjectId) return { $oid: doc.toHexString() };
  if (doc instanceof Date) return { $date: doc.toISOString() };
  if (typeof doc === "object" && doc !== null && "buffer" in doc && "byteLength" in doc)
    return { $binary: String(doc) };
  if (Array.isArray(doc)) return doc.map((item) => serializeDoc(ObjectId, item));
  if (typeof doc === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      out[k] = serializeDoc(ObjectId, v);
    }
    return out;
  }
  return doc;
}

/** Convert { $oid: "hex" } back to ObjectId for filters */
function deserializeFilter(ObjectId: Mongo["ObjectId"], filter: unknown): unknown {
  if (filter === null || filter === undefined) return filter;
  if (Array.isArray(filter)) return filter.map((item) => deserializeFilter(ObjectId, item));
  if (typeof filter === "object") {
    const obj = filter as Record<string, unknown>;
    if (typeof obj["$oid"] === "string") return new ObjectId(obj["$oid"]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deserializeFilter(ObjectId, v);
    }
    return out;
  }
  return filter;
}

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
 *   createCollection  (dbName, collectionName)          → { ok: true }
 *   dbStats           (dbName)                          → { collections, dataSize, ... }
 *   serverVersion     (dbName)                          → string
 *   collectionStats   (dbName, collectionName)          → { count, size, ... }
 *   find              (dbName, collection, filterJson, skip, limit) → document[]
 *   countDocuments    (dbName, collection, filterJson)  → number
 *   insertOne         (dbName, collection, docJson)     → { insertedId }
 *   updateOne         (dbName, collection, filterJson, updateJson) → { modifiedCount }
 *   replaceOne        (dbName, collection, filterJson, replacementJson) → { modifiedCount }
 *   deleteOne         (dbName, collection, filterJson)  → { deletedCount }
 *   deleteMany        (dbName, collection, filterJson)  → { deletedCount }
 *   dropCollection    (dbName, collectionName)          → { ok: true }
 */

// Reuse MongoClient instances per connection string to avoid session/topology churn with Atlas
const clientPool = new Map<
  string,
  { client: MongoClient; refCount: number; timer: ReturnType<typeof setTimeout> | null }
>();
const IDLE_TIMEOUT = 60_000;

function getClient({ MongoClient }: Mongo, connectionString: string): MongoClient {
  let entry = clientPool.get(connectionString);
  if (entry) {
    entry.refCount++;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return entry.client;
  }
  const client = new MongoClient(connectionString);
  entry = { client, refCount: 1, timer: null };
  clientPool.set(connectionString, entry);
  return client;
}

function releaseClient(connectionString: string) {
  const entry = clientPool.get(connectionString);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.timer = setTimeout(() => {
      clientPool.delete(connectionString);
      void entry.client.close();
    }, IDLE_TIMEOUT);
  }
}

/**
 * The seed list of a `mongodb://` string, or the SRV name a `mongodb+srv://`
 * string expands through. A percent-encoded host ending in `.sock` is a unix
 * socket. Replica-set members the seeds then advertise are discovered at
 * runtime and are not visible here.
 */
export function dialTargets(connectionString: string): DialTarget[] {
  const m = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]*)/i.exec(connectionString);
  if (!m) return [{ kind: "local", reason: "a connection string without mongodb://" }];
  const hosts = m[2]!;
  if (m[1]!.toLowerCase() === "mongodb+srv") {
    if (!hosts || hosts.includes(",") || hosts.includes(":")) {
      return [{ kind: "local", reason: "a mongodb+srv:// string without a single host name" }];
    }
    return [{ kind: "srv", name: `_mongodb._tcp.${hosts}` }];
  }
  if (!hosts) return [{ kind: "local", reason: "no host" }];
  return hosts.split(",").map((h): DialTarget => {
    const decoded = decodeURIComponent(h);
    if (decoded.startsWith("/") || decoded.endsWith(".sock")) {
      return { kind: "local", reason: "a unix socket path" };
    }
    return hostPortDialTarget(h, 27017);
  });
}

export const driver = {
  id: "mongodb",
  dialTargets,

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const mongo = await loadMongo();
    const { ObjectId } = mongo;
    const client = getClient(mongo, connectionString);

    try {
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

        case "createCollection": {
          const collName = String(args[1] ?? "");
          if (!collName) throw new Error("createCollection requires a collection name");
          await db.createCollection(collName);
          return { ok: true };
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
          const coll = db.collection(collName);
          try {
            const stats = (await db.command({ collStats: collName })) as {
              count?: number;
              size?: number;
              avgObjSize?: number;
              storageSize?: number;
              nindexes?: number;
              totalIndexSize?: number;
            };
            return {
              count: stats.count ?? 0,
              size: stats.size ?? 0,
              avgObjSize: stats.avgObjSize ?? 0,
              storageSize: stats.storageSize ?? 0,
              nindexes: stats.nindexes ?? 0,
              totalIndexSize: stats.totalIndexSize ?? 0,
            };
          } catch {
            // Atlas free-tier and restricted accounts can deny collStats; keep
            // the query surface useful with driver-level estimates.
          }
          const [count, indexes] = await Promise.all([
            coll.estimatedDocumentCount().catch(() => coll.countDocuments()),
            coll
              .indexes()
              .then((idx) => idx.length)
              .catch(() => 0),
          ]);
          return {
            count,
            size: 0,
            avgObjSize: 0,
            storageSize: 0,
            nindexes: indexes,
            totalIndexSize: 0,
          };
        }

        case "find": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("find requires a collection name");
          const filter = deserializeFilter(ObjectId, args[2] ? JSON.parse(String(args[2])) : {});
          const skip = Number(args[3] ?? 0);
          const limit = Number(args[4] ?? 50);
          const docs = await db
            .collection(collection)
            .find(filter as Record<string, unknown>)
            .skip(skip)
            .limit(limit)
            .toArray();
          return docs.map((doc) => serializeDoc(ObjectId, doc));
        }

        case "countDocuments": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("countDocuments requires a collection name");
          const filter = deserializeFilter(ObjectId, args[2] ? JSON.parse(String(args[2])) : {});
          return db.collection(collection).countDocuments(filter as Record<string, unknown>);
        }

        case "insertOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("insertOne requires a collection name");
          const doc = JSON.parse(String(args[2] ?? "{}"));
          const result = await db.collection(collection).insertOne(doc);
          return { insertedId: result.insertedId.toHexString() };
        }

        case "updateOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("updateOne requires a collection name");
          const filter = deserializeFilter(ObjectId, JSON.parse(String(args[2] ?? "{}")));
          const update = JSON.parse(String(args[3] ?? "{}"));
          const result = await db
            .collection(collection)
            .updateOne(filter as Record<string, unknown>, update);
          return { modifiedCount: result.modifiedCount, matchedCount: result.matchedCount };
        }

        case "deleteOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("deleteOne requires a collection name");
          const filter = deserializeFilter(ObjectId, JSON.parse(String(args[2] ?? "{}")));
          const result = await db
            .collection(collection)
            .deleteOne(filter as Record<string, unknown>);
          return { deletedCount: result.deletedCount };
        }

        case "deleteMany": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("deleteMany requires a collection name");
          const filter = deserializeFilter(ObjectId, JSON.parse(String(args[2] ?? "{}")));
          const result = await db
            .collection(collection)
            .deleteMany(filter as Record<string, unknown>);
          return { deletedCount: result.deletedCount };
        }

        case "dropCollection": {
          const collName = String(args[1] ?? "");
          if (!collName) throw new Error("dropCollection requires a collection name");
          await db.collection(collName).drop();
          return { ok: true };
        }

        case "replaceOne": {
          const collection = String(args[1] ?? "");
          if (!collection) throw new Error("replaceOne requires a collection name");
          const filter = deserializeFilter(ObjectId, JSON.parse(String(args[2] ?? "{}")));
          const replacement = JSON.parse(String(args[3] ?? "{}"));
          const result = await db
            .collection(collection)
            .replaceOne(filter as Record<string, unknown>, replacement);
          return { modifiedCount: result.modifiedCount, matchedCount: result.matchedCount };
        }

        case "dropDatabase": {
          await db.dropDatabase();
          return { ok: true };
        }

        default:
          throw new Error(`MongoDB driver: unknown command "${cmd}"`);
      }
    } finally {
      releaseClient(connectionString);
    }
  },
} satisfies KvNodeDriver;

/**
 * The server policy as a credential check: a user-facing message when the
 * connection string is refused, or null. This is the authoritative check the
 * server driver runs before every call, on the options as the driver itself
 * parses them; the save-time `Plugin.validateServerCredentials` hook and
 * `serverDriver.dialTargets` use the driver-free `serverMongoUriError`
 * instead, because the plugin entry also loads in the desktop renderer and
 * `dialTargets` is synchronous. A string the driver cannot parse at all is
 * left to the connection attempt to report.
 */
export async function serverMongoConnectionStringError(
  connectionString: string,
): Promise<string | null> {
  // A pooled client already holds the parsed options. Otherwise parse with a
  // throwaway client: the constructor reads and dials nothing, so a refused
  // one is simply dropped.
  let options = clientPool.get(connectionString)?.client.options;
  if (!options) {
    const { MongoClient } = await loadMongo();
    try {
      options = new MongoClient(connectionString).options;
    } catch {
      return null;
    }
  }
  return mongoRejectionMessage(findServerUnsafeMongoOptions(options));
}

/**
 * Server driver for the shared cloud pods: refuses connection strings that
 * would authenticate with the host's own identity or read local files (see
 * `./uri-policy.ts`) before the driver connects. Checked on every call, not
 * only when an account is saved, because connection strings also arrive by
 * paths that skip the account routes (desktop sync, peer integrations). The
 * desktop keeps using `driver`, where all of that is the user's own machine.
 */
export const serverDriver = {
  id: driver.id,
  dialTargets(connectionString: string): DialTarget[] {
    // The egress guard asks before `command` runs, so refuse here first, on
    // the driver-free parse; `command` repeats the check on the driver's own.
    const error = serverMongoUriError(connectionString);
    if (error) throw new Error(error);
    return dialTargets(connectionString);
  },
  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const error = await serverMongoConnectionStringError(connectionString);
    if (error) throw new Error(error);
    return driver.command(connectionString, cmd, args);
  },
} satisfies KvNodeDriver;
