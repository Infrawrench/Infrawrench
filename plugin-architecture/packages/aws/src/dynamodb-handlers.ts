/**
 * DynamoDB document-browser command handlers.
 *
 * Implements the same command set as the Firestore NoSQL browser so the host
 * can render a Firestore-style document explorer over a DynamoDB table:
 *
 *  - `listCollections` → returns the single table name (DynamoDB resources are
 *    one table; the Firestore "collections" sidebar shows just this one).
 *  - `find` → Scans the table page-by-page. The browser passes (collection,
 *    skip, limit); since DynamoDB's pagination is cursor-based (ExclusiveStartKey),
 *    we Scan with `Limit = skip + limit` and slice off the first `skip` items.
 *    Each returned document carries a synthetic `_name` field encoding its
 *    composite primary key, which downstream commands (get/update/delete) decode
 *    back into the Key map.
 *  - `countDocuments` → DescribeTable.ItemCount (approximate, updated ~every 6h)
 *    rather than a full Scan with Select=COUNT (which costs RCUs proportional to
 *    table size).
 *  - `getDocument` / `insertDocument` / `updateDocument` / `deleteDocument` →
 *    map to GetItem / PutItem / PutItem / DeleteItem on the underlying table.
 */
import type { AwsCredentials } from "./auth.js";
import { jsonCall } from "./client-transport.js";

/** DynamoDB AttributeValue: {S: "..."} | {N: "..."} | {BOOL: ...} | {NULL: true} | {L: [...]} | {M: {...}} | {SS: [...]} | {NS: [...]} | {B: "base64"} */
type AttributeValue = Record<string, unknown>;

interface TableSchema {
  partitionKey: string;
  sortKey?: string;
}

const KEY_SEP = "::";

function encodeKey(item: Record<string, AttributeValue>, schema: TableSchema): string {
  const pk = stringifyAttr(item[schema.partitionKey]);
  if (!schema.sortKey) return pk;
  const sk = stringifyAttr(item[schema.sortKey]);
  return `${pk}${KEY_SEP}${sk}`;
}

function decodeKey(encoded: string, schema: TableSchema): Record<string, AttributeValue> {
  if (!schema.sortKey) {
    return { [schema.partitionKey]: { S: encoded } };
  }
  const idx = encoded.indexOf(KEY_SEP);
  if (idx === -1) {
    // No separator — treat whole thing as partition key and assume sort key is empty string.
    return { [schema.partitionKey]: { S: encoded }, [schema.sortKey]: { S: "" } };
  }
  return {
    [schema.partitionKey]: { S: encoded.slice(0, idx) },
    [schema.sortKey]: { S: encoded.slice(idx + KEY_SEP.length) },
  };
}

/** Render an AttributeValue back to a JS value for display / encoding. */
function attrToJs(v: AttributeValue | undefined): unknown {
  if (!v) return null;
  if ("S" in v) return v["S"];
  if ("N" in v) return Number(v["N"]);
  if ("BOOL" in v) return v["BOOL"];
  if ("NULL" in v) return null;
  if ("L" in v) return (v["L"] as AttributeValue[]).map(attrToJs);
  if ("M" in v) {
    const out: Record<string, unknown> = {};
    for (const [k, av] of Object.entries(v["M"] as Record<string, AttributeValue>)) {
      out[k] = attrToJs(av);
    }
    return out;
  }
  if ("SS" in v) return v["SS"];
  if ("NS" in v) return (v["NS"] as string[]).map(Number);
  if ("BS" in v) return v["BS"];
  if ("B" in v) return v["B"];
  return v;
}

/** JS value → DynamoDB AttributeValue. Mirrors AWS.DynamoDB.Converter.marshall basics. */
function jsToAttr(v: unknown): AttributeValue {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(jsToAttr) };
  if (typeof v === "object") {
    const out: Record<string, AttributeValue> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = jsToAttr(x);
    return { M: out };
  }
  return { S: String(v) };
}

function stringifyAttr(v: AttributeValue | undefined): string {
  if (!v) return "";
  const js = attrToJs(v);
  return typeof js === "string" ? js : String(js ?? "");
}

function itemToDoc(
  item: Record<string, AttributeValue>,
  schema: TableSchema,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) doc[k] = attrToJs(v);
  // Synthetic `_name` for the Firestore-style browser's identity field.
  doc["_name"] = encodeKey(item, schema);
  return doc;
}

