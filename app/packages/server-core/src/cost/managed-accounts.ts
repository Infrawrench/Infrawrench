/**
 * Managed accounts — CRUD for the customers a managed service provider bills.
 *
 * The shape of this module mirrors `cost/allocation.ts` and
 * `cost/billing-rules.ts` deliberately: these are the third object in the same
 * family, they are read together by anyone working out why a customer was
 * charged what they were charged, and a reader who has seen one should not have
 * to learn a second set of conventions to read this one.
 *
 * What is *not* here is as important as what is. There is no rule matching, no
 * priority, no `match` column. A managed account names cost centres, and the
 * cost centres already know which spend is theirs. Inventing a second way to
 * claim spend would give the organisation two answers to the same question.
 *
 * Invoice generation lives next door in `cost/invoices.ts`; this file only
 * decides who exists and what they own.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  MANAGED_ACCOUNT_LIMITS,
  managedAccountScopeConflicts,
  normalizeCurrencyCode,
  type CostBasis,
  type ManagedAccount,
  type ManagedAccountInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, costCentres, managedAccounts, managedInvoices } from "../db/schema";

export type { ManagedAccount, ManagedAccountInput };
export { MANAGED_ACCOUNT_LIMITS };

/** A managed-account write the API should refuse with a 400 and this message. */
export class ManagedAccountError extends Error {
  override readonly name = "ManagedAccountError";
}

/** A name already taken in this org — the API maps this to a 409. */
export class ManagedAccountNameConflictError extends Error {
  override readonly name = "ManagedAccountNameConflictError";

  constructor(name: string) {
    super(
      `A managed account called "${name}" already exists. The name heads every invoice raised ` +
        "for this customer, so it has to be unambiguous.",
    );
  }
}

/**
 * Scope the caller asked for is already billed to someone else — 409, with the
 * other customer named, because "it conflicts" without saying with whom is a
 * message that sends the user hunting through every other customer.
 */
export class ManagedAccountScopeConflictError extends Error {
  override readonly name = "ManagedAccountScopeConflictError";

  constructor(readonly conflicts: ReturnType<typeof managedAccountScopeConflicts>) {
    const first = conflicts[0]!;
    super(
      `That ${first.kind === "account" ? "cloud account" : "cost centre"} is already billed to ` +
        `"${first.ownerName}"${conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : ""}. ` +
        "A cost centre or account belongs to exactly one customer — billing the same money " +
        "twice is not a state this can represent.",
    );
  }
}

type Row = typeof managedAccounts.$inferSelect;

function toWire(row: Row, invoiceCount: number): ManagedAccount {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    billingAddress: row.billingAddress,
    billingCurrency: row.billingCurrency,
    costBasis: row.costBasis as CostBasis,
    applyBillingRules: row.applyBillingRules,
    notes: row.notes,
    costCentreIds: Array.isArray(row.costCentreIds) ? row.costCentreIds : [],
    accountIds: Array.isArray(row.accountIds) ? row.accountIds : [],
    invoiceCount,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function trimOrNull(value: string | null | undefined, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ManagedAccountError(`${field} must be ${max} characters or fewer`);
  }
  return trimmed;
}

interface Normalized {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  billingAddress: string | null;
  billingCurrency: string;
  costBasis: CostBasis;
  applyBillingRules: boolean;
  notes: string | null;
  costCentreIds: string[];
  accountIds: string[];
}

