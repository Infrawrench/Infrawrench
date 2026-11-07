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

/**
 * Write a plugin's answer about a resource that may already have a row: a pin, a refresh
 * of an agent VM. The fields merge into the stored ones, as the cloud's sync does: a field
 * this read could not fill keeps its value rather than vanish until the next refresh, and
 * the change timeline does not then record it as added back. A field cleared on purpose
 * is an explicit value, so it still applies. `storedId` is the row whose fields to merge
 * into, when the answer carries a different id.
 */
export async function mergeResourceRow(
  db: DbClient,
  row: ResourceRow,
  storedId: string = row.id,
): Promise<void> {
  const [stored] = await db.select<Array<{ fields_json: string | null }>>(
    "SELECT fields_json FROM resources WHERE id = $1",
    [storedId],
  );
  await upsertResourceRow(db, {
    ...row,
    fields: mergeStoredFields(stored?.fields_json, row.fields),
  });
}

/**
 * Write what an edit answered, merged as `mergeResourceRow` does.
 *
 * Where the answer has a different id, as a provider that makes each edit a new version
 * gives, the new id gets the row with the old row's fields, and the old one is soft
 * deleted. Mirrors `supersedeResource` in server-core, which says why stored secrets do
 * not move.
 */
export async function mirrorEditedResourceRow(
  db: DbClient,
  editedId: string,
  row: ResourceRow,
): Promise<void> {
  await mergeResourceRow(db, row, editedId);
  if (row.id !== editedId) {
    await db.execute("UPDATE resources SET deleted_at = datetime('now') WHERE id = $1", [editedId]);
  }
}

/** A resource's stored `fields_json` with an answer's fields laid over it. */
export function mergeStoredFields(
  storedJson: string | null | undefined,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...parseFields(storedJson), ...fields };
}

function parseFields(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
