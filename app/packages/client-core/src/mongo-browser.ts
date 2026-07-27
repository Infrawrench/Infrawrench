/**
 * Pure helpers for the MongoDB document browser: the `executeNoSqlCommand`
 * argument lists and the value formatting used in document rows. The browser
 * itself is rendered per host (web, mobile); only this part is shared.
 *
 * Commands go through `POST /kv/command`, which forwards to the mongodb KV
 * driver — every argument is positional, hence these builders.
 */

export const MONGO_PAGE_SIZE = 25;

export interface MongoCollectionStats {
  count: number;
  size: number;
  avgObjSize: number;
  nindexes: number;
}

export interface MongoCommand {
  command: string;
  args: (string | number)[];
}

export const mongoCommands = {
  listCollections: (database: string): MongoCommand => ({
    command: "listCollections",
    args: [database],
  }),
  find: (database: string, collection: string, filter: string, skip: number, limit: number) => ({
    command: "find",
    args: [database, collection, filter, skip, limit] as (string | number)[],
  }),
  countDocuments: (database: string, collection: string, filter: string): MongoCommand => ({
    command: "countDocuments",
    args: [database, collection, filter],
  }),
  collectionStats: (database: string, collection: string): MongoCommand => ({
    command: "collectionStats",
    args: [database, collection],
  }),
  createCollection: (database: string, collection: string): MongoCommand => ({
    command: "createCollection",
    args: [database, collection],
  }),
  dropCollection: (database: string, collection: string): MongoCommand => ({
    command: "dropCollection",
    args: [database, collection],
  }),
  insertOne: (database: string, collection: string, docJson: string): MongoCommand => ({
    command: "insertOne",
    args: [database, collection, docJson],
  }),
  deleteOne: (database: string, collection: string, filterJson: string): MongoCommand => ({
    command: "deleteOne",
    args: [database, collection, filterJson],
  }),
  replaceOne: (
    database: string,
    collection: string,
    filterJson: string,
    replacementJson: string,
  ): MongoCommand => ({
    command: "replaceOne",
    args: [database, collection, filterJson, replacementJson],
  }),
};

/** Render a BSON-ish value as a short string — `{ $oid }` wrappers collapse to the id. */
export function formatMongoValue(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "object") {
    const oid = (val as Record<string, unknown>)["$oid"];
    if (typeof oid === "string") return oid;
    return JSON.stringify(val);
  }
  return String(val);
}

/** One-line preview of a document field, used in the collapsed row. */
export function formatMongoPreview(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "—";
  if (typeof val === "string") {
    return val.length > 40 ? `"${val.slice(0, 37)}..."` : `"${val}"`;
  }
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return `[${val.length}]`;
  if (typeof val === "object") {
    const keys = Object.keys(val as object);
    if (keys.length === 1 && keys[0] === "$oid") return formatMongoValue(val);
    if (keys.length === 1 && keys[0] === "$date")
      return String((val as Record<string, unknown>)["$date"]);
    return `{${keys.length}}`;
  }
  return String(val);
}

/**
 * Strip `_id` and re-serialize — the shape `replaceOne` wants, since Mongo
 * rejects a replacement that carries the immutable id.
 */
export function stripMongoId(docJson: string): string {
  const { _id: _removed, ...rest } = JSON.parse(docJson) as Record<string, unknown>;
  return JSON.stringify(rest);
}
