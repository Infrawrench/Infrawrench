/**
 * Invoices raised against a managed account.
 *
 * ## What freezes, and when
 *
 * A **draft** holds no figures. Every read recomputes it from live spend, which
 * is what makes it a working document: cost data restates for days, and a draft
 * that showed a stale number would be worse than useless while someone is still
 * deciding what to bill.
 *
 * **Approval is the freeze.** {@link approveInvoice} computes the figures one
 * last time and writes them onto the row — the lines, the four totals, the
 * exchange rates *and the day they were read*, the billing rules that were in
 * force, and the names everything in scope had at that moment. Every later read
 * of an `approved`, `sent` or `void` invoice returns those bytes and never
 * touches ClickHouse. A provider revising a bill in March, an exchange rate
 * being restated, a cost centre being renamed or moved to another customer:
 * none of them can change a number that has already been sent to a customer.
 *
 * The figures are computed *outside* the transaction that stores them — the
 * computation reads ClickHouse and a transaction held open across it would be
 * a lock held across a network — so approval is **optimistically concurrent**:
 * every input that fed the computation is re-read under a row lock at the
 * moment of writing and compared, and any change refuses the approval rather
 * than freezing figures that belong to a different question. See
 * {@link figureInputsOf}.
 *
 * **Sending** changes nothing about the figures; it records that the document
 * left the building, who let it, and — since delivery landed — where it went
 * and whether it arrived. Delivery only ever writes the delivery columns.
 *
 * **Void** is the only correction. There is no update path and no delete path
 * for an issued invoice — {@link managedInvoiceBlocker} refuses both here, in
 * the service, not merely in a disabled button — so a wrong invoice is voided
 * with a reason and superseded by a corrective one, and both survive. The void,
 * the corrective draft and *both* directions of the link between them are one
 * transaction: a void is irreversible, so a half-applied supersede would strand
 * the user with a withdrawn invoice and no way to correct it.
 *
 * ## How a line is derived
 *
 * One pass of `getShowbackSpend` over the org's **real, unmodified** allocation
 * rules, exactly as `services/showback.ts` runs it. That is what makes an
 * invoice line for a cost centre identical to the showback row for the same
 * centre and period — the customer and the provider are reading the same
 * number, which is the whole basis for being paid.
 *
 * Accounts in scope are appended to the *end* of that rule list, so they claim
 * an account's spend only where no allocation rule already claimed it. Every
 * cost row still resolves exactly once, so no money is billed twice and none
 * goes missing.
 *
 * Fixed-amount billing rules are added as their own lines rather than folded
 * into a cost centre's spend. A management fee is a thing a customer agreed to
 * pay, not a thing a provider charged, and burying it inside "Compute" is how
 * an invoice becomes an argument.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  buildExchangeRateTable,
  dedupeScopeCentres,
  fixedRuleAmountForRange,
  formatManagedInvoiceNumber,
  MANAGED_INVOICE_LIMITS,
  managedInvoiceBlocker,
  managedInvoiceReconciles,
  parseManagedInvoiceNumber,
  sumManagedInvoiceLines,
  UNALLOCATED_KEY,
  type CostBasis,
  type ManagedInvoice,
  type ManagedInvoiceAction,
  type ManagedInvoiceDerivation,
  type ManagedInvoiceInput,
  type ManagedInvoiceLine,
  type ManagedInvoiceRate,
  type ManagedInvoiceStatus,
  type ManagedInvoiceSummary,
  type ManagedInvoiceTotals,
  type ManagedInvoiceUpdate,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, managedAccounts, managedInvoices } from "../db/schema";
import { getShowbackSpend, type ShowbackRule } from "../clickhouse/cost-readers";
import { csvCell } from "../cost-exports/serialize";
import { listAllocationRules, listCostCentres } from "./allocation";
import { resolveBillingAdjustments } from "./billing-rules";
import { rateForDay, parseRate } from "./currency-convert";
import { listOrgExchangeRates } from "./currency-settings";
import { getManagedAccountRow } from "./managed-accounts";

export type { ManagedInvoice, ManagedInvoiceSummary };

/** An invoice write the API should refuse, with `status` as the HTTP code. */
export class InvoiceError extends Error {
  override readonly name = "InvoiceError";

  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/**
 * Prefix for the synthetic centre id an account-scope rule writes.
 *
 * It can never collide with a real cost-centre id, which is a UUID, and it
 * never leaves this module: the wire shape says `kind: "account"` with the bare
 * account id in `refId`.
 */
const ACCOUNT_BUCKET_PREFIX = "acct:";

/** Six places, matching `currency-convert.ts`, so every total agrees. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ *
 * Derivation
 * ------------------------------------------------------------------ */

/** The figures half of an invoice: what a draft recomputes and approval freezes. */
export interface InvoiceFigures {
  lines: ManagedInvoiceLine[];
  totals: ManagedInvoiceTotals;
  derivation: ManagedInvoiceDerivation;
}

type ManagedAccountRow = typeof managedAccounts.$inferSelect;

/**
 * Compute an invoice's lines from live spend.
 *
 * Pure of side effects and of the invoice row itself — it takes the customer
 * and a period and nothing else, which is what lets the approval path call it
 * one last time and store the answer without any risk of storing something
 * different from what the draft was showing a second earlier.
 */
export async function computeInvoiceFigures(
  organizationId: string,
  account: ManagedAccountRow,
  periodFrom: string,
  periodTo: string,
): Promise<InvoiceFigures> {
  const costBasis = account.costBasis as CostBasis;
  const scopeCentreIds = Array.isArray(account.costCentreIds) ? account.costCentreIds : [];
  const scopeAccountIds = Array.isArray(account.accountIds) ? account.accountIds : [];

  const [centres, allocationRules, billing, rates, accountRows] = await Promise.all([
    listCostCentres(organizationId),
    listAllocationRules(organizationId),
    account.applyBillingRules ? resolveBillingAdjustments(organizationId) : Promise.resolve(null),
    listOrgExchangeRates(organizationId),
    scopeAccountIds.length > 0
      ? db
          .select({ id: accounts.id, displayName: accounts.displayName })
          .from(accounts)
          .where(
            and(eq(accounts.organizationId, organizationId), inArray(accounts.id, scopeAccountIds)),
          )
      : Promise.resolve([] as Array<{ id: string; displayName: string }>),
  ]);

  const centreById = new Map(centres.map((c) => [c.id, c]));
  const accountNameById = new Map(accountRows.map((a) => [a.id, a.displayName]));

  // Scope that has since disappeared is recorded, never silently skipped: an
  // invoice that is quietly short is worse than one that says why.
  const missingScope = [
    ...scopeCentreIds.filter((id) => !centreById.has(id)),
    ...scopeAccountIds.filter((id) => !accountNameById.has(id)),
  ];

  // The org's rule list, unmodified and in evaluation order — the same list
  // `services/showback.ts` compiles. Keeping it whole is what makes an invoice
  // line equal to the showback row: filtering it to the customer's centres
  // would let a row that a *different* centre's higher-priority rule claims
  // fall through onto this customer, and over-bill them.
  const orderedRules: ShowbackRule[] = allocationRules
    .filter((r) => centreById.has(r.costCentreId))
    .map((r) => ({ costCentreId: r.costCentreId, match: r.match }));

  // Account scope, appended last so it can only claim what nothing else did.
  for (const accountId of scopeAccountIds) {
    if (!accountNameById.has(accountId)) continue;
    orderedRules.push({
      costCentreId: `${ACCOUNT_BUCKET_PREFIX}${accountId}`,
      match: { accountId },
    });
  }

  const compiled =
    billing && !billingAdjustmentsAreEmptyLocal(billing) ? billing.adjustments : undefined;
  const rows = await getShowbackSpend(
    organizationId,
    orderedRules,
    periodFrom,
    periodTo,
    costBasis,
    compiled,
  );

  // bucket id → currency → { adjusted, collected }
  const byBucket = new Map<string, Map<string, { adjusted: number; collected: number }>>();
  for (const row of rows) {
    const key = row.costCentreId || UNALLOCATED_KEY;
    const bucket = byBucket.get(key) ?? new Map();
    const entry = bucket.get(row.currency) ?? { adjusted: 0, collected: 0 };
    entry.adjusted = round6(entry.adjusted + row.amount);
    entry.collected = round6(entry.collected + (row.rawAmount ?? row.amount));
    bucket.set(row.currency, entry);
    byBucket.set(key, bucket);
  }

  /* -- cost-centre lines, over deduplicated subtrees -- */

  const parentOf = new Map<string, string | null>(centres.map((c) => [c.id, c.parentId]));
  const liveScopeCentres = scopeCentreIds.filter((id) => centreById.has(id));
  // A line quotes a centre's *subtree*, so billing both a parent and its child
  // would charge the child twice. The ancestor wins.
  const billableCentres = dedupeScopeCentres(liveScopeCentres, parentOf);

  const childrenOf = new Map<string, string[]>();
  for (const centre of centres) {
    if (centre.parentId === null || centre.parentId === centre.id) continue;
    const list = childrenOf.get(centre.parentId) ?? [];
    list.push(centre.id);
    childrenOf.set(centre.parentId, list);
  }

  const subtreeTotals = (rootId: string): Map<string, { adjusted: number; collected: number }> => {
    const out = new Map<string, { adjusted: number; collected: number }>();
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue; // cycle guard, matching buildShowbackCentres
      seen.add(id);
      for (const [currency, amounts] of byBucket.get(id) ?? []) {
        const entry = out.get(currency) ?? { adjusted: 0, collected: 0 };
        entry.adjusted = round6(entry.adjusted + amounts.adjusted);
        entry.collected = round6(entry.collected + amounts.collected);
        out.set(currency, entry);
      }
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }
    return out;
  };

