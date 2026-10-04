/**
 * The cost visibility of the principal the current execution runs for.
 *
 * ## Why an ambient store and not a parameter
 *
 * A cost visibility scope has to hold on every surface that reads cost rows:
 * the query route, reports, dashboard widgets, budgets, showback, unit costs,
 * forecasts, the chat agent, MCP tools, custom graphs, the CLI. Those reach
 * ClickHouse through a few dozen service functions that all take a bare
 * `organizationId`, and threading a scope argument through every one of them
 * would be a large diff whose failure mode is silent: a missed call site reads
 * the whole org and looks perfectly fine.
 *
 * So the scope rides an `AsyncLocalStorage`, established once per request by
 * the org-tree middleware (and once per tool call, Slack command and
 * unattended object evaluation), and the **readers** apply it: every
 * `cost_daily` predicate is built by `costDailyOrgCondition` in
 * `clickhouse/cost-readers.ts`, which consults {@link costVisibilityLayersFor}.
 * A cost route added next year is scoped without anybody remembering to scope
 * it, which is the property a per-route check can never have.
 *
 * ## What "no store" means
 *
 * Unrestricted. The poller's evaluators, exports and the digest run outside
 * any request and must see the whole org; that is their job. Every *request*
 * path establishes a store (scoped or explicitly unrestricted) before any
 * handler runs, and the route-enumeration test in the web package asserts the
 * scope reaches the readers on every cost route.
 *
 * ## Mismatched org
 *
 * A store for org A while reading org B throws. Nothing legitimate does that
 * (MCP's `org_id` and multi-org Slack commands each establish their own store
 * per org) so it can only be a bug, and the safe answer to a bug here is an
 * error rather than either org's data.
 *
 * This module is deliberately db-free so the readers and the tests can import
 * it without opening a connection.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AllocationRuleMatch,
  CostFilter,
  CostVisibilitySource,
  CostVisibilitySummary,
} from "@infrawrench/client-core";

/**
 * One scope, compiled for the readers. Every layer that applies to a request
 * must match a row for the row to be visible (intersection).
 */
export interface CompiledCostVisibilityLayer {
  /** Where the layer came from, for `/team/me` and error messages. */
  source: CostVisibilitySource;
  /** Rows on these accounts match. */
  accountIds: string[];
  /**
   * Rows the allocation rules resolve to these centres match. Already
   * expanded to include every descendant centre: scoping someone to
   * "Engineering" means its sub-centres too.
   */
  costCentreIds: string[];
  /** The org's allocation rules in evaluation order; empty when no centres. */
  rules: Array<{ costCentreId: string; match: AllocationRuleMatch }>;
  /** The saved filter's conditions, ANDed on; null when the scope has none. */
  filters: CostFilter[] | null;
  /**
   * The scope names a saved filter that no longer resolves. The layer then
   * matches nothing: dropping the filter would widen the scope.
   */
  unresolvable: boolean;
}

export type CostVisibility =
  | { organizationId: string; restricted: false }
  | {
      organizationId: string;
      restricted: true;
      /**
       * The person the scope belongs to (an API key's owner, a claimed agent's
       * claimer). Services use it to show a scoped caller only the alerting
       * objects that evaluate as them; see `scopedViewerUserId`.
       */
      userId: string | null;
      layers: CompiledCostVisibilityLayer[];
    };

const storage = new AsyncLocalStorage<CostVisibility>();

/** Run `fn` with `visibility` applied to every cost read it makes. */
export function runWithCostVisibility<T>(visibility: CostVisibility, fn: () => T): T {
  return storage.run(visibility, fn);
}

/** The visibility in force for the current execution, if any was established. */
export function currentCostVisibility(): CostVisibility | undefined {
  return storage.getStore();
}

/** An unrestricted visibility for `organizationId`. */
export function unrestrictedCostVisibility(organizationId: string): CostVisibility {
  return { organizationId, restricted: false };
}

/**
 * A visibility that matches no cost rows at all: the answer for a principal
 * with no membership, which must fail closed rather than read as "no scope".
 */
