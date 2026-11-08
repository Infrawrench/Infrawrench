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
 * Write what an edit answered, merged as `mergeResourceRow` does, and answer the id to
 * keep editing by.
 *
 * Where the answer has a different id, as a provider that makes each edit a new version
 * gives, the new id gets the row with the old row's fields, the old one is soft deleted,
 * and what was attached to it moves (`carryResourceReferences`). Mirrors
 * `supersedeResource` in server-core, which says why stored secrets do not move. An
 * answer outside `accountId` is a plugin bug: it moves nothing, and the edit's own id is
 * kept, as the cloud's update route does.
 */
export async function mirrorEditedResourceRow(
  db: DbClient,
  editedId: string,
  row: ResourceRow,
  accountId: string,
): Promise<string> {
  if (row.id === editedId) {
    await mergeResourceRow(db, row);
    return editedId;
  }
  if (!accountId || !row.id.startsWith(`${accountId}:`)) {
    console.error(`[resources] ${row.pluginId} answered an edit with an id outside the account`);
    await mergeResourceRow(db, { ...row, id: editedId, accountId });
    return editedId;
  }
  await mergeResourceRow(db, row, editedId);
  await db.execute("UPDATE resources SET deleted_at = datetime('now') WHERE id = $1", [editedId]);
  await carryResourceReferences(db, editedId, row.id, row.displayName);
  return row.id;
}

/**
 * Point what people attached to a resource at the id it now goes by: its dashboard pins,
 * its metric pings, and the output references other resources resolve from it. A record
 * of what happened (posture dismissals among them) stays with the old id. The same rule
 * as `carryResourceReferences` in server-core, over the tables the desktop has. A pin or
 * ping the new id already has wins over the old one's.
 */
export async function carryResourceReferences(
  db: DbClient,
  previousId: string,
  nextId: string,
  displayName: string,
): Promise<void> {
  if (previousId === nextId) return;
  // `electron/db.ts` turns every `$n` into a positional `?`, so each placeholder appears
  // once and in order, and a value used twice is passed twice.
  await db.execute(
    `UPDATE dashboard_pins SET resource_id = $1
     WHERE resource_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM dashboard_pins other
         WHERE other.dashboard_id = dashboard_pins.dashboard_id AND other.resource_id = $3
       )`,
    [nextId, previousId, nextId],
  );
  await db.execute(
    `UPDATE metric_pings SET resource_id = $1, resource_display_name = $2
     WHERE resource_id = $3
       AND NOT EXISTS (
         SELECT 1 FROM metric_pings other
         WHERE other.resource_id = $4 AND other.metric_label = metric_pings.metric_label
       )`,
    [nextId, displayName, previousId, nextId],
  );
  await db.execute(
    "UPDATE associations SET provider_resource_id = $1 WHERE provider_resource_id = $2",
    [nextId, previousId],
  );
  await db.execute(
    `UPDATE secret_field_states SET source_resource_id = $1, updated_at = datetime('now')
     WHERE resolution_kind = 'output-ref' AND source_resource_id = $2`,
    [nextId, previousId],
  );
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
