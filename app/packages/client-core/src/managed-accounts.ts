/**
 * Managed accounts and their invoices — the managed-service-provider half of
 * the cost feature: who the spend belongs to, and the document that bills them
 * for it.
 *
 * ## A managed account is a customer, not a second allocation mechanism
 *
 * Everything about *which* spend belongs to a customer is already decided by
 * cost centres and their allocation rules. A managed account therefore holds a
 * **list of cost-centre ids** and nothing that looks like a rule: no tag match,
 * no account/service predicate, no priority. Two mechanisms that both claim
 * spend would eventually disagree, and the day they disagree is the day an
 * invoice stops reconciling against the showback report a customer was shown.
 *
 * `accountIds` is the one concession, and it is deliberately weaker than a
 * rule: an account in scope claims that account's spend **only where no
 * allocation rule already claimed it**. It is evaluated by appending synthetic
 * rules to the end of the org's real, unmodified rule list, so every cost row
 * still resolves exactly once and every cost-centre line on an invoice is
 * byte-identical to the showback row for the same centre and period. See
 * `server-core/src/cost/invoices.ts`.
 *
 * Scope is **exclusive across managed accounts**: a cost centre or an account
 * belongs to at most one customer. Billing the same money to two customers is
 * not a state worth being able to represent, so it is refused at write time
 * rather than detected later.
 *
 * ## An invoice freezes
 *
 * Cost data restates for days after the fact — a provider revises a bill, a
 * late line lands, an allocation rule is corrected. A **draft** invoice
 * recomputes from live spend on every read, which is what makes it a working
 * document. Approval is the freeze: the computed lines, the totals, the
 * exchange rates and their date, the billing rules in force, and the names of
 * everything in scope are written onto the row, and every later read returns
 * exactly those bytes. Nothing about an approved, sent or void invoice is ever
 * recomputed.
 *
 * The corollary is that an issued invoice is never edited and never deleted. A
 * wrong one is **voided** and superseded by a corrective invoice; both stay.
 * {@link managedInvoiceBlocker} is the single statement of that rule, shared by
 * the service that enforces it and the UI that greys the buttons out, so the
 * two cannot drift.
 */

import type { CostBasis } from "./costs";
import type { CostAdjustmentRule } from "./billing-rules";

/* ------------------------------------------------------------------ *
 * Managed accounts
 * ------------------------------------------------------------------ */

/** Bounds the API enforces on a managed account. */
export const MANAGED_ACCOUNT_LIMITS = {
  maxNameLength: 120,
  maxContactNameLength: 120,
  maxContactEmailLength: 254,
  maxAddressLength: 1000,
  maxNotesLength: 4000,
  /** Cost centres one customer may be billed for. */
  maxCostCentres: 100,
  /** Cloud accounts one customer may be billed for. */
  maxAccounts: 100,
  /** Customers per organisation. */
  maxPerOrg: 500,
} as const;

/** Create/update payload for a managed account. */
export interface ManagedAccountInput {
  name: string;
  contactName?: string | null | undefined;
  contactEmail?: string | null | undefined;
  /** Postal / billing address, free text, printed on the invoice. */
  billingAddress?: string | null | undefined;
  /** ISO 4217 code the customer is invoiced in. */
  billingCurrency: string;
  /**
   * Which basis this customer's invoices are drawn on. Amortized is the
   * defensible default for a managed service: charging a customer the whole
   * cash value of a three-year commitment in the month it was signed is not a
   * bill anyone can budget against.
   */
  costBasis?: CostBasis | undefined;
  /**
   * Whether the org's billing rules (markups, discounts, fixed charges,
   * reallocations) apply to this customer's invoices.
   *
   * On by default — a managed service provider's markup is the entire reason
   * the rules exist. Off means the customer is billed exactly what the
   * providers charged, which is what a pass-through contract says.
   */
  applyBillingRules?: boolean | undefined;
  notes?: string | null | undefined;
  /** Cost centres whose spend is this customer's. Subtrees are included. */
  costCentreIds: string[];
  /** Cloud accounts whose otherwise-unallocated spend is this customer's. */
  accountIds: string[];
}

