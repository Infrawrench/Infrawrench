import { useCallback, useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";

import {
  MANAGED_INVOICE_DELIVERY_STATUS_LABELS,
  describeManagedInvoiceTotal,
  managedInvoiceDeliveryRetryable,
  type CostCentre,
  type CostDimensionOption,
  type ManagedAccount,
  type ManagedAccountInput,
  type ManagedInvoiceSummary,
} from "@infrawrench/client-core";

import type { InvoiceScopeAccount, InvoicesClient } from "./types.js";
import { StatusChip } from "./shared.js";
import { InvoiceDetail } from "./InvoiceDetail.js";
import { CustomerList, CustomerModal, RaiseInvoiceModal } from "./Customers.js";

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export interface InvoicesPanelProps {
  client: InvoicesClient;
  /**
   * Which invoice to show. Absent renders the list. Owned by the host so the
   * URL, the workspace tab and this panel never disagree about which invoice is
   * open: the same contract the Cost reports panel uses.
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
 * Actions are driven by {@link managedInvoiceBlocker}: the same function the
 * server refuses with, so a disabled button and a 409 always say the same
 * sentence, and neither can drift from the other.
 */
export function InvoicesPanel({ client, invoiceId, onSelectInvoice }: InvoicesPanelProps) {
  const gt = useGT();
  const [accounts, setAccounts] = useState<ManagedAccount[] | null>(null);
  const [invoices, setInvoices] = useState<ManagedInvoiceSummary[] | null>(null);
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [cloudAccounts, setCloudAccounts] = useState<InvoiceScopeAccount[]>([]);
  const [providers, setProviders] = useState<CostDimensionOption[]>([]);
  const [services, setServices] = useState<CostDimensionOption[]>([]);
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
    // this month's invoices, which is what folding them into the load above
    // would have done.
    const noOptions = () => [] as CostDimensionOption[];
    const [centreRows, cloudRows, providerRows, serviceRows] = await Promise.all([
      client.listCostCentres().catch(() => [] as CostCentre[]),
      client.listAccounts().catch(() => [] as InvoiceScopeAccount[]),
      client.listCostDimension?.("provider").catch(noOptions) ?? noOptions(),
      client.listCostDimension?.("service").catch(noOptions) ?? noOptions(),
    ]);
    setCentres(centreRows);
    setCloudAccounts(cloudRows);
    // Without the dimension lists, fall back to the providers of the accounts
    // the customer could own, so the re-rating scope is still a picker.
    setProviders(
      providerRows.length > 0
        ? providerRows
        : [...new Set(cloudRows.map((a) => a.pluginId))].map((p) => ({ value: p, label: p })),
    );
    setServices(serviceRows);
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
          providers={providers}
          services={services}
          onPreview={
            client.previewPricing && editingAccount.account
              ? (pricing, month) =>
                  client.previewPricing!({
                    managedAccountId: editingAccount.account!.id,
                    pricing,
                    month,
                  })
              : undefined
          }
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