async function describeTable(
  creds: AwsCredentials,
  tableName: string,
): Promise<{ schema: TableSchema; itemCount: number }> {
  const data = await jsonCall<{ Table: Record<string, unknown> }>(
    creds,
    "dynamodb",
    "DynamoDB_20120810.DescribeTable",
    { TableName: tableName },
  );
  const t = data.Table;
  const ks = (t["KeySchema"] as Array<Record<string, string>> | undefined) ?? [];
  const partitionKey = ks.find((k) => k["KeyType"] === "HASH")?.["AttributeName"] ?? "";
  const sortKey = ks.find((k) => k["KeyType"] === "RANGE")?.["AttributeName"];
  if (!partitionKey) throw new Error(`DynamoDB table ${tableName} has no partition key`);
  return {
    schema: sortKey ? { partitionKey, sortKey } : { partitionKey },
    itemCount: Number(t["ItemCount"] ?? 0),
  };
}

export async function executeDynamoDbCommand(
  creds: AwsCredentials,
  tableName: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  if (!tableName) throw new Error("DynamoDB resource has no table name");

  switch (command) {
    case "listCollections": {
      return { collections: [tableName] };
    }
    case "countDocuments": {
      const { itemCount } = await describeTable(creds, tableName);
      // DescribeTable returns an estimate updated roughly every 6 hours. The
      // Firestore browser displays "~N items" which is honest given the lag.
      return { count: itemCount };
    }
    case "find": {
      const skip = Number(args[1] ?? 0);
      const limit = Number(args[2] ?? 25);
      const { schema } = await describeTable(creds, tableName);
      // We can't `skip` server-side; over-fetch and slice. For small skips this
      // is fine; for large tables consumers should rely on key-based filters
      // rather than paging deep into a Scan.
      const data = await jsonCall<{
        Items?: Array<Record<string, AttributeValue>>;
        LastEvaluatedKey?: Record<string, AttributeValue>;
      }>(creds, "dynamodb", "DynamoDB_20120810.Scan", {
        TableName: tableName,
        Limit: skip + limit + 1,
      });
      const items = data.Items ?? [];
      const slice = items.slice(skip, skip + limit);
      return {
        documents: slice.map((it) => itemToDoc(it, schema)),
        hasMore: items.length > skip + limit || data.LastEvaluatedKey != null,
      };
    }
    case "getDocument": {
      const encoded = String(args[0] ?? "");
      const { schema } = await describeTable(creds, tableName);
      const Key = decodeKey(encoded, schema);
      const data = await jsonCall<{ Item?: Record<string, AttributeValue> }>(
        creds,
        "dynamodb",
        "DynamoDB_20120810.GetItem",
        { TableName: tableName, Key },
      );
      if (!data.Item) return null;
      return itemToDoc(data.Item, schema);
    }
    case "insertDocument":
    case "updateDocument": {
      // For Firestore "insertDocument" args = [collection, json]; for
      // "updateDocument" args = [docPath, json]. We treat both as PutItem.
      const json = String(args[1] ?? args[0] ?? "{}");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        throw new Error(`Invalid JSON: ${(e as Error).message}`);
      }
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Document must be a JSON object");
      }
      // Strip any `_name` field — it's synthetic, not stored on the item.
      const obj = parsed as Record<string, unknown>;
      delete obj["_name"];
      const Item: Record<string, AttributeValue> = {};
      for (const [k, v] of Object.entries(obj)) Item[k] = jsToAttr(v);
      await jsonCall(creds, "dynamodb", "DynamoDB_20120810.PutItem", {
        TableName: tableName,
        Item,
      });
      return { ok: true };
    }
    case "deleteDocument": {
      const encoded = String(args[0] ?? "");
      const { schema } = await describeTable(creds, tableName);
      const Key = decodeKey(encoded, schema);
      await jsonCall(creds, "dynamodb", "DynamoDB_20120810.DeleteItem", {
        TableName: tableName,
        Key,
      });
      return { ok: true };
    }
    case "deleteCollection": {
      // We refuse — a DynamoDB "collection" is the table itself; deletion goes
      // through the standard resource-delete flow on the detail page.
      throw new Error(
        "Cannot drop a DynamoDB collection from the document browser — use the resource Delete action to drop the whole table.",
      );
    }
    default:
      throw new Error(`Unknown DynamoDB document-browser command: ${command}`);
  }
}
