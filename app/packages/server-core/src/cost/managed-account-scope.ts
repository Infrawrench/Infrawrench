/**
 * Bulk assignment of cost centres and accounts to customers, and the
 * unassigned-spend finder.
 *
 * Both are built on one scan, {@link loadScopeSpend}: the period's spend
 * resolved to buckets the way an invoice resolves it (the org's own allocation
 * rules first, then each account claiming what no rule did). The arithmetic on
 * top is pure and lives in `client-core/managed-account-scope.ts`.
 *
 * The scan is **raw** spend on the amortized basis: no billing rule, no
 * re-rating. The question both features answer is "whose is this money",
 * which a markup does not change.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  ACCOUNT_SCOPE_BUCKET_PREFIX,
  MANAGED_ACCOUNT_LIMITS,
  applyScopeAssignment,
  classifyUnassignedSpend,
  lastFullMonth,
  previewScopeAssignment,
  type ManagedAccountAssignmentInput,
  type ManagedAccountAssignmentPreview,
  type ScopeAccount,
  type ScopeCentre,
  type ScopeOwner,
  type ScopeSpendBucket,
  type UnassignedSpendReport,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, managedAccounts, managedInvoices } from "../db/schema";
import { getShowbackSpend, type ShowbackRule } from "../clickhouse/cost-readers";
import { listAllocationRules, listCostCentres } from "./allocation";
import { ManagedAccountError, listManagedAccountRows } from "./managed-accounts";

/** The longest period either feature scans, matching an invoice's limit. */
const MAX_PERIOD_DAYS = 366;

/** Resolve and check a period, defaulting to the last full month. */
export function resolveScopePeriod(
  from: string | undefined,
  to: string | undefined,
): { from: string; to: string } {
  if (!from && !to) return lastFullMonth();
  if (!from || !to) throw new ManagedAccountError("Give both ends of the period, or neither");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new ManagedAccountError("The period must be YYYY-MM-DD dates");
  }
  if (to < from) throw new ManagedAccountError("The period must not end before it starts");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw new ManagedAccountError(`The period may cover at most ${MAX_PERIOD_DAYS} days`);
  }
  return { from, to };
}

export interface ScopeSpend {
  buckets: ScopeSpendBucket[];
  centres: ScopeCentre[];
  accounts: ScopeAccount[];
}

/**
 * The period's spend per bucket: one scan, under the caller's cost
 * visibility like every other cost read (the routes refuse scoped callers
 * outright, so in practice this is the whole org).
 */
export async function loadScopeSpend(
  organizationId: string,
  from: string,
  to: string,
): Promise<ScopeSpend> {
  const [centres, rules, accountRows] = await Promise.all([
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
    db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId))
      .orderBy(asc(accounts.displayName)),
  ]);
  const centreIds = new Set(centres.map((c) => c.id));
  // The same rule list an invoice compiles: the org's rules unmodified, then
  // one rule per account appended last, so an account claims only what no
  // cost centre did. Here every account gets one, not only the ones some
  // customer names, which is what lets unclaimed spend be split by account.
  const ordered: ShowbackRule[] = rules
    .filter((r) => centreIds.has(r.costCentreId))
    .map((r) => ({ costCentreId: r.costCentreId, match: r.match }));
  for (const account of accountRows) {
    ordered.push({
      costCentreId: `${ACCOUNT_SCOPE_BUCKET_PREFIX}${account.id}`,
      match: { accountId: account.id },
    });
  }
  const rows = await getShowbackSpend(organizationId, ordered, from, to, "amortized");
  return {
    buckets: rows.map((r) => ({ bucket: r.costCentreId, currency: r.currency, amount: r.amount })),
    centres: centres.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId })),
    accounts: accountRows,
  };
}

function owners(rows: Awaited<ReturnType<typeof listManagedAccountRows>>): ScopeOwner[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    costCentreIds: r.costCentreIds,
    accountIds: r.accountIds,
  }));
}

/** Spend in the period no customer is billed for. */
export async function findUnassignedSpend(
  organizationId: string,
  period: { from?: string | undefined; to?: string | undefined } = {},
): Promise<UnassignedSpendReport> {
  const { from, to } = resolveScopePeriod(period.from, period.to);
  const [spend, customers] = await Promise.all([
    loadScopeSpend(organizationId, from, to),
    listManagedAccountRows(organizationId),
  ]);
  return classifyUnassignedSpend({
    periodFrom: from,
    periodTo: to,
    ...spend,
    owners: owners(customers),
  });
}

/** Draft invoices per customer: the ones that recompute from scope. */
async function draftCounts(organizationId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: managedInvoices.managedAccountId, count: sql<number>`count(*)::int` })
    .from(managedInvoices)
    .where(
      and(eq(managedInvoices.organizationId, organizationId), eq(managedInvoices.status, "draft")),
    )
    .groupBy(managedInvoices.managedAccountId);
  return new Map(rows.map((r) => [r.id, Number(r.count)]));
}