  const rawLines: Array<Omit<ManagedInvoiceLine, "rate" | "billed">> = [];

  for (const centreId of billableCentres) {
    const centre = centreById.get(centreId)!;
    for (const [currency, amounts] of [...subtreeTotals(centreId)].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (amounts.adjusted === 0 && amounts.collected === 0) continue;
      rawLines.push({
        kind: "cost_centre",
        refId: centreId,
        label: centre.name,
        currency,
        collected: amounts.collected,
        adjustment: round6(amounts.adjusted - amounts.collected),
        adjusted: amounts.adjusted,
      });
    }
  }

  /* -- account lines, from the appended buckets -- */

  for (const accountId of scopeAccountIds) {
    const label = accountNameById.get(accountId);
    if (!label) continue;
    const bucket = byBucket.get(`${ACCOUNT_BUCKET_PREFIX}${accountId}`);
    if (!bucket) continue;
    for (const [currency, amounts] of [...bucket].sort(([a], [b]) => a.localeCompare(b))) {
      if (amounts.adjusted === 0 && amounts.collected === 0) continue;
      rawLines.push({
        kind: "account",
        refId: accountId,
        label,
        currency,
        collected: amounts.collected,
        adjustment: round6(amounts.adjusted - amounts.collected),
        adjusted: amounts.adjusted,
      });
    }
  }

