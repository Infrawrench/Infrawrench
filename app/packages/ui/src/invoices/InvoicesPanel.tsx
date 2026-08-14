import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";

import {
  MANAGED_INVOICE_DELIVERY_STATUS_LABELS,
  MANAGED_INVOICE_STATUS_LABELS,
  costCentrePaths,
  describeManagedInvoiceTotal,
  managedInvoiceBlocker,
  managedInvoiceDeliveryRetryable,
  type CostCentre,
  type ManagedAccount,
  type ManagedAccountInput,
  type ManagedInvoice,
  type ManagedInvoiceDelivery,
  type ManagedInvoiceStatus,
  type ManagedInvoiceSummary,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { InvoiceScopeAccount, InvoicesClient } from "./types.js";

/* ------------------------------------------------------------------ *
 * Small shared bits
 * ------------------------------------------------------------------ */

const STATUS_CLASS: Record<ManagedInvoiceStatus, string> = {
  draft: "text-on-surface-faint",
  approved: "text-info",
  sent: "text-success",
  void: "text-danger",
};

function StatusChip({ status }: { status: ManagedInvoiceStatus }) {
  return (
    <span className={`text-xs uppercase tracking-wide ${STATUS_CLASS[status]}`}>
      {MANAGED_INVOICE_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * The delivery record, stated in full.
 *
 * A "Sent" chip on an invoice nobody received is the failure mode this feature
 * would otherwise introduce, so the outcome is printed next to the status
 * rather than hidden behind a tooltip: which addresses, how many took it, and
 * the transport's own error when it did not.
 */
function DeliveryNote({ delivery }: { delivery: ManagedInvoiceDelivery | null }) {
  const gt = useGT();
  if (!delivery) {
    return (
      <p className="text-xs text-on-surface-faint">
        {gt(
          "No delivery has been attempted from here. Sending emails the invoice to the customer's contact addresses with the CSV attached.",
        )}
      </p>
    );
  }
  const tone =
    delivery.status === "succeeded"
      ? "text-success"
      : delivery.status === "partial"
        ? "text-warning"
        : delivery.status === "pending"
          ? "text-warning"
          : "text-danger";
  const recipientsLine =
    delivery.recipients.length === 1
      ? gt("{label} — {delivered} of {count} recipient on {date} (attempt {attempts})", {
          label: MANAGED_INVOICE_DELIVERY_STATUS_LABELS[delivery.status],
          delivered: delivery.delivered,
          count: delivery.recipients.length,
          date: new Date(delivery.attemptedAt).toLocaleString(),
          attempts: delivery.attempts,
        })
      : gt("{label} — {delivered} of {count} recipients on {date} (attempt {attempts})", {
          label: MANAGED_INVOICE_DELIVERY_STATUS_LABELS[delivery.status],
          delivered: delivery.delivered,
          count: delivery.recipients.length,
          date: new Date(delivery.attemptedAt).toLocaleString(),
          attempts: delivery.attempts,
        });
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-xs ${tone}`}>{recipientsLine}</p>
      {delivery.recipients.length > 0 && (
        <p className="text-xs text-on-surface-faint">{delivery.recipients.join(", ")}</p>
      )}
      {delivery.error !== null && <p className="text-xs text-on-surface-faint">{delivery.error}</p>}
    </div>
  );
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Add or remove `id`, keeping the list itself as the source of truth: click
 * order is what gets sent and stored, so membership is tested against a set
 * built from the list rather than the list being rebuilt from a set.
 */
function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The last complete calendar month — the period an invoice almost always covers. */
function lastMonth(): { from: string; to: string } {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

const BTN =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50";
const FIELD =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export interface InvoicesPanelProps {
  client: InvoicesClient;
  /**
   * Which invoice to show. Absent renders the list. Owned by the host so the
   * URL, the workspace tab and this panel never disagree about which invoice is
   * open — the same contract the Cost reports panel uses.
   */
  invoiceId?: string | undefined;
  /** Open an invoice (or, with undefined, go back to the list). */
  onSelectInvoice?: ((invoiceId: string | undefined) => void) | undefined;
}

/**
 * Managed accounts and their invoices.
 *
 * Two things this panel is careful about, because getting either wrong is how a
 * customer stops trusting the number:
 *
 * 1. **It says whether the figures are live.** A draft recomputes from spend on
 *    every read and will keep moving; an approved invoice is frozen. Both are
 *    rendered in the same table, so the difference is stated in words rather
 *    than left for the reader to infer.
 * 2. **It shows the derivation, always.** Collected, what the billing rules
 *    added, and the invoiced figure sit next to each other on every line, and
 *    the rate and the day it was read are printed under the total. A total
 *    nobody can explain is a total nobody will pay.
 *
 * Actions are driven by {@link managedInvoiceBlocker} — the same function the
 * server refuses with — so a disabled button and a 409 always say the same
 * sentence, and neither can drift from the other.
 */
export function InvoicesPanel({ client, invoiceId, onSelectInvoice }: InvoicesPanelProps) {
  const gt = useGT();
  const [accounts, setAccounts] = useState<ManagedAccount[] | null>(null);
  const [invoices, setInvoices] = useState<ManagedInvoiceSummary[] | null>(null);
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [cloudAccounts, setCloudAccounts] = useState<InvoiceScopeAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<{ account: ManagedAccount | null } | null>(
    null,
  );
  const [raising, setRaising] = useState<ManagedAccount | null>(null);

  const canWrite = Boolean(client.createManagedAccount && client.createInvoice);
  const canIssue = Boolean(client.approveInvoice && client.sendInvoice && client.voidInvoice);

  const refresh = useCallback(async () => {
    // A failure has to be visible: an empty list and a broken list look
    // identical, and one of them means invoices you raised are not being shown.
    try {
      const [accountRows, invoiceRows] = await Promise.all([
        client.listManagedAccounts(),
        client.listInvoices(),
      ]);
      setAccounts(accountRows);
      setInvoices(invoiceRows);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // The two picker lists are fetched separately and their failures swallowed:
    // cost centres ride `costs:read` and accounts ride `accounts:read`, neither
    // of which an invoices-only role necessarily holds. Losing a picker should
    // cost you the ability to *edit* a customer's scope, not the ability to see
    // this month's invoices — which is what folding them into the load above
    // would have done.
    const [centreRows, cloudRows] = await Promise.all([
      client.listCostCentres().catch(() => [] as CostCentre[]),
      client.listAccounts().catch(() => [] as InvoiceScopeAccount[]),
    ]);
    setCentres(centreRows);
    setCloudAccounts(cloudRows);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveAccount(input: ManagedAccountInput) {
    const target = editingAccount?.account;
    if (target) await client.updateManagedAccount?.(target.id, input);
    else await client.createManagedAccount?.(input);
    setEditingAccount(null);
    await refresh();
  }

  async function retireAccount(account: ManagedAccount) {
    const confirmMessage =
      account.invoiceCount === 0
        ? gt('Retire "{name}"?', { name: account.name })
        : account.invoiceCount === 1
          ? gt(
              'Retire "{name}"?\n\n1 invoice raised for this customer will be kept — an issued invoice names its customer, so the record stays.',
              { name: account.name },
            )
          : gt(
              'Retire "{name}"?\n\n{count} invoices raised for this customer will be kept — an issued invoice names its customer, so the record stays.',
              { name: account.name, count: account.invoiceCount },
            );
    if (!window.confirm(confirmMessage)) return;
    try {
      await client.deleteManagedAccount?.(account.id);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function raiseInvoice(account: ManagedAccount, from: string, to: string, notes: string) {
    const created = await client.createInvoice?.({
      managedAccountId: account.id,
      periodFrom: from,
      periodTo: to,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    setRaising(null);
    await refresh();
    // Land on the draft: the user just described a period and wants to see what
    // it comes to before deciding whether to approve it.
    if (created) onSelectInvoice?.(created.id);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            <T>
              <span>
                Couldn&rsquo;t load invoices — <Var>{error}</Var>
              </span>
            </T>{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              {gt("Retry")}
            </button>
          </div>
        )}

        {invoiceId ? (
          <InvoiceDetail
            key={invoiceId}
            invoiceId={invoiceId}
            client={client}
            canWrite={canWrite}
            canIssue={canIssue}
            onBack={() => onSelectInvoice?.(undefined)}
            onOpenInvoice={(id) => onSelectInvoice?.(id)}
            onChanged={refresh}
          />
        ) : (
          <>
            <CustomerList
              accounts={accounts}
              centres={centres}
              canWrite={canWrite}
              onNew={() => setEditingAccount({ account: null })}
              onEdit={(a) => setEditingAccount({ account: a })}
              onRetire={(a) => void retireAccount(a)}
              onRaise={setRaising}
            />
            <InvoiceList invoices={invoices} onOpen={(id) => onSelectInvoice?.(id)} />
          </>
        )}
      </div>

      {editingAccount && (
        <CustomerModal
          account={editingAccount.account}
          centres={centres}
          cloudAccounts={cloudAccounts}
          onSave={saveAccount}
          onClose={() => setEditingAccount(null)}
        />
      )}

      {raising && (
        <RaiseInvoiceModal
          account={raising}
          onRaise={(from, to, notes) => raiseInvoice(raising, from, to, notes)}
          onClose={() => setRaising(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Customers
 * ------------------------------------------------------------------ */

function CustomerList({
  accounts,
  centres,
  canWrite,
  onNew,
  onEdit,
  onRetire,
  onRaise,
}: {
  accounts: ManagedAccount[] | null;
  centres: CostCentre[];
  canWrite: boolean;
  onNew: () => void;
  onEdit: (account: ManagedAccount) => void;
  onRetire: (account: ManagedAccount) => void;
  onRaise: (account: ManagedAccount) => void;
}) {
  const gt = useGT();
  const centreName = useMemo(() => new Map(centres.map((c) => [c.id, c.name])), [centres]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-on-surface">{gt("Customers")}</h2>
          <p className="text-xs text-on-surface-faint">
            {gt(
              "Each customer is billed for the cost centres they own. Which spend lands in a centre is decided by the allocation rules — a customer names centres, never rules.",
            )}
          </p>
        </div>
        {canWrite && (
          <button type="button" className={BTN} onClick={onNew}>
            {gt("New customer")}
          </button>
        )}
      </div>

      {accounts === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No managed accounts yet. Add one to bill a customer for the infrastructure you run on their behalf.",
          )}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {accounts.map((account) => (
            <div key={account.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-on-surface">{account.name}</span>
                  <span className="text-xs text-on-surface-faint">{account.billingCurrency}</span>
                  {!account.applyBillingRules && (
                    <span className="text-xs text-on-surface-faint">{gt("· pass-through")}</span>
                  )}
                </div>
                <div className="truncate text-xs text-on-surface-faint">
                  {account.costCentreIds.length === 0 && account.accountIds.length === 0
                    ? gt("No scope — invoices for this customer will be empty")
                    : [
                        ...account.costCentreIds.map((id) => centreName.get(id) ?? id),
                        ...account.accountIds.map((id) =>
                          gt("account {id}", { id: id.slice(0, 8) }),
                        ),
                      ].join(", ")}
                </div>
              </div>
              <span className="text-xs text-on-surface-faint">
                {account.invoiceCount === 1
                  ? gt("1 invoice")
                  : gt("{count} invoices", { count: account.invoiceCount })}
              </span>
              {canWrite && (
                <>
                  <button type="button" className={BTN} onClick={() => onRaise(account)}>
                    {gt("Raise invoice")}
                  </button>
                  <button type="button" className={BTN} onClick={() => onEdit(account)}>
                    {gt("Edit")}
                  </button>
                  <button type="button" className={BTN} onClick={() => onRetire(account)}>
                    {gt("Retire")}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CustomerModal({
  account,
  centres,
  cloudAccounts,
  onSave,
  onClose,
}: {
  account: ManagedAccount | null;
  centres: CostCentre[];
  cloudAccounts: InvoiceScopeAccount[];
  onSave: (input: ManagedAccountInput) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState(account?.name ?? "");
  const [contactName, setContactName] = useState(account?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(account?.contactEmail ?? "");
  const [billingAddress, setBillingAddress] = useState(account?.billingAddress ?? "");
  const [currency, setCurrency] = useState(account?.billingCurrency ?? "USD");
  const [costBasis, setCostBasis] = useState(account?.costBasis ?? "amortized");
  const [applyRules, setApplyRules] = useState(account?.applyBillingRules ?? true);
  const [centreIds, setCentreIds] = useState<string[]>(account?.costCentreIds ?? []);
  const [accountIds, setAccountIds] = useState<string[]>(account?.accountIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Indented by path so "Engineering → Platform" reads as nesting rather than
  // as two unrelated names that happen to sort together.
  const paths = useMemo(() => costCentrePaths(centres), [centres]);

  // Membership only — the arrays stay authoritative because the order a
  // customer's scope was picked in is what is persisted and sent back.
  const centreIdSet = useMemo(() => new Set(centreIds), [centreIds]);
  const accountIdSet = useMemo(() => new Set(accountIds), [accountIds]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null,
        billingAddress: billingAddress.trim() || null,
        billingCurrency: currency.trim().toUpperCase(),
        costBasis,
        applyBillingRules: applyRules,
        costCentreIds: centreIds,
        accountIds,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      ariaLabel={account ? gt("Edit {name}", { name: account.name }) : gt("New customer")}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
          {gt("Name")}
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Contact name")}
            <input
              className={FIELD}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Contact email")}
            <input
              className={FIELD}
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
          {gt("Billing address")}
          <textarea
            className={FIELD}
            rows={2}
            value={billingAddress}
            onChange={(e) => setBillingAddress(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Billing currency")}
            <input
              className={FIELD}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={3}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Cost basis")}
            <select
              className={FIELD}
              value={costBasis}
              onChange={(e) => setCostBasis(e.target.value as "cash" | "amortized")}
            >
              <option value="amortized">{gt("Amortized")}</option>
              <option value="cash">{gt("Cash")}</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs text-on-surface-faint">
          <input
            type="checkbox"
            checked={applyRules}
            onChange={(e) => setApplyRules(e.target.checked)}
          />
          {gt(
            "Apply the organisation’s billing rules (markups, discounts, fixed fees). Off is a pass-through contract: billed exactly what the providers charged.",
          )}
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-faint">
            {gt("Cost centres — naming a parent bills its whole subtree")}
          </span>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-surface-sunken p-2">
            {paths.length === 0 ? (
              <p className="text-xs text-on-surface-faint">
                {gt(
                  "No cost centres defined. Define them in Settings → Tag policy first; a customer references centres rather than matching spend itself.",
                )}
              </p>
            ) : (
              paths.map((row) => (
                <label
                  key={row.id}
                  className="flex items-center gap-2 py-0.5 text-sm text-on-surface"
                  style={{ paddingLeft: `${row.depth * 12}px` }}
                  title={row.path}
                >
                  <input
                    type="checkbox"
                    checked={centreIdSet.has(row.id)}
                    onChange={() => setCentreIds((ids) => toggle(ids, row.id))}
                  />
                  {row.name}
                </label>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-faint">
            {gt("Cloud accounts — claims only spend no cost centre already claimed")}
          </span>
          <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-surface-sunken p-2">
            {cloudAccounts.length === 0 ? (
              <p className="text-xs text-on-surface-faint">{gt("No connected accounts.")}</p>
            ) : (
              cloudAccounts.map((a) => (
                <label
                  key={a.id}
                  className="flex items-center gap-2 py-0.5 text-sm text-on-surface"
                >
                  <input
                    type="checkbox"
                    checked={accountIdSet.has(a.id)}
                    onChange={() => setAccountIds((ids) => toggle(ids, a.id))}
                  />
                  {a.displayName}
                  <span className="text-xs text-on-surface-faint">{a.pluginId}</span>
                </label>
              ))
            )}
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            className={BTN}
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? gt("Saving…") : gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RaiseInvoiceModal({
  account,
  onRaise,
  onClose,
}: {
  account: ManagedAccount;
  onRaise: (from: string, to: string, notes: string) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const defaults = useMemo(lastMonth, []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal ariaLabel={gt("Raise an invoice for {name}", { name: account.name })} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <T>
          <p className="text-xs text-on-surface-faint">
            This raises a <strong>draft</strong>. Its figures recompute from live spend every time
            you open it, and nothing is frozen until you approve it.
          </p>
        </T>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Period from")}
            <input
              type="date"
              className={FIELD}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
            {gt("Period to")}
            <input
              type="date"
              className={FIELD}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
          {gt("Notes (printed on the invoice)")}
          <textarea
            className={FIELD}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onRaise(from, to, notes)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? gt("Raising…") : gt("Raise draft")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Invoice list
 * ------------------------------------------------------------------ */

function InvoiceList({
  invoices,
  onOpen,
}: {
  invoices: ManagedInvoiceSummary[] | null;
  onOpen: (invoiceId: string) => void;
}) {
  const gt = useGT();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-on-surface">{gt("Invoices")}</h2>
      {invoices === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : invoices.length === 0 ? (
        <p className="text-sm text-on-surface-faint">{gt("No invoices yet.")}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {invoices.map((invoice) => (
            <button
              key={invoice.id}
              type="button"
              onClick={() => onOpen(invoice.id)}
              className="flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-raised"
            >
              <span className="w-32 shrink-0 text-sm text-on-surface">
                {invoice.number ?? <span className="text-on-surface-faint">{gt("draft")}</span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
                {invoice.managedAccountName}
              </span>
              <span className="text-xs text-on-surface-faint">
                {invoice.periodFrom} → {invoice.periodTo}
              </span>
              <span className="w-36 shrink-0 text-right text-sm text-on-surface">
                {/* Null totals, not zero: a draft's figures are recomputed on
                    read and the list does not recompute. Saying "not computed"
                    is the honest answer; "0.00" would be a lie. */}
                {invoice.totals
                  ? describeManagedInvoiceTotal(invoice.totals, invoice.currency)
                  : "—"}
              </span>
              <span className="flex w-28 shrink-0 items-center justify-end gap-2">
                {/* A failed delivery has to be visible from the list: an
                    invoice that says "Sent" and never reached anyone is the
                    one thing nobody would think to go looking for. */}
                {invoice.delivery && managedInvoiceDeliveryRetryable(invoice.delivery) && (
                  <span className="text-xs uppercase tracking-wide text-danger">
                    {MANAGED_INVOICE_DELIVERY_STATUS_LABELS[invoice.delivery.status]}
                  </span>
                )}
                <StatusChip status={invoice.status} />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Invoice detail
 * ------------------------------------------------------------------ */

function InvoiceDetail({
  invoiceId,
  client,
  canWrite,
  canIssue,
  onBack,
  onOpenInvoice,
  onChanged,
}: {
  invoiceId: string;
  client: InvoicesClient;
  canWrite: boolean;
  canIssue: boolean;
  onBack: () => void;
  onOpenInvoice: (invoiceId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const gt = useGT();
  const [invoice, setInvoice] = useState<ManagedInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const load = useCallback(async () => {
    try {
      setInvoice(await client.getInvoice(invoiceId));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      await onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!invoice) {
    return (
      <div className="flex flex-col gap-3">
        <button type="button" className={BTN + " self-start"} onClick={onBack}>
          {gt("← All invoices")}
        </button>
        {error !== null ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        )}
      </div>
    );
  }

  // The same function the server refuses with, so a greyed button and a 409
  // always say the same sentence.
  const approveBlocker = managedInvoiceBlocker(invoice, "approve");
  const sendBlocker = managedInvoiceBlocker(invoice, "send");
  // The server allows a second copy with `resend`, so the button is offered
  // whenever only that flag stands in the way — with a confirmation, because
  // the thing being written to is a customer's inbox. A void invoice is refused
  // either way, and this asks the same function the server does.
  const resendBlocker = managedInvoiceBlocker(invoice, "send", { resend: true });
  const needsResendConfirm = sendBlocker !== null && resendBlocker === null;
  const isRetry = invoice.status === "sent" && managedInvoiceDeliveryRetryable(invoice.delivery);
  const sendLabel = needsResendConfirm
    ? gt("Send again")
    : isRetry
      ? gt("Retry delivery")
      : gt("Send");
  const voidBlocker = managedInvoiceBlocker(invoice, "void");
  const deleteBlocker = managedInvoiceBlocker(invoice, "delete");
  const exportUrl = client.invoiceExportUrl?.(invoice.id);

  return (
    <div className="flex flex-col gap-5">
      <button type="button" className={BTN + " self-start"} onClick={onBack}>
        {gt("← All invoices")}
      </button>

      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-on-surface">
            {invoice.number ?? gt("Draft invoice")}
          </h1>
          <StatusChip status={invoice.status} />
        </div>
        <p className="text-sm text-on-surface">{invoice.managedAccountName}</p>
        <p className="text-xs text-on-surface-faint">
          {invoice.periodFrom} → {invoice.periodTo} · {invoice.derivation.costBasis} basis
        </p>
        {/* The one sentence that separates a working document from a sent one. */}
        <p className="text-xs text-on-surface-faint">
          {invoice.live
            ? gt(
                "Draft — these figures are recomputed from live spend every time this page loads, and will keep moving as providers restate. Approving freezes them.",
              )
            : gt(
                "Frozen at approval on {date}. Nothing that happens to spend, exchange rates, billing rules or names can change what this document says.",
                { date: new Date(invoice.computedAt).toLocaleString() },
              )}
        </p>
        {invoice.status === "void" && invoice.voidReason && (
          <p className="text-xs text-danger">
            {gt("Voided — {reason}", { reason: invoice.voidReason })}
          </p>
        )}
        {invoice.status !== "draft" && <DeliveryNote delivery={invoice.delivery} />}
        {invoice.supersededByInvoiceId && (
          <button
            type="button"
            className="self-start text-xs underline text-on-surface-faint"
            onClick={() => onOpenInvoice(invoice.supersededByInvoiceId!)}
          >
            {gt("Superseded by a corrective invoice →")}
          </button>
        )}
        {invoice.supersedesInvoiceId && (
          <button
            type="button"
            className="self-start text-xs underline text-on-surface-faint"
            onClick={() => onOpenInvoice(invoice.supersedesInvoiceId!)}
          >
            {gt("← Corrects an earlier, voided invoice")}
          </button>
        )}
      </header>

      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canIssue && (
          <>
            <button
              type="button"
              className={BTN}
              disabled={busy || approveBlocker !== null}
              title={approveBlocker ?? gt("Freeze these figures")}
              onClick={() => void run(() => client.approveInvoice!(invoice.id))}
            >
              {gt("Approve")}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={busy || resendBlocker !== null}
              title={
                resendBlocker ??
                (needsResendConfirm
                  ? sendBlocker!
                  : isRetry
                    ? gt("Nothing reached the customer last time, so this retries the delivery")
                    : gt("Email this invoice to the customer, with the CSV attached"))
              }
              onClick={() => {
                if (
                  needsResendConfirm &&
                  !window.confirm(gt("{blocker}\n\nSend another copy?", { blocker: sendBlocker! }))
                ) {
                  return;
                }
                void run(() => client.sendInvoice!(invoice.id, needsResendConfirm));
              }}
            >
              {sendLabel}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={busy || voidBlocker !== null}
              title={voidBlocker ?? gt("Withdraw this invoice")}
              onClick={() => setVoiding(true)}
            >
              {gt("Void")}
            </button>
          </>
        )}
        {canWrite && deleteBlocker === null && (
          <button
            type="button"
            className={BTN}
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(gt("Delete this draft? It was never issued, so nothing is lost."))
              )
                return;
              void run(async () => {
                await client.deleteInvoice?.(invoice.id);
                onBack();
              });
            }}
          >
            {gt("Delete draft")}
          </button>
        )}
        {exportUrl && (
          <a className={BTN} href={exportUrl} download>
            {gt("Download CSV")}
          </a>
        )}
      </div>

      {approveBlocker !== null && invoice.status === "draft" && (
        <p className="text-sm text-warning">{approveBlocker}</p>
      )}
      {invoice.derivation.missingScope.length > 0 && (
        <p className="text-sm text-warning">
          {invoice.derivation.missingScope.length === 1
            ? gt("1 scope entry no longer exist and contributed nothing to this invoice.")
            : gt("{count} scope entries no longer exist and contributed nothing to this invoice.", {
                count: invoice.derivation.missingScope.length,
              })}
        </p>
      )}

      <LineTable invoice={invoice} />
      <Derivation invoice={invoice} />

      {voiding && (
        <VoidModal
          onClose={() => setVoiding(false)}
          onVoid={async (reason, supersede) => {
            setVoiding(false);
            await run(async () => {
              const result = await client.voidInvoice!(invoice.id, reason, supersede);
              if (result.replacement) onOpenInvoice(result.replacement.id);
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * The lines, with the derivation on every row.
 *
 * Collected, adjustment and invoiced sit side by side rather than only the
 * final figure, because "why am I being charged this" is the question this
 * table exists to answer and the answer is the three numbers together.
 */
function LineTable({ invoice }: { invoice: ManagedInvoice }) {
  const gt = useGT();
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-on-surface">{gt("Lines")}</h2>
      {invoice.lines.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          {gt("No spend in this period for anything this customer owns.")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-on-surface-faint">
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  {gt("Line")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  {gt("Collected")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  {gt("Adjustment")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  {gt("Subtotal")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  {gt("Rate")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  {gt("Invoiced")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {/* `kind:refId:currency` is a true key for the cost-centre and
                  account lines — one line per scope entry per collected
                  currency. It is not one for a fixed charge, whose `refId` is
                  the rule's *target*, not the rule: two fixed rules billing the
                  same centre in the same currency are two lines with one
                  composite key, and the line carries no rule id to tell them
                  apart. The index is the tie-break that keeps those two rows
                  distinct rather than colliding; it costs nothing here because
                  the rows hold no state and the server sends them pre-sorted
                  (this table never filters or re-sorts). */}
              {invoice.lines.map((line, i) => (
                <tr key={`${line.kind}:${line.refId ?? ""}:${line.currency}:${i}`}>
                  <td className="px-3 py-2 text-on-surface">
                    {line.label}
                    <span className="ml-2 text-xs text-on-surface-faint">
                      {line.kind === "cost_centre"
                        ? gt("cost centre")
                        : line.kind === "account"
                          ? gt("account")
                          : gt("fixed charge")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-faint">
                    {money(line.collected, line.currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-faint">
                    {line.adjustment === 0 ? "—" : money(line.adjustment, line.currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface">
                    {money(line.adjusted, line.currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface-faint">
                    {line.rate === null ? (
                      <span className="text-warning">{gt("no rate")}</span>
                    ) : line.rate === 1 ? (
                      "—"
                    ) : (
                      line.rate.toFixed(4)
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-on-surface">
                    {line.billed === null
                      ? money(line.adjusted, line.currency)
                      : money(line.billed, invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td className="px-3 py-2 text-on-surface" colSpan={5}>
                  {gt("Total")}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-on-surface">
                  {describeManagedInvoiceTotal(invoice.totals, invoice.currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** Everything needed to re-derive the total by hand. */
function Derivation({ invoice }: { invoice: ManagedInvoice }) {
  const gt = useGT();
  const d = invoice.derivation;
  const scope =
    d.scope.costCentres.length === 0 && d.scope.accounts.length === 0
      ? gt("nothing")
      : [...d.scope.costCentres.map((c) => c.name), ...d.scope.accounts.map((a) => a.label)].join(
          ", ",
        );
  const rulesList = d.rules.map((r) => `${r.name} (${r.summary})`).join("; ");
  const ratesList = d.rates
    .map((r) => `1 ${r.currency} = ${r.rate} ${invoice.currency} (stated ${r.effectiveFrom})`)
    .join("; ");
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-on-surface">
        {gt("How this total was reached")}
      </h2>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-on-surface">
        <p>
          {gt(
            "Spend allocated to {scope}, on the {costBasis} basis, over {periodFrom} to {periodTo}.",
            {
              scope,
              costBasis: d.costBasis,
              periodFrom: invoice.periodFrom,
              periodTo: invoice.periodTo,
            },
          )}
        </p>
        <p className="text-on-surface-faint">
          {d.applyBillingRules
            ? d.rules.length === 0
              ? gt(
                  "Billing rules apply to this customer, but the organisation has none — the invoiced figure equals what the providers charged.",
                )
              : d.rules.length === 1
                ? gt("1 billing rule applied: {list}.", { list: rulesList })
                : gt("{count} billing rules applied: {list}.", {
                    count: d.rules.length,
                    list: rulesList,
                  })
            : gt(
                "Pass-through contract: no billing rule was applied, so the invoiced figure is exactly what the providers charged.",
              )}
        </p>
        <p className="text-on-surface-faint">
          {d.rates.length === 0
            ? gt("All spend was already in {currency}; no conversion was needed.", {
                currency: invoice.currency,
              })
            : gt("Converted at the rates in force on {date}: {list}.", {
                date: d.rateDate,
                list: ratesList,
              })}
          {!invoice.live &&
            gt(" These rates are frozen — restating one later cannot change this invoice.")}
        </p>
        {d.unconverted.length > 0 && (
          <p className="text-warning">
            {gt(
              "No exchange rate was stated for {currencies}, so those amounts are carried in their own currency. Add the rate in Settings → Currency before approving.",
              { currencies: d.unconverted.join(", ") },
            )}
          </p>
        )}
      </div>
    </section>
  );
}

function VoidModal({
  onClose,
  onVoid,
}: {
  onClose: () => void;
  onVoid: (reason: string, supersede: boolean) => Promise<void>;
}) {
  const gt = useGT();
  const [reason, setReason] = useState("");
  const [supersede, setSupersede] = useState(true);

  return (
    <Modal ariaLabel={gt("Void this invoice")} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-on-surface-faint">
          {gt(
            "The invoice keeps every figure it was sent with. Voiding records that it was withdrawn — it does not edit or delete it, because the customer holds a copy.",
          )}
        </p>
        <label className="flex flex-col gap-1 text-xs text-on-surface-faint">
          {gt("Reason (required — the only record of why)")}
          <textarea
            className={FIELD}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-on-surface-faint">
          <input
            type="checkbox"
            checked={supersede}
            onChange={(e) => setSupersede(e.target.checked)}
          />
          {gt("Raise a corrective draft for the same period, linked to this one")}
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            className={BTN}
            disabled={!reason.trim()}
            onClick={() => void onVoid(reason.trim(), supersede)}
          >
            {gt("Void invoice")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
