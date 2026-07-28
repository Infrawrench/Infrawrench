/**
 * Identifiers that mark a cost row as hosted-build spend from an Infrafile
 * deployment. Deliberately db-free (like `cost/workflow-cost-ids.ts` and
 * `cost/external-cost-ids.ts`) so read paths and tests can label these rows
 * without pulling in the writer's database and ClickHouse imports.
 *
 * See `cost/deployment-costs.ts` for what writes them and `cost/cost-ingest.ts`
 * for why the reserved tag matters.
 */

/** Tag key stamped on every hosted-build row. Reserved from user tags. */
export const DEPLOYMENT_COST_TAG = "infrawrench:deployment";

/** `plugin_id` for hosted-build rows — the "Deployments" provider dimension. */
export const DEPLOYMENT_COST_PLUGIN_ID = "deployment";

/** Provider-dimension display name for {@link DEPLOYMENT_COST_PLUGIN_ID}. */
export const DEPLOYMENT_COST_PROVIDER_LABEL = "Deployments";

/** `service` on every hosted-build row — what the service dimension shows. */
export const HOSTED_BUILD_SERVICE = "Hosted builds";

/** Prefix of the synthetic `account_id` hosted-build rows are grouped under. */
const DEPLOYMENT_ACCOUNT_PREFIX = "deployment:";

/**
 * The synthetic cost account id for one deployment environment.
 *
 * Per-environment rather than per-org so the account dimension answers the
 * question people actually ask of build spend — "how much is staging costing
 * us?" — without needing a tag filter.
 */
export function deploymentCostAccountId(env: string): string {
  return `${DEPLOYMENT_ACCOUNT_PREFIX}${env}`;
}

/** Extract the environment from a synthetic cost account id, if it is one. */
export function envFromCostAccountId(accountId: string): string | null {
  return accountId.startsWith(DEPLOYMENT_ACCOUNT_PREFIX)
    ? accountId.slice(DEPLOYMENT_ACCOUNT_PREFIX.length)
    : null;
}

/**
 * Labels for the synthetic `deployment:<env>` cost accounts. Like the external
 * ones and unlike workflows there is no row to look up — the environment name
 * IS the label — so this is purely local; without it the account picker shows a
 * raw `deployment:prod` id.
 */
export function deploymentCostAccountLabels(values: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const value of values) {
    const env = envFromCostAccountId(value);
    if (env) labels.set(value, `${env} (deployments)`);
  }
  return labels;
}
