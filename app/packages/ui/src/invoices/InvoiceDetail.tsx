import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  MANAGED_INVOICE_DELIVERY_STATUS_LABELS,
  describeManagedInvoiceTotal,
  managedInvoiceBlocker,
  managedInvoiceDeliveryRetryable,
  type ManagedInvoice,
  type ManagedInvoiceDelivery,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { InvoicesClient } from "./types.js";
import { StatusChip, money, BTN, FIELD } from "./shared.js";
import { ArrowIcon } from "../components/icons/ChromeIcons.js";

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

/* ------------------------------------------------------------------ *
 * Invoice detail
 * ------------------------------------------------------------------ */

export function InvoiceDetail({
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
          <span className="inline-flex items-center gap-1">
            <ArrowIcon direction="left" size={12} />
            {gt("All invoices")}
          </span>
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
  // whenever only that flag stands in the way: with a confirmation, because
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
        <span className="inline-flex items-center gap-1">
          <ArrowIcon direction="left" size={12} />
          {gt("All invoices")}
        </span>
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
            <span className="inline-flex items-center gap-1">
              <ArrowIcon direction="left" size={12} />
              {gt("Corrects an earlier, voided invoice")}
            </span>
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
                  account lines: one line per scope entry per collected
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
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] max-w-[92vw] p-6">
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
      </div>
    </Modal>
  );
}
