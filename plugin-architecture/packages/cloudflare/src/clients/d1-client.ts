import type { ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";

/**
 * Narrow the rows of a D1 query page.
 *
 * The SDK types a page as `QueryResult` with `results?: Array<unknown>`
 * (cloudflare/resources/d1/database/database.d.ts:168) — deliberately, since
 * the row shape depends on the SQL that produced it. Every row Cloudflare
 * returns from `/query` is a JSON object, so narrow each one here and skip
 * anything that isn't rather than asserting a shape onto the whole array.
 */
function queryRows(results: Array<unknown> | undefined): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const row of results ?? []) {
    if (row !== null && typeof row === "object") rows.push(asRecord(row));
  }
  return rows;
}

function mapD1Database(db: Record<string, unknown>, accountId: string): ResourceInstance {
  const uuid = String(db["uuid"] ?? db["id"] ?? "");
  const name = String(db["name"] ?? "");
  return {
    id: `${accountId}:d1-database:${uuid}`,
    pluginId: "cloudflare",
    resourceTypeId: "d1-database",
    accountId,
    displayName: name || uuid,
    fields: {
      name,
      version: String(db["version"] ?? ""),
      numTables: Number(db["num_tables"] ?? 0),
      fileSize: String(db["file_size"] ?? ""),
      createdAt: String(db["created_at"] ?? ""),
    },
    resolvedOutputs: { databaseId: uuid },
    secretStates: [],
    externalId: uuid,
    createdAt: String(db["created_at"] ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

export async function listD1Databases(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const db of api.cf.d1.database.list({ account_id })) {
    results.push(mapD1Database(asRecord(db), accountId));
  }
  return results;
}

export async function getD1Database(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  // d1.database has no `.get(...)`; the v4 REST shape is GET /accounts/{aid}/d1/database/{id}.
  const db = await api.cf.get<unknown, Record<string, unknown>>(
    `/accounts/${account_id}/d1/database/${externalId}`,
  );
  return mapD1Database(db, accountId);
}

export async function createD1Database(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const db = await api.cf.d1.database.create({ account_id, name: fields["name"] ?? "" });
  return mapD1Database(asRecord(db), accountId);
}

export async function deleteD1Database(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.d1.database.delete(externalId, { account_id });
}

export async function executeD1Query(
  api: CloudflareApi,
  resourceId: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const externalId = resourceId.split(":").slice(2).join(":");
  const account_id = await api.getAccountId();
  const start = Date.now();

  const rows: Record<string, unknown>[] = [];
  for await (const item of api.cf.d1.database.query(externalId, { account_id, sql })) {
    rows.push(...queryRows(item.results));
  }

  return { rows, durationMs: Date.now() - start };
}

export async function introspectD1Database(
  api: CloudflareApi,
  resourceId: string,
): Promise<SqlTableMeta[]> {
  const externalId = resourceId.split(":").slice(2).join(":");
  const account_id = await api.getAccountId();

  const tables: Record<string, unknown>[] = [];
  for await (const item of api.cf.d1.database.query(externalId, {
    account_id,
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  })) {
    tables.push(...queryRows(item.results));
  }

  const result: SqlTableMeta[] = [];
  for (const table of tables) {
    const tableName = String(table["name"] ?? "");
    if (!tableName) continue;

    const cols: Record<string, unknown>[] = [];
    for await (const item of api.cf.d1.database.query(externalId, {
      account_id,
      sql: `PRAGMA table_info('${tableName.replace(/'/g, "''")}')`,
    })) {
      cols.push(...queryRows(item.results));
    }

    const pkColumns: string[] = [];
    const meta: SqlTableMeta = {
      name: tableName,
      columns: cols.map((c) => {
        const name = String(c["name"] ?? "");
        if (Number(c["pk"]) > 0) pkColumns.push(name);
        return {
          name,
          type: String(c["type"] ?? "TEXT"),
        };
      }),
    };
    if (pkColumns.length > 0) meta.pkColumns = pkColumns;
    result.push(meta);
  }

  return result;
}