function normalizeInput(input: ManagedAccountInput): Normalized {
  const name = String(input.name ?? "").trim();
  if (!name) throw new ManagedAccountError("name is required");
  if (name.length > MANAGED_ACCOUNT_LIMITS.maxNameLength) {
    throw new ManagedAccountError(
      `name must be ${MANAGED_ACCOUNT_LIMITS.maxNameLength} characters or fewer`,
    );
  }

  // A user typing `usd` into a currency box has not made a mistake; normalize
  // first and only refuse what is genuinely not a code, the same order
  // `billing-rules.ts` uses.
  const billingCurrency = normalizeCurrencyCode(String(input.billingCurrency ?? ""));
  if (!billingCurrency) {
    throw new ManagedAccountError("billingCurrency must be a three-letter ISO 4217 code");
  }

  const contactEmail = trimOrNull(
    input.contactEmail,
    MANAGED_ACCOUNT_LIMITS.maxContactEmailLength,
    "contactEmail",
  );
  // Deliberately shallow: this address is printed on a document, not sent to.
  // Rejecting an unusual but real address would be worse than accepting one
  // that is never delivered to, because nothing here delivers.
  if (contactEmail !== null && !contactEmail.includes("@")) {
    throw new ManagedAccountError("contactEmail must be an email address");
  }

  const dedupe = (raw: unknown, max: number, field: string): string[] => {
    const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
    const unique = [...new Set(list.map((v) => v.trim()).filter(Boolean))];
    if (unique.length > max) {
      throw new ManagedAccountError(`A managed account may name at most ${max} ${field}`);
    }
    return unique;
  };

  return {
    name,
    contactName: trimOrNull(
      input.contactName,
      MANAGED_ACCOUNT_LIMITS.maxContactNameLength,
      "contactName",
    ),
    contactEmail,
    billingAddress: trimOrNull(
      input.billingAddress,
      MANAGED_ACCOUNT_LIMITS.maxAddressLength,
      "billingAddress",
    ),
    billingCurrency,
    costBasis: input.costBasis === "cash" ? "cash" : "amortized",
    applyBillingRules: input.applyBillingRules !== false,
    notes: trimOrNull(input.notes, MANAGED_ACCOUNT_LIMITS.maxNotesLength, "notes"),
    costCentreIds: dedupe(
      input.costCentreIds,
      MANAGED_ACCOUNT_LIMITS.maxCostCentres,
      "cost centres",
    ),
    accountIds: dedupe(input.accountIds, MANAGED_ACCOUNT_LIMITS.maxAccounts, "cloud accounts"),
  };
}

/**
 * Every id in scope must be a live row in this org.
 *
 * A cross-org cost-centre id would otherwise bill one organisation's customer
 * for another organisation's spend, and a typo would produce an invoice that is
 * silently short rather than one that fails to save.
 */
async function assertScopeExists(organizationId: string, data: Normalized): Promise<void> {
  if (data.costCentreIds.length > 0) {
    const rows = await db
      .select({ id: costCentres.id })
      .from(costCentres)
      .where(eq(costCentres.organizationId, organizationId));
    const known = new Set(rows.map((r) => r.id));
    const missing = data.costCentreIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ManagedAccountError(`Unknown cost centre: ${missing.join(", ")}`);
    }
  }
  if (data.accountIds.length > 0) {
    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId));
    const known = new Set(rows.map((r) => r.id));
    const missing = data.accountIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ManagedAccountError(`Unknown account: ${missing.join(", ")}`);
    }
  }
}

/** Refuse scope another live customer already claims. */
async function assertScopeExclusive(
  organizationId: string,
  data: Normalized,
  excludeId: string | null,
): Promise<void> {
  if (data.costCentreIds.length === 0 && data.accountIds.length === 0) return;
  const others = (await listManagedAccountRows(organizationId)).filter((r) => r.id !== excludeId);
  const conflicts = managedAccountScopeConflicts(data, others);
  if (conflicts.length > 0) throw new ManagedAccountScopeConflictError(conflicts);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Live rows, name-sorted. Internal — invoice generation reads these. */
export async function listManagedAccountRows(organizationId: string): Promise<
  Array<{
    id: string;
    name: string;
    costCentreIds: string[];
    accountIds: string[];
  }>
> {
  const rows = await db
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
    .orderBy(asc(managedAccounts.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    costCentreIds: Array.isArray(r.costCentreIds) ? r.costCentreIds : [],
    accountIds: Array.isArray(r.accountIds) ? r.accountIds : [],
  }));
}

/** Invoice counts per managed account, one query for the whole list. */
async function invoiceCounts(organizationId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      managedAccountId: managedInvoices.managedAccountId,
      count: sql<number>`count(*)::int`,
    })
    .from(managedInvoices)
    .where(eq(managedInvoices.organizationId, organizationId))
    .groupBy(managedInvoices.managedAccountId);
  return new Map(rows.map((r) => [r.managedAccountId, Number(r.count)]));
}

export async function listManagedAccounts(organizationId: string): Promise<ManagedAccount[]> {
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(managedAccounts)
      .where(
        and(eq(managedAccounts.organizationId, organizationId), isNull(managedAccounts.deletedAt)),
      )
      .orderBy(asc(managedAccounts.name)),
    invoiceCounts(organizationId),
  ]);
  return rows.map((row) => toWire(row, counts.get(row.id) ?? 0));
}

