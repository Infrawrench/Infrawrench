/**
 * Identifiers that mark a cost row as uploaded into a custom cost source.
 * Deliberately db-free (like `cost/external-cost-ids.ts`) so read paths can
 * recognise and label these rows without importing the writer.
 *
 * See `cost/custom-costs.ts` for what writes them.
 */

/** Prefix shared by a source's `plugin_id` and its synthetic account ids. */
const CUSTOM_PREFIX = "custom:";

/**
 * Tag key stamped on every uploaded row, valued with the upload's id. It is
 * what lets "delete this upload" find exactly the rows that upload wrote, and
 * (by changing `tags_hash`) keeps two uploads of one source from replacing
 * each other's rows on insert: overlap is an explicit append or replace, never
 * an accident of the ReplacingMergeTree key.
 */
export const CUSTOM_COST_UPLOAD_TAG = "infrawrench:upload";

/** `plugin_id` (the provider dimension value) for a source's rows. */
export function customCostPluginId(sourceId: string): string {
  return `${CUSTOM_PREFIX}${sourceId}`;
}

/** The source id behind a `custom:<id>` provider value, if it is one. */
export function sourceIdFromCustomPluginId(pluginId: string): string | null {
  return pluginId.startsWith(CUSTOM_PREFIX) && !pluginId.includes("/")
    ? pluginId.slice(CUSTOM_PREFIX.length)
    : null;
}

/**
 * Synthetic `account_id` for a source's rows: `custom:<id>` when the file
 * names no account, `custom:<id>/<label>` when it does.
 */
export function customCostAccountId(sourceId: string, subAccount?: string): string {
  return subAccount ? `${CUSTOM_PREFIX}${sourceId}/${subAccount}` : `${CUSTOM_PREFIX}${sourceId}`;
}

/** Split a custom-source account id back into its source and file label. */
export function parseCustomCostAccountId(
  accountId: string,
): { sourceId: string; subAccount: string | null } | null {
  if (!accountId.startsWith(CUSTOM_PREFIX)) return null;
  const rest = accountId.slice(CUSTOM_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1
    ? { sourceId: rest, subAccount: null }
    : { sourceId: rest.slice(0, slash), subAccount: rest.slice(slash + 1) };
}
