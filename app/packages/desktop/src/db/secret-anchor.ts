/**
 * A soft-deleted row for a resource a plugin stores a secret against before anything
 * has written its row, for the foreign key: rotating a credential on such a resource
 * has already killed the old one, and the route that did it writes no row of its own.
 * `null` for an id that names no account. Soft deleted, so it lists nowhere until a
 * refresh fills it in. A plugin's `setPlaintext` runs this first, on both sides of IPC.
 */
export function secretAnchorStatement(
  resourceId: string,
): { sql: string; params: string[] } | null {
  const [accountId, typeId, ...external] = resourceId.split(":");
  if (!accountId || !typeId || external.length === 0) return null;
  const externalId = external.join(":");
  return {
    sql: `INSERT INTO resources
            (id, resource_type_id, display_name, external_id, plugin_id, account_id, deleted_at)
          SELECT $1, $2, $3, $4, plugin_id, id, datetime('now') FROM accounts WHERE id = $5
          ON CONFLICT(id) DO NOTHING`,
    // `normalizeSql` makes each of these a positional `?`, so none can be used twice.
    params: [resourceId, typeId, externalId, externalId, accountId],
  };
}