/** The raw live row — what invoice generation needs. Null when not found. */
export async function getManagedAccountRow(
  organizationId: string,
  id: string,
): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(managedAccounts)
    .where(
      and(
        eq(managedAccounts.id, id),
        eq(managedAccounts.organizationId, organizationId),
        isNull(managedAccounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getManagedAccount(
  organizationId: string,
  id: string,
): Promise<ManagedAccount | null> {
  const row = await getManagedAccountRow(organizationId, id);
  if (!row) return null;
  const [count] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(managedInvoices)
    .where(eq(managedInvoices.managedAccountId, id));
  return toWire(row, Number(count?.count ?? 0));
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/** Postgres' unique-violation code, for the org+name index. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export async function createManagedAccount(
  organizationId: string,
  input: ManagedAccountInput,
  createdByUserId?: string | undefined,
): Promise<ManagedAccount> {
  const data = normalizeInput(input);
  await assertScopeExists(organizationId, data);
  await assertScopeExclusive(organizationId, data, null);

  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(managedAccounts)
    .where(
      and(eq(managedAccounts.organizationId, organizationId), isNull(managedAccounts.deletedAt)),
    )) as [{ count: number }];
  if (Number(count) >= MANAGED_ACCOUNT_LIMITS.maxPerOrg) {
    throw new ManagedAccountError(
      `An organisation can have at most ${MANAGED_ACCOUNT_LIMITS.maxPerOrg} managed accounts.`,
    );
  }

  try {
    const [row] = await db
      .insert(managedAccounts)
      .values({
        id: randomUUID(),
        organizationId,
        ...data,
        createdByUserId: createdByUserId ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create managed account");
    return toWire(row, 0);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ManagedAccountNameConflictError(data.name);
    throw e;
  }
}

/**
 * Full replace, like every other cost object's update. Null when not found.
 *
 * Editing the scope changes what **future** drafts are drawn over and nothing
 * else: every approved invoice already holds its own copy of the scope, so
 * moving a cost centre from one customer to another cannot retroactively
 * re-bill a period that has already been invoiced. That is not a special case
 * here — it falls out of freezing at approval.
 */
export async function updateManagedAccount(
  organizationId: string,
  id: string,
  input: ManagedAccountInput,
): Promise<ManagedAccount | null> {
  const existing = await getManagedAccountRow(organizationId, id);
  if (!existing) return null;

  const data = normalizeInput(input);
  await assertScopeExists(organizationId, data);
  await assertScopeExclusive(organizationId, data, id);

  try {
    const [row] = await db
      .update(managedAccounts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(managedAccounts.id, id), eq(managedAccounts.organizationId, organizationId)))
      .returning();
    if (!row) return null;
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(managedInvoices)
      .where(eq(managedInvoices.managedAccountId, id));
    return toWire(row, Number(count?.count ?? 0));
  } catch (e) {
    if (isUniqueViolation(e)) throw new ManagedAccountNameConflictError(data.name);
    throw e;
  }
}

/**
 * Soft delete. False when not found.
 *
 * Soft, always, and not because deletes are scary: an issued invoice names its
 * customer and links to this row, and an invoice whose customer stopped
 * resolving is exactly the unreconcilable document this feature exists to
 * avoid. A customer with no invoices is soft-deleted too — one rule is easier
 * to reason about than two, and the partial unique index frees the name either
 * way.
 *
 * Draft invoices are deleted with it: a draft was never issued, so nothing is
 * lost, and leaving drafts pointing at a retired customer would give the
 * invoice list rows nobody can act on.
 */
export async function deleteManagedAccount(organizationId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: managedAccounts.id })
      .from(managedAccounts)
      .where(
        and(
          eq(managedAccounts.id, id),
          eq(managedAccounts.organizationId, organizationId),
          isNull(managedAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return false;

    await tx
      .delete(managedInvoices)
      .where(
        and(
          eq(managedInvoices.managedAccountId, id),
          eq(managedInvoices.organizationId, organizationId),
          eq(managedInvoices.status, "draft"),
        ),
      );

    const now = new Date();
    await tx
      .update(managedAccounts)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(managedAccounts.id, id));
    return true;
  });
}
