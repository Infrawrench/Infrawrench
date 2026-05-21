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
 *
 * Also handles two schema-management commands invoked from the "Schema &
 * indexes" tab via `prompt-nosql-command` actions:
 *
 *  - `createIndex` → UpdateTable with a single GlobalSecondaryIndexUpdates
 *    Create entry. DynamoDB only accepts one index change per call.
 *  - `deleteIndex` → UpdateTable with a Delete entry for the named GSI.
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
        throw new Error(`Invalid JSON: ${(e as Error).message}`, { cause: e });
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
    case "createIndex": {
      const values = parsePromptFormArgs(args);
      const indexName = stringField(values, "indexName");
      const pk = stringField(values, "partitionKey");
      const pkType = stringField(values, "partitionKeyType") || "S";
      const sk = stringField(values, "sortKey");
      const skType = stringField(values, "sortKeyType") || "S";
      const projection = stringField(values, "projection") || "ALL";
      const includeRaw = stringField(values, "projectionInclude");
      if (!indexName) throw new Error("Index name is required.");
      if (!pk) throw new Error("Partition key attribute is required.");

      // DynamoDB requires every key attribute referenced by an index to be
      // declared in AttributeDefinitions. Merge the existing definitions with
      // any new ones the user added so we don't drop other indexes' attrs.
      const { Table } = await jsonCall<{
        Table: {
          AttributeDefinitions?: Array<{ AttributeName: string; AttributeType: string }>;
        };
      }>(creds, "dynamodb", "DynamoDB_20120810.DescribeTable", { TableName: tableName });
      const existingAttrs = Table.AttributeDefinitions ?? [];
      const attrMap = new Map<string, string>();
      for (const a of existingAttrs) attrMap.set(a.AttributeName, a.AttributeType);
      attrMap.set(pk, pkType);
      if (sk) attrMap.set(sk, skType);

      const KeySchema: Array<{ AttributeName: string; KeyType: string }> = [
        { AttributeName: pk, KeyType: "HASH" },
      ];
      if (sk) KeySchema.push({ AttributeName: sk, KeyType: "RANGE" });

      const Projection: Record<string, unknown> = { ProjectionType: projection };
      if (projection === "INCLUDE") {
        const cols = includeRaw
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        if (cols.length === 0) {
          throw new Error("INCLUDE projection requires at least one attribute name.");
        }
        Projection["NonKeyAttributes"] = cols;
      }

      await jsonCall(creds, "dynamodb", "DynamoDB_20120810.UpdateTable", {
        TableName: tableName,
        AttributeDefinitions: Array.from(attrMap, ([AttributeName, AttributeType]) => ({
          AttributeName,
          AttributeType,
        })),
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: indexName,
              KeySchema,
              Projection,
            },
          },
        ],
      });
      return { ok: true };
    }
    case "deleteIndex": {
      const values = parsePromptFormArgs(args);
      const indexName = stringField(values, "indexName");
      if (!indexName) throw new Error("Index name is required.");
      await jsonCall(creds, "dynamodb", "DynamoDB_20120810.UpdateTable", {
        TableName: tableName,
        GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: indexName } }],
      });
      return { ok: true };
    }
    default:
      throw new Error(`Unknown DynamoDB document-browser command: ${command}`);
  }
}

/**
 * Decode the `args` array passed by `prompt-nosql-command` actions. The host
 * sends the modal's field values as `[JSON.stringify(values)]`; this helper
 * pulls them back out as a plain string map. Returns an empty object if the
 * args don't match the expected shape so each command can validate its own
 * required fields with a clearer error message.
 */
function parsePromptFormArgs(args: (string | number)[]): Record<string, string> {
  const raw = args[0];
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v == null) continue;
        out[k] = String(v);
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}

function stringField(values: Record<string, string>, key: string): string {
  return (values[key] ?? "").trim();
}
