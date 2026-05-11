import type { ResourceInstance, SqlTableMeta } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapD1Database(db: Record<string, unknown>, accountId: string): ResourceInstance {
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
  const cfAccountId = await api.getAccountId();
  const dbs = await api.paginate<Record<string, unknown>>(`/accounts/${cfAccountId}/d1/database`);
  return dbs.map((db) => mapD1Database(db, accountId));
}

export async function getD1Database(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const db = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/d1/database/${externalId}`,
  );
  return mapD1Database(db, accountId);
}

export async function createD1Database(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const db = await api.fetch<Record<string, unknown>>(`/accounts/${cfAccountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name: fields["name"] }),
  });
  return mapD1Database(db, accountId);
}

export async function deleteD1Database(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/d1/database/${externalId}`, { method: "DELETE" });
}

export async function executeD1Query(
  api: CloudflareApi,
  resourceId: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const externalId = resourceId.split(":").slice(2).join(":");
  const cfAccountId = await api.getAccountId();
  const start = Date.now();

  const result = await api.fetch<
    Array<{
      results?: Array<Record<string, unknown>>;
      success?: boolean;
      meta?: { duration?: number; changes?: number; rows_read?: number; rows_written?: number };
    }>
  >(`/accounts/${cfAccountId}/d1/database/${externalId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });

  const durationMs = Date.now() - start;
  const first = Array.isArray(result) ? result[0] : result;
  const rows = (first as { results?: Array<Record<string, unknown>> })?.results ?? [];
  return { rows, durationMs };
}

export async function introspectD1Database(
  api: CloudflareApi,
  resourceId: string,
): Promise<SqlTableMeta[]> {
  const externalId = resourceId.split(":").slice(2).join(":");
  const cfAccountId = await api.getAccountId();

  // Query sqlite_master for tables
  const tablesResult = await api.fetch<
    Array<{
      results?: Array<Record<string, unknown>>;
    }>
  >(`/accounts/${cfAccountId}/d1/database/${externalId}/query`, {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    }),
  });

  const first = Array.isArray(tablesResult) ? tablesResult[0] : tablesResult;
  const tables = (first as { results?: Array<Record<string, unknown>> })?.results ?? [];
  const result: SqlTableMeta[] = [];

  for (const table of tables) {
    const tableName = String(table["name"] ?? "");
    if (!tableName) continue;

    const columnsResult = await api.fetch<
      Array<{
        results?: Array<Record<string, unknown>>;
      }>
    >(`/accounts/${cfAccountId}/d1/database/${externalId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: `PRAGMA table_info('${tableName.replace(/'/g, "''")}')` }),
    });

    const firstCol = Array.isArray(columnsResult) ? columnsResult[0] : columnsResult;
    const cols = (firstCol as { results?: Array<Record<string, unknown>> })?.results ?? [];
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
