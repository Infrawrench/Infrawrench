/**
 * Postgres-side halves of cost visibility.
 *
 * ClickHouse reads are scoped by the readers themselves. What is left are the
 * objects whose figures an unattended evaluator computed and stored (budget
 * crossings, change-alert events) and the per-account rows (credits,
 * commitments) that have no cost row to test a scope against. These helpers
 * read the visibility the request established (`auth/cost-visibility.ts`) so
 * the HTTP routes and the MCP/chat tools, which share these services, behave
 * identically.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  isCostScoped,
  scopedViewerUserId,
  strictlyVisibleAccountIds,
} from "@infrawrench/server-core/cost/visibility-context";

/**
 * The extra predicate for an alerting object table (`budgets`,
 * `cost_alerts`): a scoped caller sees only the objects that evaluate as them
 * (`visibility_user_id` = caller). Undefined (no extra predicate) when the
 * caller is unrestricted.
 *
 * Objects created by an unrestricted member evaluate over the whole org, so
 * their stored crossings and live actuals are org-wide figures; a scoped
 * caller sees none of them. Their own objects evaluate inside their scope.
 */
export function visibilityOwnerCondition(
  column: PgColumn,
  organizationId: string,
): SQL | undefined {
  const viewer = scopedViewerUserId(organizationId);
  if (viewer === undefined) return undefined;
  if (viewer === null) return sql`false`;
  return eq(column, viewer);
}

/**
 * `visibility_user_id` for an object the current caller creates: the caller
 * when they are cost-scoped (so the evaluator applies their scope), null
 * (org-wide) otherwise.
 */
export function visibilityUserIdForCreate(organizationId: string): string | null {
  return scopedViewerUserId(organizationId) ?? null;
}

/**
 * Keep only items on accounts the caller may see in full. Identity for an
 * unrestricted caller.
 */
export function filterToVisibleAccounts<T>(
  organizationId: string,
  items: readonly T[],
  accountIdOf: (item: T) => string | null | undefined,
): T[] {
  const visible = strictlyVisibleAccountIds(organizationId);
  if (!visible) return [...items];
  return items.filter((item) => {
    const id = accountIdOf(item);
    return id !== null && id !== undefined && visible.has(id);
  });
}

/**
 * True when org-wide stored findings (anomalies, efficiency alerts,
 * unit-cost regressions, change cost impacts) must be withheld: they were
 * detected over every team's spend and cannot be narrowed to a scope after
 * the fact.
 */
export function withholdOrgWideFindings(organizationId: string): boolean {
  return isCostScoped(organizationId);
}
