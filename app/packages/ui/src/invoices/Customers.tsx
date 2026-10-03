import { useMemo, useState } from "react";
import { T, useGT } from "gt-react";
import {
  costCentrePaths,
  type CostCentre,
  type ManagedAccount,
  type ManagedAccountInput,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { InvoiceScopeAccount } from "./types.js";
import { toggle, lastMonth, BTN, FIELD } from "./shared.js";

/* ------------------------------------------------------------------ *
 * Customers
 * ------------------------------------------------------------------ */

export function CustomerList({
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

export function CustomerModal({
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

  // Membership only: the arrays stay authoritative because the order a
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
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-[92vw] max-h-[85vh] overflow-y-auto p-6">
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
      </div>
    </Modal>
  );
}

export function RaiseInvoiceModal({
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
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] max-w-[92vw] p-6">
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
      </div>
    </Modal>
  );
}