/** A managed account as returned by the API. */
export interface ManagedAccount {
  id: string;
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
  /** Invoices raised for this customer, any status. */
  invoiceCount: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Invoices
 * ------------------------------------------------------------------ */

export const MANAGED_INVOICE_STATUSES = ["draft", "approved", "sent", "void"] as const;
export type ManagedInvoiceStatus = (typeof MANAGED_INVOICE_STATUSES)[number];

export const MANAGED_INVOICE_STATUS_LABELS: Record<ManagedInvoiceStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  sent: "Sent",
  void: "Void",
};

/** Bounds the API enforces on an invoice. */
export const MANAGED_INVOICE_LIMITS = {
  maxNotesLength: 4000,
  maxVoidReasonLength: 1000,
  /** Longest period one invoice may cover. A year of daily spend, at most. */
  maxPeriodDays: 366,
} as const;

/** What produced one line of an invoice. */
export type ManagedInvoiceLineKind = "cost_centre" | "account" | "fixed";

/**
 * One line of an invoice: one scope entry, in one collected currency.
 *
 * A customer whose spend arrived in two currencies gets two lines for the same
 * cost centre rather than one blended line, because the conversion is a
 * separate, individually reconcilable step and hiding it would make the
 * arithmetic unreproducible.
 *
 * The identity every line satisfies, and which
 * {@link managedInvoiceReconciles} asserts over the whole invoice:
 *
 * ```
 * collected + adjustment === adjusted
 * billed === adjusted × rate      (when rate is non-null)
 * ```
 */
export interface ManagedInvoiceLine {
  kind: ManagedInvoiceLineKind;
  /** Cost-centre id, account id, or null for an org-level fixed charge. */
  refId: string | null;
  /**
   * The name at issue time. Frozen with the numbers: renaming a cost centre in
   * March must not silently retitle a line on January's invoice.
   */
  label: string;
  /** The currency the providers billed in. */
  currency: string;
  /** What the providers charged for this scope, before any billing rule. */
  collected: number;
  /** What the org's billing rules added (positive) or removed (negative). */
  adjustment: number;
  /** `collected + adjustment` — the figure that is then converted. */
  adjusted: number;
  /**
   * The rate applied to reach {@link billed}. `1` when the line is already in
   * the invoice currency; **null** when the org has stated no rate for this
   * currency, in which case `billed` is null too and the line is carried in its
   * own currency rather than silently dropped or invented.
   */
  rate: number | null;
  /** `adjusted × rate`, in the invoice currency. Null when unconvertible. */
  billed: number | null;
}

/**
 * The four totals an invoice reports, each keyed by currency.
 *
 * `collected`, `adjustment` and `adjusted` are keyed by the **collected**
 * currency; `billed` is keyed by the invoice currency (plus any currency that
 * could not be converted, which keeps its own key so the sum is never short).
 */
export interface ManagedInvoiceTotals {
  collected: Record<string, number>;
  adjustment: Record<string, number>;
  adjusted: Record<string, number>;
  billed: Record<string, number>;
}

/** One exchange rate frozen onto an invoice. */
export interface ManagedInvoiceRate {
  currency: string;
  rate: number;
  /** The `effective_from` of the org rate row that was used. */
  effectiveFrom: string;
}

/**
 * Everything needed to re-derive the invoice by hand.
 *
 * This is not decoration. An invoice a customer cannot reconcile is an invoice
 * a customer does not pay, so the collected figure, the rules that moved it,
 * the rates that converted it and the day those rates were read are all part of
 * the document — not a query someone could re-run later and get a different
 * answer from.
 */
