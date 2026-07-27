/**
 * Identifiers that mark a cost row as pushed over the HTTP API by a server
 * outside Infrawrench. Deliberately db-free (like `cost/workflow-cost-ids.ts`)
 * so read paths and tests can label these rows without pulling in the writer's
 * database and ClickHouse imports.
 *
 * See `cost/external-costs.ts` for what writes them and `cost/cost-ingest.ts`
 * for why the reserved tag matters.
 */

/** Tag key stamped on every API-pushed row. Reserved from user tags. */
export const EXTERNAL_COST_TAG = "infrawrench:source";

/** `plugin_id` for API-pushed rows — the "External" provider dimension. */
export const EXTERNAL_COST_PLUGIN_ID = "external";

/** Prefix of the synthetic `account_id` used when a row names no real account. */
const EXTERNAL_ACCOUNT_PREFIX = "external:";

/** The synthetic cost account id for a source that named no real account. */
export function externalCostAccountId(source: string): string {
  return `${EXTERNAL_ACCOUNT_PREFIX}${source}`;
}

/** Extract the source name from a synthetic cost account id, if it is one. */
export function sourceFromCostAccountId(accountId: string): string | null {
  return accountId.startsWith(EXTERNAL_ACCOUNT_PREFIX)
    ? accountId.slice(EXTERNAL_ACCOUNT_PREFIX.length)
    : null;
}