export function emptyCostVisibility(
  organizationId: string,
  userId: string | null = null,
): CostVisibility {
  return {
    organizationId,
    restricted: true,
    userId,
    layers: [
      {
        source: {
          kind: "member",
          label: null,
          costCentreIds: [],
          accountIds: [],
          savedFilterId: null,
        },
        accountIds: [],
        costCentreIds: [],
        rules: [],
        filters: null,
        unresolvable: true,
      },
    ],
  };
}

/**
 * The layers a reader must apply for `organizationId`, or null when the
 * current execution may see everything.
 *
 * @throws when the established visibility belongs to a different org.
 */
export function costVisibilityLayersFor(
  organizationId: string,
): CompiledCostVisibilityLayer[] | null {
  const store = storage.getStore();
  if (!store) return null;
  if (store.organizationId !== organizationId) {
    throw new Error(
      `Cost visibility was established for organization ${store.organizationId} ` +
        `but a cost read targeted ${organizationId}; refusing to read either.`,
    );
  }
  return store.restricted ? store.layers : null;
}

/**
 * For a scoped execution, the user the scope belongs to; null when the
 * execution is unrestricted.
 *
 * Objects that store figures computed by an unattended evaluator (budgets,
 * change alerts) are only shown to a scoped caller when they evaluate as that
 * caller (`visibility_user_id`), because their stored crossings were computed
 * over whatever the *evaluating* principal can see.
 */
export function scopedViewerUserId(organizationId: string): string | null | undefined {
  const store = storage.getStore();
  if (!store || !store.restricted) return undefined;
  if (store.organizationId !== organizationId) {
    throw new Error(
      `Cost visibility was established for organization ${store.organizationId} ` +
        `but a cost read targeted ${organizationId}; refusing to read either.`,
    );
  }
  return store.userId;
}

/** True when the current execution is cost-scoped for `organizationId`. */
export function isCostScoped(organizationId: string): boolean {
  return costVisibilityLayersFor(organizationId) !== null;
}

/**
 * Accounts whose *every* cost row the current execution may see, or null when
 * unrestricted.
 *
 * For data that is per account rather than per cost row (credits,
 * commitments, network-flow estimates, collection status) there is no row to
 * test a cost centre or a saved filter against, so only an explicit account
 * grant can make an account's figures visible. A layer that carries a saved
 * filter or names only cost centres contributes no accounts, and the layers
 * intersect, so the strict set is always a subset of what the rows allow.
 */
export function strictlyVisibleAccountIds(organizationId: string): Set<string> | null {
  const layers = costVisibilityLayersFor(organizationId);
  if (!layers) return null;
  let result: Set<string> | null = null;
  for (const layer of layers) {
    const own = new Set<string>(
      layer.unresolvable || layer.filters !== null ? [] : layer.accountIds,
    );
    if (result === null) {
      result = own;
    } else {
      const prev: Set<string> = result;
      result = new Set([...prev].filter((id) => own.has(id)));
    }
  }
  return result ?? new Set<string>();
}

/**
 * Every centre id in `roots`' subtrees, roots included. Scoping someone to a
 * parent centre means its children: "what does Engineering cost" is the
 * subtree everywhere else in the product (showback's `subtreeTotals`).
 */
export function expandCentreSubtrees(
  roots: readonly string[],
  centres: ReadonlyArray<{ id: string; parentId: string | null }>,
): string[] {
  const known = new Set(centres.map((c) => c.id));
  const children = new Map<string, string[]>();
  for (const c of centres) {
    if (!c.parentId) continue;
    const list = children.get(c.parentId) ?? [];
    list.push(c.id);
    children.set(c.parentId, list);
  }
  const out = new Set<string>();
  const stack = roots.filter((id) => known.has(id));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return [...out];
}

/** The `/team/me` summary of a visibility. */
export function summarizeCostVisibility(visibility: CostVisibility): CostVisibilitySummary {
  if (!visibility.restricted) return { restricted: false, sources: [] };
  return { restricted: true, sources: visibility.layers.map((l) => l.source) };
}