  /* -- fixed charges, their own lines -- */

  // A flat monthly fee is owed whether or not a provider billed anything, so it
  // is arithmetic over the period rather than anything that came out of the
  // scan. Only fees booked onto something this customer owns appear: an
  // org-level fixed rule that names no target is the provider's own overhead,
  // not a line any one customer agreed to.
  const billableSet = new Set(billableCentres);
  const centreIsBilled = (id: string): boolean => {
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor !== null && !seen.has(cursor)) {
      if (billableSet.has(cursor)) return true;
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    return false;
  };
  const scopeAccountSet = new Set(scopeAccountIds);

  for (const rule of billing?.adjustments.fixed ?? []) {
    const targetsCentre =
      rule.targetKind === "cost_centre" && rule.targetId && centreIsBilled(rule.targetId);
    const targetsAccount =
      rule.targetKind === "account" && rule.targetId && scopeAccountSet.has(rule.targetId);
    if (!targetsCentre && !targetsAccount) continue;

    const amount = round6(fixedRuleAmountForRange(rule, periodFrom, periodTo));
    if (amount === 0) continue;
    rawLines.push({
      kind: "fixed",
      refId: rule.targetId ?? null,
      label: rule.name,
      currency: rule.currency,
      // Nothing was collected for a fixed fee — it is entirely an adjustment,
      // which is what keeps `collected + adjustment === adjusted` true.
      collected: 0,
      adjustment: amount,
      adjusted: amount,
    });
  }

  /* -- conversion into the customer's currency -- */

  const invoiceCurrency = account.billingCurrency;
  // One rate for the period, read off its last day. Unlike a graph these are
  // period totals with no day to convert against, and "January, at the
  // 31 January rate" is a sentence a finance team can defend and reproduce.
  const rateDate = periodTo;
  const table = buildExchangeRateTable(rates, invoiceCurrency);

  const appliedRates = new Map<string, ManagedInvoiceRate>();
  const unconverted = new Set<string>();

  const lines: ManagedInvoiceLine[] = rawLines.map((line) => {
    if (line.currency === invoiceCurrency) {
      // Passed through, never multiplied by a stated rate of 1 — a self-rate
      // cannot exist (`buildExchangeRateTable` drops it).
      return { ...line, rate: 1, billed: line.adjusted };
    }
    const match = rateForDay(table.get(line.currency) ?? [], rateDate);
    const value = match ? parseRate(match.rate) : null;
    if (!match || value === null) {
      unconverted.add(line.currency);
      return { ...line, rate: null, billed: null };
    }
    appliedRates.set(line.currency, {
      currency: line.currency,
      rate: value,
      effectiveFrom: match.effectiveFrom,
    });
    return { ...line, rate: value, billed: round6(line.adjusted * value) };
  });

  // Biggest first: an invoice is read from the top, and the line that decides
  // whether it gets paid should not be below the fold.
  lines.sort(
    (a, b) => (b.billed ?? b.adjusted) - (a.billed ?? a.adjusted) || a.label.localeCompare(b.label),
  );