/** Refuse ids that are not this org's, and a target that is not a live customer. */
function assertAssignable(
  assignment: ManagedAccountAssignmentInput,
  spend: Pick<ScopeSpend, "centres" | "accounts">,
  customers: readonly ScopeOwner[],
): void {
  if (assignment.costCentreIds.length === 0 && assignment.accountIds.length === 0) {
    throw new ManagedAccountError("Choose at least one cost centre or account to assign");
  }
  if (
    assignment.managedAccountId !== null &&
    !customers.some((c) => c.id === assignment.managedAccountId)
  ) {
    throw new ManagedAccountError("That customer does not exist or has been retired");
  }
  const centreIds = new Set(spend.centres.map((c) => c.id));
  const accountIds = new Set(spend.accounts.map((a) => a.id));
  const missing = [
    ...assignment.costCentreIds.filter((id) => !centreIds.has(id)),
    ...assignment.accountIds.filter((id) => !accountIds.has(id)),
  ];
  if (missing.length > 0) {
    throw new ManagedAccountError(`Unknown cost centre or account: ${missing.join(", ")}`);
  }
}

/** What an assignment would move, with the spend that moves with it. */
export async function previewManagedAccountAssignment(
  organizationId: string,
  assignment: ManagedAccountAssignmentInput,
  period: { from?: string | undefined; to?: string | undefined } = {},
): Promise<ManagedAccountAssignmentPreview> {
  const { from, to } = resolveScopePeriod(period.from, period.to);
  const [spend, customers, drafts] = await Promise.all([
    loadScopeSpend(organizationId, from, to),
    listManagedAccountRows(organizationId),
    draftCounts(organizationId),
  ]);
  const scopeOwners = owners(customers);
  assertAssignable(assignment, spend, scopeOwners);
  return previewScopeAssignment({
    periodFrom: from,
    periodTo: to,
    assignment,
    ...spend,
    owners: scopeOwners,
    draftCounts: drafts,
  });
}

export interface AssignmentChange {
  id: string;
  name: string;
  before: { costCentreIds: string[]; accountIds: string[] };
  after: { costCentreIds: string[]; accountIds: string[] };
}

/**
 * Move cost centres and accounts onto one customer (or off every customer) in
 * one transaction.
 *
 * Every live customer row in the org is locked first, so a customer edited in
 * another tab mid-assignment either lands before (and is read here) or waits
 * and then saves over a scope that already reflects this move; there is no
 * ordering in which the same centre ends up on two customers. Exclusivity
 * holds by construction: each item is taken off whoever held it before it is
 * given to the target.
 *
 * Only drafts are affected. An approved invoice carries its own copy of the
 * scope, so moving an account cannot re-bill a period already invoiced.
 */
export async function assignManagedAccountScope(
  organizationId: string,
  assignment: ManagedAccountAssignmentInput,
): Promise<AssignmentChange[]> {
  const [centres, accountRows] = await Promise.all([
    listCostCentres(organizationId),
    db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId)),
  ]);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: managedAccounts.id,
        name: managedAccounts.name,
        costCentreIds: managedAccounts.costCentreIds,
        accountIds: managedAccounts.accountIds,
      })
      .from(managedAccounts)
      .where(
        and(eq(managedAccounts.organizationId, organizationId), isNull(managedAccounts.deletedAt)),
      )
      .orderBy(asc(managedAccounts.id))
      .for("update");
    const customers: ScopeOwner[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      costCentreIds: Array.isArray(r.costCentreIds) ? r.costCentreIds : [],
      accountIds: Array.isArray(r.accountIds) ? r.accountIds : [],
    }));
    assertAssignable(assignment, { centres, accounts: accountRows }, customers);

    const updates = applyScopeAssignment(customers, assignment);
    const changes: AssignmentChange[] = [];
    for (const update of updates) {
      if (update.costCentreIds.length > MANAGED_ACCOUNT_LIMITS.maxCostCentres) {
        throw new ManagedAccountError(
          `A managed account may name at most ${MANAGED_ACCOUNT_LIMITS.maxCostCentres} cost centres`,
        );
      }
      if (update.accountIds.length > MANAGED_ACCOUNT_LIMITS.maxAccounts) {
        throw new ManagedAccountError(
          `A managed account may name at most ${MANAGED_ACCOUNT_LIMITS.maxAccounts} cloud accounts`,
        );
      }
      const before = customers.find((c) => c.id === update.id)!;
      await tx
        .update(managedAccounts)
        .set({
          costCentreIds: update.costCentreIds,
          accountIds: update.accountIds,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedAccounts.organizationId, organizationId),
            eq(managedAccounts.id, update.id),
          ),
        );
      changes.push({
        id: update.id,
        name: before.name,
        before: { costCentreIds: [...before.costCentreIds], accountIds: [...before.accountIds] },
        after: { costCentreIds: update.costCentreIds, accountIds: update.accountIds },
      });
    }
    return changes;
  });
}
