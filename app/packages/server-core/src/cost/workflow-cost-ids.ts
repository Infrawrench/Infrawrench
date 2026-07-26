/**
 * Identifiers that mark a cost row as workflow-reported. Deliberately db-free
 * (like `cost/dates.ts`) so read paths and tests can label these rows without
 * pulling in the writer's database and ClickHouse imports.
 *
 * See `cost/workflow-costs.ts` for what writes them and why the reserved tag
 * matters.
 */

/** Tag key stamped on every workflow-written row. Reserved from user tags. */
export const WORKFLOW_COST_TAG = "infrawrench:workflow";

/** `plugin_id` for workflow-written rows — the "Workflow" provider dimension. */
export const WORKFLOW_COST_PLUGIN_ID = "workflow";

/** Prefix of the synthetic `account_id` used when a row names no real account. */
const WORKFLOW_ACCOUNT_PREFIX = "workflow:";

/** The synthetic cost account id for a workflow that named no real account. */
export function workflowCostAccountId(workflowId: string): string {
  return `${WORKFLOW_ACCOUNT_PREFIX}${workflowId}`;
}

/** Extract the workflow id from a synthetic cost account id, if it is one. */
export function workflowIdFromCostAccountId(accountId: string): string | null {
  return accountId.startsWith(WORKFLOW_ACCOUNT_PREFIX)
    ? accountId.slice(WORKFLOW_ACCOUNT_PREFIX.length)
    : null;
}