  const derivation: ManagedInvoiceDerivation = {
    costBasis,
    applyBillingRules: account.applyBillingRules,
    rateDate,
    rates: [...appliedRates.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    unconverted: [...unconverted].sort(),
    rules: billing?.rules ?? [],
    scope: {
      costCentres: billableCentres.map((id) => ({ id, name: centreById.get(id)!.name })),
      accounts: scopeAccountIds
        .filter((id) => accountNameById.has(id))
        .map((id) => ({ id, label: accountNameById.get(id)! })),
    },
    missingScope,
  };

  return { lines, totals: sumManagedInvoiceLines(lines, invoiceCurrency), derivation };
}

/**
 * Local copy of `billingAdjustmentsAreEmpty`'s question, phrased over the
 * resolved bundle. Kept here rather than imported so the fixed-rule branch
 * above and this one cannot drift: fixed rules are applied as lines, not in the
 * scan, so a rule set that is *only* fixed rules must still skip the adjusted
 * query path — otherwise every row comes back with a `rawAmount` equal to its
 * amount and the invoice claims an adjustment happened when none did.
 */
function billingAdjustmentsAreEmptyLocal(
  billing: Awaited<ReturnType<typeof resolveBillingAdjustments>>,
): boolean {
  const { factors, reallocations } = billing.adjustments;
  return factors.length === 0 && reallocations.length === 0;
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

type InvoiceRow = typeof managedInvoices.$inferSelect;

function toSummary(row: InvoiceRow): ManagedInvoiceSummary {
  return {
    id: row.id,
    managedAccountId: row.managedAccountId,
    managedAccountName: row.managedAccountName,
    number: row.number,
    status: row.status as ManagedInvoiceStatus,
    periodFrom: String(row.periodFrom),
    periodTo: String(row.periodTo),
    currency: row.currency,
    // Null, never zero: a draft's figures are recomputed on read, and the list
    // does not recompute. Zero would be a lie the reader cannot detect.
    totals: (row.totals as ManagedInvoiceTotals | null) ?? null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    delivery: toDelivery(row),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    supersedesInvoiceId: row.supersedesInvoiceId,
    supersededByInvoiceId: row.supersededByInvoiceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWire(row: InvoiceRow, figures: InvoiceFigures, live: boolean): ManagedInvoice {
  return {
    ...toSummary(row),
    notes: row.notes,
    lines: figures.lines,
    totals: figures.totals,
    derivation: figures.derivation,
    live,
    computedAt: live
      ? new Date().toISOString()
      : (row.computedAt?.toISOString() ?? row.createdAt.toISOString()),
    approvedByUserId: row.approvedByUserId,
    sentByUserId: row.sentByUserId,
    voidedByUserId: row.voidedByUserId,
    createdByUserId: row.createdByUserId,
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface InvoiceListFilter {
  managedAccountId?: string | undefined;
  status?: ManagedInvoiceStatus | undefined;
}

/**
 * Invoices newest first. Summaries only — see {@link ManagedInvoiceSummary} for
 * why a draft's totals are null here rather than recomputed.
 */
export async function listInvoices(
  organizationId: string,
  filter: InvoiceListFilter = {},
): Promise<ManagedInvoiceSummary[]> {
  const where = [eq(managedInvoices.organizationId, organizationId)];
  if (filter.managedAccountId) {
    where.push(eq(managedInvoices.managedAccountId, filter.managedAccountId));
  }
  if (filter.status) where.push(eq(managedInvoices.status, filter.status));

  const rows = await db
    .select()
    .from(managedInvoices)
    .where(and(...where))
    .orderBy(desc(managedInvoices.periodTo), desc(managedInvoices.createdAt));
  return rows.map(toSummary);
}

async function getInvoiceRow(organizationId: string, id: string): Promise<InvoiceRow | null> {
  const [row] = await db
    .select()
    .from(managedInvoices)
    .where(and(eq(managedInvoices.id, id), eq(managedInvoices.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/**
 * One invoice, with its figures.
 *
 * **A draft recomputes; everything else does not.** That single line is the
 * feature. A frozen invoice returns the bytes written at approval, and this
 * function does not so much as look at ClickHouse for it.
 */
export async function getInvoice(
  organizationId: string,
  id: string,
): Promise<ManagedInvoice | null> {
  const row = await getInvoiceRow(organizationId, id);
  if (!row) return null;

  if (row.status !== "draft") return toWire(row, frozenFigures(row), false);

  const account = await getManagedAccountRow(organizationId, row.managedAccountId);
  if (!account) {
    // The customer was retired out from under a draft. Drafts are deleted with
    // their customer, so this is a torn read rather than a state to represent.
    throw new InvoiceError("The customer this draft belongs to no longer exists", 404);
  }
  const figures = await computeInvoiceFigures(
    organizationId,
    account,
    String(row.periodFrom),
    String(row.periodTo),
  );
  return toWire(row, figures, true);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/** The transaction handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Read and row-lock one invoice inside a transaction.
 *
 * `FOR UPDATE` is what turns "check then write" into a decision: a concurrent
 * edit either committed before this read — in which case the caller sees it and
 * refuses — or blocks until this transaction ends, by which point its own
 * `status = 'draft'` guard no longer matches. There is no third ordering.
 */
async function lockInvoice(tx: Tx, organizationId: string, id: string): Promise<InvoiceRow | null> {
  const [row] = await tx
    .select()
    .from(managedInvoices)
    .where(and(eq(managedInvoices.id, id), eq(managedInvoices.organizationId, organizationId)))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** Read and row-lock one customer inside a transaction. */
async function lockManagedAccount(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<ManagedAccountRow | null> {
  const [row] = await tx
    .select()
    .from(managedAccounts)
    .where(
      and(
        eq(managedAccounts.id, id),
        eq(managedAccounts.organizationId, organizationId),
        isNull(managedAccounts.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * Every input that decides what an invoice's figures say.
 *
 * The reported race was the period — edit a draft's period while an approval is
 * mid-flight and the approval freezes the old period's lines onto a row that
 * now claims the new one. But the period is only the instance. *Every* field
 * below changes the figures the same way, and each is editable while a draft
 * sits there:
 *
 * - `periodFrom` / `periodTo` — which days are summed (`PUT /invoices/:id`);
 * - `costCentreIds` / `accountIds` — whose spend is summed;
 * - `costBasis` — cash or amortized, a different number for the same days;
 * - `applyBillingRules` — markups and fixed fees in or out;
 * - `billingCurrency` — the conversion target *and* the stored `currency`;
 * - `name` — frozen onto the row as `managedAccountName`;
 * - `managedAccountId` — belt and braces; nothing edits it today.
 *
 * (all six of the customer's fields move together on `PUT /managed-accounts/:id`.)
 *
 * So the fix is stated over the whole set rather than the one field that was
 * reported: this snapshot is taken before the figures are computed, re-taken
 * under a row lock at the moment of writing, and any difference refuses the
 * approval.
 */
interface FigureInputs {
  managedAccountId: string;
  periodFrom: string;
  periodTo: string;
  accountName: string;
  billingCurrency: string;
  costBasis: string;
  applyBillingRules: boolean;
  costCentreIds: string[];
  accountIds: string[];
}

function figureInputsOf(row: InvoiceRow, account: ManagedAccountRow): FigureInputs {
  return {
    managedAccountId: row.managedAccountId,
    periodFrom: String(row.periodFrom),
    periodTo: String(row.periodTo),
    accountName: account.name,
    billingCurrency: account.billingCurrency,
    costBasis: String(account.costBasis),
    applyBillingRules: account.applyBillingRules,
    costCentreIds: Array.isArray(account.costCentreIds) ? [...account.costCentreIds] : [],
    accountIds: Array.isArray(account.accountIds) ? [...account.accountIds] : [],
  };
}

/** What changed between two snapshots, named the way a person would say it. */
function figureInputsChanged(before: FigureInputs, after: FigureInputs): string[] {
  const changed: string[] = [];
  const sameList = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  if (before.managedAccountId !== after.managedAccountId) changed.push("the customer");
  if (before.periodFrom !== after.periodFrom || before.periodTo !== after.periodTo) {
    changed.push(`the period (now ${after.periodFrom} → ${after.periodTo})`);
  }
  if (before.accountName !== after.accountName) changed.push("the customer's name");
  if (before.billingCurrency !== after.billingCurrency) changed.push("the billing currency");
  if (before.costBasis !== after.costBasis) changed.push("the cost basis");
  if (before.applyBillingRules !== after.applyBillingRules) {
    changed.push("whether the billing rules apply");
  }
  if (!sameList(before.costCentreIds, after.costCentreIds)) {
    changed.push("the cost centres in scope");
  }
  if (!sameList(before.accountIds, after.accountIds)) changed.push("the accounts in scope");
  return changed;
}

function assertPeriod(from: string, to: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new InvoiceError("periodFrom and periodTo must be YYYY-MM-DD dates");
  }
  if (to < from) throw new InvoiceError("periodTo must not be before periodFrom");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (days > MANAGED_INVOICE_LIMITS.maxPeriodDays) {
    throw new InvoiceError(
      `An invoice may cover at most ${MANAGED_INVOICE_LIMITS.maxPeriodDays} days`,
    );
  }
}

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes === null || notes === undefined) return null;
  const trimmed = String(notes).trim();
  if (!trimmed) return null;
  if (trimmed.length > MANAGED_INVOICE_LIMITS.maxNotesLength) {
    throw new InvoiceError(
      `notes must be ${MANAGED_INVOICE_LIMITS.maxNotesLength} characters or fewer`,
    );
  }
  return trimmed;
}

/**
 * Insert a draft and, when it corrects one, link it to the original **both
 * ways** — inside the caller's transaction.
 *
 * Two statements that must not be separable. `supersedes` without
 * `superseded_by` is a correction the original does not know about, which is
 * exactly the state a reader looking at the void invoice cannot recover from.
 * The original is locked first, so a second corrective draft racing this one
 * cannot overwrite the back-link.
 */
async function insertDraftTx(
  tx: Tx,
  organizationId: string,
  account: ManagedAccountRow,
  draft: { periodFrom: string; periodTo: string; notes: string | null },
  supersedesInvoiceId: string | null,
  createdByUserId: string | null,
): Promise<InvoiceRow> {
  const id = randomUUID();
  const [row] = await tx
    .insert(managedInvoices)
    .values({
      id,
      organizationId,
      managedAccountId: account.id,
      managedAccountName: account.name,
      number: null,
      status: "draft",
      periodFrom: draft.periodFrom,
      periodTo: draft.periodTo,
      currency: account.billingCurrency,
      notes: draft.notes,
      supersedesInvoiceId,
      createdByUserId,
    })
    .returning();
  if (!row) throw new Error("Failed to create invoice");

  if (supersedesInvoiceId) {
    await tx
      .update(managedInvoices)
      .set({ supersededByInvoiceId: id, updatedAt: new Date() })
      .where(eq(managedInvoices.id, supersedesInvoiceId));
  }
  return row;
}

/** Check that `original` may be superseded, from inside a transaction. */
function assertSupersedable(original: InvoiceRow | null): asserts original is InvoiceRow {
  if (!original) throw new InvoiceError("The invoice being superseded was not found", 404);
  if (original.status !== "void") {
    throw new InvoiceError(
      "Only a void invoice can be superseded. Void the original first — a correction that " +
        "leaves the original standing means the customer holds two live invoices for one period.",
      409,
    );
  }
  if (original.supersededByInvoiceId) {
    throw new InvoiceError(
      "This invoice has already been superseded by a corrective invoice. Two corrections for one " +
        "void invoice would leave the link pointing at only one of them, and a customer holding " +
        "two bills for the same period.",
      409,
    );
  }
}

/**
 * Raise a draft. Always `draft`, never anything else — generating and issuing
 * are two acts, and collapsing them would mean a mis-typed period could be sent
 * to a customer without anyone having looked at the numbers.
 *
 * The row and, when superseding, the original's back-link are written in one
 * transaction. The figures are computed *after* it commits: a draft recomputes
 * on every read anyway, so a failure there costs a response, not a row.
 */
export async function createInvoice(
  organizationId: string,
  input: ManagedInvoiceInput,
  createdByUserId: string | null,
): Promise<ManagedInvoice> {
  assertPeriod(input.periodFrom, input.periodTo);
  const notes = normalizeNotes(input.notes);

  const account = await getManagedAccountRow(organizationId, input.managedAccountId);
  if (!account) throw new InvoiceError("Managed account not found", 404);

  const row = await db.transaction(async (tx) => {
    let supersedesInvoiceId: string | null = null;
    if (input.supersedesInvoiceId) {
      const original = await lockInvoice(tx, organizationId, input.supersedesInvoiceId);
      assertSupersedable(original);
      supersedesInvoiceId = original.id;
    }
    return insertDraftTx(
      tx,
      organizationId,
      account,
      { periodFrom: input.periodFrom, periodTo: input.periodTo, notes },
      supersedesInvoiceId,
      createdByUserId,
    );
  });

  const figures = await computeInvoiceFigures(
    organizationId,
    account,
    input.periodFrom,
    input.periodTo,
  );
  return toWire(row, figures, true);
}

/** Throw when `action` is not allowed in the row's current state. */
function assertAllowed(row: InvoiceRow, action: ManagedInvoiceAction): void {
  const blocker = managedInvoiceBlocker({ status: row.status as ManagedInvoiceStatus }, action);
  if (blocker) throw new InvoiceError(blocker, 409);
}

/** Edit a draft's period or notes. Refused on anything issued. */
export async function updateInvoice(
  organizationId: string,
  id: string,
  update: ManagedInvoiceUpdate,
): Promise<ManagedInvoice | null> {
  const row = await getInvoiceRow(organizationId, id);
  if (!row) return null;
  assertAllowed(row, "edit");
  assertPeriod(update.periodFrom, update.periodTo);
  const notes = normalizeNotes(update.notes);

  const [updated] = await db
    .update(managedInvoices)
    .set({
      periodFrom: update.periodFrom,
      periodTo: update.periodTo,
      notes,
      updatedAt: new Date(),
    })
    // The status guard is repeated in SQL, not just checked above: two clients
    // racing an edit against an approval must not be able to move the period
    // out from under the numbers being frozen.
    .where(and(eq(managedInvoices.id, id), eq(managedInvoices.status, "draft")))
    .returning();
  if (!updated) throw new InvoiceError("This invoice is no longer a draft", 409);

  const account = await getManagedAccountRow(organizationId, updated.managedAccountId);
  if (!account) throw new InvoiceError("Managed account not found", 404);
  const figures = await computeInvoiceFigures(
    organizationId,
    account,
    update.periodFrom,
    update.periodTo,
  );
  return toWire(updated, figures, true);
}

/** Delete a draft. Refused on anything issued — that is what void is for. */
export async function deleteInvoice(organizationId: string, id: string): Promise<boolean> {
  const row = await getInvoiceRow(organizationId, id);
  if (!row) return false;
  assertAllowed(row, "delete");

  const deleted = await db
    .delete(managedInvoices)
    .where(and(eq(managedInvoices.id, id), eq(managedInvoices.status, "draft")))
    .returning({ id: managedInvoices.id });
  if (deleted.length === 0) throw new InvoiceError("This invoice is no longer a draft", 409);
  return true;
}

/**
 * The next invoice number for an org in the period's calendar year.
 *
 * Sequenced on the **period end**, not on the day the button was pressed, so
 * December's invoice approved on 3 January is still a December number.
 */
async function nextInvoiceNumber(
  tx: Tx,
  organizationId: string,
  periodTo: string,
): Promise<string> {
  const year = Number(periodTo.slice(0, 4));
  const rows = await tx
    .select({ number: managedInvoices.number })
    .from(managedInvoices)
    .where(
      and(
        eq(managedInvoices.organizationId, organizationId),
        sql`${managedInvoices.number} like ${`INV-${year}-%`}`,
      ),
    );
  let highest = 0;
  for (const row of rows) {
    const parsed = row.number ? parseManagedInvoiceNumber(row.number) : null;
    if (parsed && parsed.year === year && parsed.sequence > highest) highest = parsed.sequence;
  }
  return formatManagedInvoiceNumber(year, highest + 1);
}

/**
 * Approve — the freeze.
 *
 * Computes the figures one last time and writes them onto the row together with
 * the rates, the rules and the names. From here the invoice is a document, not
 * a query, and nothing that happens to spend, rates, rules or names afterwards
 * can change what it says.
 *
 * Refused when a currency could not be converted: an approved invoice has to be
 * quotable as one number in the customer's currency, and freezing a total that
 * is partly in a currency the org has stated no rate for would produce exactly
 * the figure nobody can explain.
 *
 * Refused, too, when the arithmetic does not reconcile. That should be
 * impossible — the identity is maintained line by line — which is precisely why
 * it is worth checking before anything is made permanent.
 *
 * ## Why this is optimistically concurrent
 *
 * The figures come from ClickHouse, which takes as long as it takes, so they
 * are computed **before** the transaction that stores them: holding a Postgres
 * transaction open across an analytics query would put a row lock behind a
 * network call, and `computeInvoiceFigures` does not run on the transaction
 * anyway. That leaves a window, and the window is the bug this guards:
 *
 * ```
 *  A: read draft (Jan 1–31)                    A: freeze Jan's figures ─┐
 *  B:                        edit → Feb 1–28                           │
 *  row now says February ───────────────────────────────────────────────┘
 * ```
 *
 * So {@link figureInputsOf} snapshots every input before computing, and this
 * function re-reads all of them **under `FOR UPDATE` in the same transaction as
 * the status write** and refuses on any difference. The lock closes the
 * remaining gap in both directions: an editor that gets there first is seen by
 * the comparison, and one that arrives later blocks until the row says
 * `approved` and its own draft-only guard rejects it.
 *
 * Refusing rather than recomputing is deliberate. Recomputing silently would
 * approve numbers nobody had looked at, and approval is the one act in this
 * feature whose whole value is that a person saw the figures first.
 */
export async function approveInvoice(
  organizationId: string,
  id: string,
  userId: string | null,
): Promise<ManagedInvoice> {
  const row = await getInvoiceRow(organizationId, id);
  if (!row) throw new InvoiceError("Invoice not found", 404);
  assertAllowed(row, "approve");

  const account = await getManagedAccountRow(organizationId, row.managedAccountId);
  if (!account) throw new InvoiceError("Managed account not found", 404);

  const inputs = figureInputsOf(row, account);
  const figures = await computeInvoiceFigures(
    organizationId,
    account,
    inputs.periodFrom,
    inputs.periodTo,
  );

  const blocker = managedInvoiceBlocker(
    { status: "draft", derivation: figures.derivation },
    "approve",
  );
  if (blocker) throw new InvoiceError(blocker, 409);

  if (!managedInvoiceReconciles(figures.totals)) {
    throw new InvoiceError(
      "This invoice does not reconcile: the collected amounts plus the adjustments do not equal " +
        "the invoiced figure. Nothing has been approved. Please report this — an invoice that " +
        "cannot be explained must not be issued.",
      409,
    );
  }

  const now = new Date();
  // Three attempts: the number is derived from a read, so a concurrent approval
  // in the same org and year can take it. The unique index is what actually
  // decides, and a duplicate rolls this transaction back — a failed statement
  // poisons the whole transaction in Postgres — so the retry re-runs the
  // transaction rather than continuing inside a dead one. The figures are
  // computed once, outside the loop: they do not depend on the number.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const current = await lockInvoice(tx, organizationId, id);
        if (!current) throw new InvoiceError("Invoice not found", 404);
        if (current.status !== "draft") {
          throw new InvoiceError("This invoice is no longer a draft", 409);
        }
        const currentAccount = await lockManagedAccount(
          tx,
          organizationId,
          current.managedAccountId,
        );
        if (!currentAccount) {
          throw new InvoiceError(
            "The customer this draft belongs to was retired while it was being approved. " +
              "Nothing has been approved.",
            409,
          );
        }

        const changed = figureInputsChanged(inputs, figureInputsOf(current, currentAccount));
        if (changed.length > 0) {
          throw new InvoiceError(
            `This invoice changed while it was being approved — ${changed.join(", ")} ` +
              "changed after these figures were computed, so they no longer describe it. " +
              "Nothing has been approved. Re-open the draft, check the numbers, and approve again.",
            409,
          );
        }

        const number = await nextInvoiceNumber(tx, organizationId, inputs.periodTo);
        const [updated] = await tx
          .update(managedInvoices)
          .set({
            status: "approved",
            number,
            // The customer's name and currency are stored from the same read
            // the figures were computed from — and the comparison above is what
            // guarantees that read is still current.
            managedAccountName: inputs.accountName,
            currency: inputs.billingCurrency,
            lines: figures.lines,
            totals: figures.totals,
            derivation: figures.derivation,
            computedAt: now,
            issuedAt: now,
            approvedByUserId: userId,
            updatedAt: now,
          })
          .where(and(eq(managedInvoices.id, id), eq(managedInvoices.status, "draft")))
          .returning();
        if (!updated) throw new InvoiceError("This invoice is no longer a draft", 409);
        return toWire(updated, figures, false);
      });
    } catch (e) {
      const isDuplicate =
        typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
      if (!isDuplicate || attempt === 2) throw e;
    }
  }
  throw new InvoiceError("Could not allocate an invoice number; please try again", 409);
}

/**
 * Mark an approved invoice as sent. Changes no figure — it records that the
 * document left, and who let it, which is the fact an audit actually needs.
 *
 * This deployment does not deliver invoices itself; see the module docs on
 * `api/routes/invoices.ts` for what "sent" therefore means.
 */
export async function sendInvoice(
  organizationId: string,
  id: string,
  userId: string | null,
): Promise<ManagedInvoice> {
  const row = await getInvoiceRow(organizationId, id);
  if (!row) throw new InvoiceError("Invoice not found", 404);
  assertAllowed(row, "send");

  const now = new Date();
  const [updated] = await db
    .update(managedInvoices)
    .set({ status: "sent", sentAt: now, sentByUserId: userId, updatedAt: now })
    .where(and(eq(managedInvoices.id, id), eq(managedInvoices.status, "approved")))
    .returning();
  if (!updated) throw new InvoiceError("This invoice is no longer awaiting sending", 409);
  return (await getInvoice(organizationId, id))!;
}

/**
 * Void an issued invoice, optionally raising the correction in the same act.
 *
 * The original is never touched beyond its status and the reason: its lines,
 * totals, rates and rules stay exactly as they were sent. That is the point —
 * "we billed you this, it was wrong, here is the corrected one" is a story a
 * customer can follow, and "we changed the invoice" is not.
 *
 * ## Why the whole thing is one transaction
 *
 * Void is irreversible by design: there is no un-void, and the corrective
 * invoice is the only way forward. A sequence that commits the void, then
 * inserts the draft, then writes the back-link can stop after any one of them —
 * a crash, a failed connection, a request the client abandoned — and every
 * stopping point strands the user somewhere they cannot get out of:
 *
 * - after the void: a withdrawn invoice, no correction, and `void` refuses
 *   every action that could produce one;
 * - after the insert: a corrective draft the original does not point at, so the
 *   customer's copy of the story has a hole in it.
 *
 * All three statements therefore run in one transaction, and it either applies
 * whole or not at all. The only work left outside is computing the new draft's
 * figures, which reads ClickHouse — a draft recomputes on every read, so that
 * is a display concern, not state, and the pair is already durable when it runs.
 */
export async function voidInvoice(
  organizationId: string,
  id: string,
  userId: string | null,
  reason: string,
  supersede: boolean,
): Promise<{ invoice: ManagedInvoice; replacement: ManagedInvoice | null }> {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) {
    throw new InvoiceError(
      "A void needs a reason. It is the only record of why a customer was sent an invoice that " +
        "was then withdrawn.",
    );
  }
  if (trimmed.length > MANAGED_INVOICE_LIMITS.maxVoidReasonLength) {
    throw new InvoiceError(
      `reason must be ${MANAGED_INVOICE_LIMITS.maxVoidReasonLength} characters or fewer`,
    );
  }

  const row = await getInvoiceRow(organizationId, id);
  if (!row) throw new InvoiceError("Invoice not found", 404);
  assertAllowed(row, "void");

  const now = new Date();
  const { voided, replacement, account } = await db.transaction(async (tx) => {
    const current = await lockInvoice(tx, organizationId, id);
    if (!current) throw new InvoiceError("Invoice not found", 404);
    assertAllowed(current, "void");

    const [updated] = await tx
      .update(managedInvoices)
      .set({
        status: "void",
        voidedAt: now,
        voidedByUserId: userId,
        voidReason: trimmed,
        updatedAt: now,
      })
      .where(and(eq(managedInvoices.id, id), inArray(managedInvoices.status, ["approved", "sent"])))
      .returning();
    if (!updated) throw new InvoiceError("This invoice is no longer issued", 409);

    if (!supersede) {
      return { voided: updated, replacement: null, account: null as ManagedAccountRow | null };
    }

    const customer = await lockManagedAccount(tx, organizationId, updated.managedAccountId);
    if (!customer) {
      // Rolls the void back with it, deliberately. The caller asked for "void
      // and correct"; half of that is the state this transaction exists to
      // prevent, so they get an error and an invoice they can still act on.
      throw new InvoiceError(
        "The customer this invoice bills has been retired, so no corrective invoice can be " +
          "raised for it. Nothing has been voided.",
        409,
      );
    }

    const draft = await insertDraftTx(
      tx,
      organizationId,
      customer,
      {
        periodFrom: String(updated.periodFrom),
        periodTo: String(updated.periodTo),
        notes: updated.notes,
      },
      updated.id,
      userId,
    );
    // The back-link `insertDraftTx` wrote, reflected onto the row in hand so
    // the response does not need a re-read to show the pair.
    return {
      voided: { ...updated, supersededByInvoiceId: draft.id },
      replacement: draft,
      account: customer,
    };
  });

  const invoice = toWire(voided, frozenFigures(voided), false);
  if (!replacement || !account) return { invoice, replacement: null };

  // Outside the transaction on purpose: this reads cost data, and the pair is
  // already committed. A failure here costs the caller the draft's *numbers*,
  // never the draft — which the next read recomputes anyway.
  let figures: InvoiceFigures;
  try {
    figures = await computeInvoiceFigures(
      organizationId,
      account,
      String(replacement.periodFrom),
      String(replacement.periodTo),
    );
  } catch (e) {
    throw new InvoiceError(
      `${invoice.number ?? "The invoice"} was voided and its corrective draft was raised — both ` +
        "are saved and linked. Its figures could not be computed just now " +
        `(${e instanceof Error ? e.message : String(e)}); open the draft to see them.`,
      409,
    );
  }
  return { invoice, replacement: toWire(replacement, figures, true) };
}

/* ------------------------------------------------------------------ *
 * The downloadable artifact
 * ------------------------------------------------------------------ */

/**
 * The invoice as CSV — the derivation, not a pretty document.
 *
 * Every column an accounts-payable clerk needs to check the arithmetic is here:
 * what was collected, what the rules added, what that came to, the rate and the
 * date it was read, and the final figure. Deliberately not a PDF: a PDF is a
 * layout decision plus a rendering dependency, and it is the *numbers* that
 * have to survive being argued with.
 *
 * Uses the same RFC 4180 quoting as the scheduled cost exports, so a customer
 * who already ingests those needs no second parser.
 */
export function renderInvoiceCsv(invoice: ManagedInvoice): string {
  const header = [
    "invoice_number",
    "customer",
    "period_from",
    "period_to",
    "line_kind",
    "line_label",
    "collected_currency",
    "collected",
    "adjustment",
    "adjusted",
    "rate",
    "rate_date",
    "invoice_currency",
    "billed",
  ];
  const rows = invoice.lines.map((line) =>
    [
      invoice.number ?? "(draft)",
      invoice.managedAccountName,
      invoice.periodFrom,
      invoice.periodTo,
      line.kind,
      line.label,
      line.currency,
      line.collected,
      line.adjustment,
      line.adjusted,
      line.rate ?? "",
      invoice.derivation.rateDate,
      invoice.currency,
      line.billed ?? "",
    ]
      .map(csvCell)
      .join(","),
  );

  // The totals ride in the same file rather than a sidecar: a line list whose
  // sum the reader has to compute themselves is how two parties end up with two
  // different totals for the same document.
  const totals = Object.entries(invoice.totals.billed).map(([currency, amount]) =>
    [
      invoice.number ?? "(draft)",
      invoice.managedAccountName,
      invoice.periodFrom,
      invoice.periodTo,
      "total",
      "Invoice total",
      "",
      "",
      "",
      "",
      "",
      invoice.derivation.rateDate,
      currency,
      amount,
    ]
      .map(csvCell)
      .join(","),
  );

  return [header.join(","), ...rows, ...totals].join("\n") + "\n";
}