export interface ManagedInvoiceDerivation {
  costBasis: CostBasis;
  /** Whether the org's billing rules were applied at all. */
  applyBillingRules: boolean;
  /**
   * The day the exchange rates were read off — always the last day of the
   * period. One rate for the period, not a per-day blend: "January, at the
   * 31 January rate" is a sentence a finance team can defend and reproduce.
   */
  rateDate: string;
  rates: ManagedInvoiceRate[];
  /**
   * Currencies the org had stated no usable rate for on {@link rateDate}. Their
   * amounts stay in their own currency in `totals.billed`. A non-empty list
   * blocks approval — see {@link managedInvoiceBlocker}.
   */
  unconverted: string[];
  /** The enabled billing rules in force, in evaluation order, at issue time. */
  rules: CostAdjustmentRule[];
  /** The scope, with the names it had at issue time. */
  scope: {
    costCentres: Array<{ id: string; name: string }>;
    accounts: Array<{ id: string; label: string }>;
  };
  /**
   * Cost centres that were in scope when the invoice was drawn but no longer
   * exist, or accounts that have been removed. Empty on a fresh draft; on a
   * frozen invoice it is simply the historical record.
   */
  missingScope: string[];
}

/** A full invoice, lines included. */
export interface ManagedInvoice {
  id: string;
  managedAccountId: string;
  /** The customer's name at issue time, frozen with the rest. */
  managedAccountName: string;
  /**
   * The human invoice number, `INV-2026-0001`. **Null while draft**: numbers
   * are assigned at approval so a deleted draft cannot leave a gap in the
   * sequence, which is the one thing an auditor will notice immediately.
   */
  number: string | null;
  status: ManagedInvoiceStatus;
  /** Inclusive YYYY-MM-DD period. */
  periodFrom: string;
  periodTo: string;
  /** The invoice currency, frozen at approval from the customer's setting. */
  currency: string;
  notes: string | null;
  lines: ManagedInvoiceLine[];
  totals: ManagedInvoiceTotals;
  derivation: ManagedInvoiceDerivation;
  /**
   * True when the figures above were recomputed for this response — which is
   * true for a draft and false for everything else. A client should say so:
   * "these numbers will move" and "these numbers are what we sent" are
   * different claims about the same fields.
   */
  live: boolean;
  /** When the figures were produced: now for a draft, issue time otherwise. */
  computedAt: string;
  issuedAt: string | null;
  approvedByUserId: string | null;
  sentAt: string | null;
  sentByUserId: string | null;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  /** The invoice this one corrects, when it was raised to supersede one. */
  supersedesInvoiceId: string | null;
  /** The corrective invoice raised for this one, when it was voided. */
  supersededByInvoiceId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The list row. Deliberately without `lines` and `derivation`: a draft's
 * figures are recomputed on read, and recomputing every draft in the list would
 * turn opening the page into one ClickHouse scan per draft.
 *
 * `totals` is therefore **null for a draft** — not zero, not stale. Null is the
 * honest answer to "what does this draft come to" from a list query, and the
 * detail view answers it properly.
 */
export interface ManagedInvoiceSummary {
  id: string;
  managedAccountId: string;
  managedAccountName: string;
  number: string | null;
  status: ManagedInvoiceStatus;
  periodFrom: string;
  periodTo: string;
  currency: string;
  totals: ManagedInvoiceTotals | null;
  issuedAt: string | null;
  sentAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  supersedesInvoiceId: string | null;
  supersededByInvoiceId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create payload for an invoice. Always lands in `draft`. */
export interface ManagedInvoiceInput {
  managedAccountId: string;
  periodFrom: string;
  periodTo: string;
  notes?: string | null | undefined;
  /** The invoice this one corrects, when raised from a void. */
  supersedesInvoiceId?: string | null | undefined;
}

/** Update payload for a draft. Scope and currency come from the customer. */
export interface ManagedInvoiceUpdate {
  periodFrom: string;
  periodTo: string;
  notes?: string | null | undefined;
}

/* ------------------------------------------------------------------ *
 * The state machine, stated once
 * ------------------------------------------------------------------ */

/** Every act that can be attempted on an invoice. */
export type ManagedInvoiceAction = "edit" | "delete" | "approve" | "send" | "void";

/**
 * Why `action` is not allowed on an invoice in `status`, or null when it is.
 *
 * One function, used by the service to refuse and by the UI to disable, because
 * a UI that hides a button the server would have allowed is a missing feature
 * while a UI that offers one the server refuses is a bug report. The server
 * calls this too — the rule is enforced server-side, not merely presented.
 *
 * The transitions, in full:
 *
 * ```
 *  draft ──approve──▶ approved ──send──▶ sent
 *    │                    │                │
 *    │                    └──void──▶ void ◀┘
 *    └──edit, delete (draft only)
 * ```
 *
 * `unconvertedCurrencies` blocks approval on its own: an invoice carrying an
 * amount in a currency the org has stated no rate for cannot be expressed as
 * one number in the customer's currency, and approving it would freeze a total
 * nobody can quote.
 */
export function managedInvoiceBlocker(
  invoice: Pick<ManagedInvoice, "status"> & {
    derivation?: Pick<ManagedInvoiceDerivation, "unconverted"> | undefined;
  },
  action: ManagedInvoiceAction,
): string | null {
  const { status } = invoice;

  if (status === "void") {
    return action === "void"
      ? "This invoice is already void."
      : "A void invoice is a historical record. Raise a corrective invoice instead.";
  }

  switch (action) {
    case "edit":
    case "delete":
      if (status !== "draft") {
        return (
          `This invoice has been ${status === "sent" ? "sent to the customer" : "approved"}, so ` +
          "its figures are frozen and it can no longer be " +
          `${action === "edit" ? "edited" : "deleted"}. Void it and raise a corrective invoice.`
        );
      }
      return null;

    case "approve": {
      if (status !== "draft") return "Only a draft invoice can be approved.";
      const unconverted = invoice.derivation?.unconverted ?? [];
      if (unconverted.length > 0) {
        return (
          `This invoice holds spend in ${unconverted.join(", ")}, and the organisation has ` +
          "stated no exchange rate for it on the period's last day. Approving would freeze a " +
          "total that cannot be expressed in the customer's currency. Add the rate in " +
          "Settings → Currency, then approve."
        );
      }
      return null;
    }

    case "send":
      if (status === "draft") {
        return "Approve this invoice before sending it — the figures are not frozen yet.";
      }
      if (status === "sent") return "This invoice has already been marked as sent.";
      return null;

    case "void":
      if (status === "draft") {
        return "A draft was never issued, so there is nothing to void. Delete it instead.";
      }
      return null;
  }
}

/** Whether an invoice's figures are stored rather than recomputed on read. */
export function managedInvoiceIsFrozen(status: ManagedInvoiceStatus): boolean {
  return status !== "draft";
}

/* ------------------------------------------------------------------ *
 * Arithmetic — pure, so the reconciliation is testable without a database
 * ------------------------------------------------------------------ */

/** Six places, matching `cost/currency-convert.ts`, so totals agree everywhere. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function add(into: Record<string, number>, currency: string, amount: number): void {
  into[currency] = round6((into[currency] ?? 0) + amount);
}

/**
 * Fold lines into the four totals.
 *
 * `billed` is keyed by `invoiceCurrency` for every convertible line and by the
 * line's own currency for the rest, so an unconvertible currency is visibly
 * carried rather than quietly dropped out of the sum.
 */
export function sumManagedInvoiceLines(
  lines: readonly ManagedInvoiceLine[],
  invoiceCurrency: string,
): ManagedInvoiceTotals {
  const totals: ManagedInvoiceTotals = {
    collected: {},
    adjustment: {},
    adjusted: {},
    billed: {},
  };
  for (const line of lines) {
    add(totals.collected, line.currency, line.collected);
    add(totals.adjustment, line.currency, line.adjustment);
    add(totals.adjusted, line.currency, line.adjusted);
    if (line.billed === null) add(totals.billed, line.currency, line.adjusted);
    else add(totals.billed, invoiceCurrency, line.billed);
  }
  return totals;
}

/**
 * Whether `collected + adjustment === adjusted` holds for every currency.
 *
 * The one identity the whole feature rests on: an invoice a customer can walk
 * back to the spend that produced it. Checked in tests, and by the service
 * before it freezes anything — a figure that fails this must never be approved.
 *
 * Compared with a tolerance because the amounts are already rounded to six
 * places on the way in and summing many of them accumulates a little below
 * that; anything larger than half a millionth is a genuine disagreement.
 */
export function managedInvoiceReconciles(totals: ManagedInvoiceTotals): boolean {
  const currencies = new Set([
    ...Object.keys(totals.collected),
    ...Object.keys(totals.adjustment),
    ...Object.keys(totals.adjusted),
  ]);
  for (const currency of currencies) {
    const expected = (totals.collected[currency] ?? 0) + (totals.adjustment[currency] ?? 0);
    if (Math.abs(expected - (totals.adjusted[currency] ?? 0)) > 5e-7) return false;
  }
  return true;
}

/**
 * `INV-2026-0001`.
 *
 * Per organisation, per calendar year of the **period end** — not of the day
 * the button was pressed, so December's invoice approved on 3 January is still
 * a December number and the year's sequence does not develop a tail.
 */
export function formatManagedInvoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(4, "0")}`;
}

/** Parse the sequence back out of a number; null when it isn't one of ours. */
export function parseManagedInvoiceNumber(
  value: string,
): { year: number; sequence: number } | null {
  const m = /^INV-(\d{4})-(\d{4,})$/.exec(value);
  if (!m) return null;
  return { year: Number(m[1]), sequence: Number(m[2]) };
}

/**
 * A one-line summary of what an invoice comes to, for a list row or a terminal.
 * Falls back to the status when a draft has not been computed yet.
 */
export function describeManagedInvoiceTotal(
  totals: ManagedInvoiceTotals | null,
  currency: string,
): string {
  if (!totals) return "not computed";
  const entries = Object.entries(totals.billed).filter(([, amount]) => amount !== 0);
  if (entries.length === 0) return `0 ${currency}`;
  return entries
    .sort(([a], [b]) => (a === currency ? -1 : b === currency ? 1 : a.localeCompare(b)))
    .map(([code, amount]) => `${amount.toFixed(2)} ${code}`)
    .join(" + ");
}

/**
 * The scope entries `candidate` would claim that `others` already claim.
 *
 * Exclusivity is checked here rather than with a database constraint because
 * the scope is two arrays on one row: a unique index would need a third table
 * whose only job is to be unique, and the error a user needs to read names the
 * *other customer*, which a constraint violation cannot.
 */
export function managedAccountScopeConflicts(
  candidate: { costCentreIds: readonly string[]; accountIds: readonly string[] },
  others: ReadonlyArray<Pick<ManagedAccount, "id" | "name" | "costCentreIds" | "accountIds">>,
): Array<{ kind: "cost_centre" | "account"; id: string; ownerName: string }> {
  const conflicts: Array<{ kind: "cost_centre" | "account"; id: string; ownerName: string }> = [];
  for (const other of others) {
    for (const id of candidate.costCentreIds) {
      if (other.costCentreIds.includes(id)) {
        conflicts.push({ kind: "cost_centre", id, ownerName: other.name });
      }
    }
    for (const id of candidate.accountIds) {
      if (other.accountIds.includes(id)) {
        conflicts.push({ kind: "account", id, ownerName: other.name });
      }
    }
  }
  return conflicts;
}

/**
 * Drop scope centres that sit inside another selected centre's subtree.
 *
 * An invoice line quotes a centre's **subtree** total, so billing both
 * "Engineering" and "Engineering → Platform" would charge Platform twice. The
 * ancestor wins: it is the broader statement of what the customer bought.
 */
export function dedupeScopeCentres(
  selected: readonly string[],
  parentOf: ReadonlyMap<string, string | null>,
): string[] {
  const chosen = new Set(selected);
  return selected.filter((id) => {
    // Walk up; if any ancestor is also selected, this one is redundant.
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      if (chosen.has(cursor)) return false;
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    return true;
  });
}
