import type { DbClient } from "./client";
/**
 * Shared row shapes for common queries against the desktop SQLite database.
 *
 * These mirror the `accounts` table columns in `schema.ts`, if you change
 * the schema there, update these types too.
 */

/** The full encrypted-credentials row used to load an account and decrypt its creds. */
export interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
  encrypted_credentials: string;
  credentials_iv: string;
}

export interface ResourceRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId?: string | null | undefined;
  fields?: Record<string, unknown> | undefined;
  resolvedOutputs?: Record<string, unknown> | undefined;
  parentResourceId?: string | null | undefined;
}

/**
 * Insert or refresh a resource's row. Never `INSERT OR REPLACE`: with foreign keys on,
 * that deletes the row first, and its stored secrets, pins and associations go with
 * it through their `ON DELETE CASCADE`. A column the caller has no value for keeps the
 * one it had.
 */
export async function upsertResourceRow(db: DbClient, row: ResourceRow): Promise<void> {
  const columns: Array<[string, string | null]> = [
    ["plugin_id", row.pluginId],
    ["resource_type_id", row.resourceTypeId],
    ["account_id", row.accountId],
    ["display_name", row.displayName],
    ["external_id", row.externalId ?? row.id],
    ["fields_json", JSON.stringify(row.fields ?? {})],
  ];
  if (row.resolvedOutputs) columns.push(["outputs_json", JSON.stringify(row.resolvedOutputs)]);
  if (row.parentResourceId !== undefined) {
    columns.push(["parent_resource_id", row.parentResourceId]);
  }
  const names = columns.map(([name]) => name);
  await db.execute(
    `INSERT INTO resources (id, ${names.join(", ")}, updated_at)
     VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(", ")}, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       ${names.map((name) => `${name} = excluded.${name}`).join(", ")},
       deleted_at = NULL,
       updated_at = datetime('now')`,
    [row.id, ...columns.map(([, value]) => value)],
  );
}
