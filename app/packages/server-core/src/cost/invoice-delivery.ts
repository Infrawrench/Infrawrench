/**
 * Emailing an invoice to the customer it bills.
 *
 * ## Which precedent this follows
 *
 * The **digest / report-delivery** one (`report-delivery/{compose,deliver}.ts`),
 * not alert routing. An invoice goes to the addresses its own customer record
 * names, exactly like a scheduled report goes to the destinations its schedule
 * names; it has no severity, no quiet hours, no escalation, and it must never
 * be threaded through `alerts/route.ts`. "Where do alerts of this kind go" is a
 * different question from "who is this customer's accounts-payable contact".
 *
 * From that precedent comes the rule that matters most here:
 * **partial delivery is terminal.** Mailgun has no idempotency keys, so a retry
 * after a partial success posts a second copy of the same bill into an inbox
 * that already has it. {@link classifyInvoiceDelivery} therefore only ever
 * calls a delivery retryable when *zero* addresses were reached — and even then
 * the retry is a person pressing the button again, because this feature has no
 * poller pass. Automatically re-mailing a customer's bill is not something a
 * background tick should decide.
 *
 * ## What delivery may and may not touch
 *
 * Only the delivery columns. The invoice's figures were frozen at approval and
 * delivery is bookkeeping about where the frozen document went: status,
 * timestamp, recipients, error. Nothing in this module reads spend, and nothing
 * in it writes `lines`, `totals` or `derivation`.
 *
 * ## Attached, not linked
 *
 * The CSV rides as a Mailgun multipart attachment (see `email.ts`). Mailgun
 * takes attachments in the same form post the message already is, so it costs
 * no object store and no second request. A link would need a URL that serves a
 * document naming a customer's spend to whoever holds it, and it would rot —
 * an invoice has to still open when someone queries it eleven months later.
 */
import {
  describeManagedInvoiceTotal,
  type ManagedInvoice,
  type ManagedInvoiceDeliveryStatus,
} from "@infrawrench/client-core";
import { sendEmails, isEmailConfigured, type EmailMessage } from "../email";

/** What one send attempt did, before it is written to the row. */
export interface InvoiceDeliveryOutcome {
  status: ManagedInvoiceDeliveryStatus;
  /** The addresses attempted, in the order they were read off the customer. */
  recipients: string[];
  /** How many of them the transport accepted. */
  delivered: number;
  error: string | null;
}

/**
 * Addresses to bill, read off the customer's contact email.
 *
 * The field is one text column, so a customer with an AP mailbox *and* a named
 * contact is written as a comma- or semicolon-separated list — the shape people
 * already type into a contact field. Parsing it here rather than adding a
 * second column keeps the customer's API shape unchanged and costs nothing:
 * a single address parses to a single address.
 *
 * Entries that are not addresses at all are dropped rather than handed to the
 * transport, and {@link deliverInvoiceEmail} says how many were dropped. A
 * validator stricter than this rejects valid addresses, which is worse.
 */
export function invoiceRecipients(contactEmail: string | null | undefined): {
  recipients: string[];
  rejected: string[];
} {
  const recipients: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of String(contactEmail ?? "").split(/[,;]/)) {
    const candidate = raw.trim().toLowerCase();
    if (!candidate) continue;
    // The same permissive shape `normalizeEmailAddress` accepts, without its
    // throw: one bad entry must not cost the good ones their invoice.
    if (candidate.length > 320 || !/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(candidate)) {
      rejected.push(raw.trim());
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    recipients.push(candidate);
  }
  return { recipients, rejected };
}

/** Deep link to the invoice, for the message body. Null without `APP_URL`. */
function invoiceUrl(organizationId: string, invoiceId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/invoices/${invoiceId}`;
}

/** The filename the customer's mail client shows for the attachment. */
export function invoiceCsvFilename(invoice: ManagedInvoice): string {
  return `${invoice.number ?? `draft-${invoice.id.slice(0, 8)}`}.csv`;
}

/**
 * The subject line. The invoice number leads because that is the string a
 * customer quotes back on their remittance advice and searches their mailbox
 * for; the org name is added by the caller, which knows it.
 */
export function invoiceEmailSubject(invoice: ManagedInvoice, orgName: string | null): string {
  const who = orgName ? `${orgName} — ` : "";
  return `${who}Invoice ${invoice.number ?? "(draft)"} · ${invoice.periodFrom} to ${invoice.periodTo}`;
}

/** The body lines, shared by the text and HTML parts so they cannot drift. */
function bodyLines(
  invoice: ManagedInvoice,
  orgName: string | null,
  url: string | null,
): Array<{ text: string; bold: boolean }> {
  const lines: Array<{ text: string; bold: boolean }> = [];
  lines.push({
    text: `Invoice ${invoice.number ?? "(draft)"} for ${invoice.managedAccountName}`,
    bold: true,
  });
  lines.push({
    text: `Period ${invoice.periodFrom} to ${invoice.periodTo}, on the ${invoice.derivation.costBasis} cost basis.`,
    bold: false,
  });
  lines.push({
    text: `Total due: ${describeManagedInvoiceTotal(invoice.totals, invoice.currency)}`,
    bold: true,
  });
  if (invoice.derivation.rates.length > 0) {
    lines.push({
      text:
        `Converted at the rates stated for ${invoice.derivation.rateDate}: ` +
        invoice.derivation.rates.map((r) => `${r.currency} × ${r.rate}`).join(", "),
      bold: false,
    });
  }
  if (invoice.notes) lines.push({ text: invoice.notes, bold: false });
  // The attachment is named in the body because a mail client that hides
  // attachments below the fold is the norm, not the exception.
  lines.push({
    text:
      `The attached ${invoiceCsvFilename(invoice)} carries the full derivation: what each ` +
      "cost centre collected, what the billing rules added, the exchange rate and the day it " +
      "was read, and the invoiced figure — every column needed to check the arithmetic.",
    bold: false,
  });
  if (orgName) lines.push({ text: `Sent by ${orgName} via Infrawrench.`, bold: false });
  if (url) lines.push({ text: `View it online: ${url}`, bold: false });
  return lines;
}

/** The plain-text part. Always sent — some readers never render the HTML. */
export function formatInvoiceEmailText(
  invoice: ManagedInvoice,
  orgName: string | null,
  url: string | null,
): string {
  return bodyLines(invoice, orgName, url)
    .map((l) => l.text)
    .join("\n\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The HTML part — the digest's hand-rolled inline-style shape. */
export function formatInvoiceEmailHtml(
  invoice: ManagedInvoice,
  orgName: string | null,
  url: string | null,
): string {
  const body = bodyLines(invoice, orgName, null)
    .map(
      (l) =>
        `<p style="margin:0 0 12px;">${l.bold ? `<strong>${escapeHtml(l.text)}</strong>` : escapeHtml(l.text)}</p>`,
    )
    .join("\n");
  const button = url
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">View this invoice</a></p>`
    : "";
  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;max-width:640px;">`,
    body,
    button,
    `</div>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * Turn the fan-out counts into an outcome.
 *
 * The report deliveries' rule, verbatim, because the hazard is identical:
 * **only a total failure is retryable.** Mailgun cannot collapse a duplicate,
 * so a retry after a partial success sends a second copy of the same bill to
 * the addresses that already received it — and a customer paying an invoice
 * twice is a worse outcome than a customer's second contact not receiving it.
 */
export function classifyInvoiceDelivery(result: {
  attempted: number;
  succeeded: number;
  rejected: string[];
  mailConfigured: boolean;
}): Omit<InvoiceDeliveryOutcome, "recipients"> {
  const { attempted, succeeded, rejected, mailConfigured } = result;
  if (attempted === 0) {
    return {
      status: "no_targets",
      delivered: 0,
      error:
        rejected.length > 0
          ? `This customer's contact email holds no usable address (${rejected.join(", ")}). ` +
            "Fix it on the customer, then send again."
          : "This customer has no contact email, so there was nowhere to send the invoice. Add " +
            "one on the customer, then send again.",
    };
  }
  if (succeeded === 0) {
    return {
      status: "failed",
      delivered: 0,
      error: mailConfigured
        ? `None of the ${attempted} recipient(s) could be reached. See the server logs for the ` +
          "per-address error, fix it, and send again — nothing was delivered, so nothing will " +
          "be duplicated."
        : "This deployment has no mail provider configured (MAILGUN_API_KEY, MAILGUN_DOMAIN, " +
          "EMAIL_FROM), so nothing was sent. The invoice is still recorded as issued.",
    };
  }
  if (succeeded < attempted) {
    return {
      status: "partial",
      delivered: succeeded,
      error:
        `Delivered to ${succeeded} of ${attempted} recipients; the rest failed. Not retried ` +
        "automatically — a retry would put a second copy of this bill in the inboxes that " +
        "already have it. Fix the failing address and use “Send again” if the customer needs " +
        "another copy.",
    };
  }
  return {
    status: "succeeded",
    delivered: succeeded,
    error:
      rejected.length > 0
        ? `Delivered to all ${succeeded} usable recipient(s). ${rejected.length} entry in the ` +
          `customer's contact email is not an address and was skipped: ${rejected.join(", ")}.`
        : null,
  };
}

/**
 * Send one frozen invoice to its customer, with the CSV attached.
 *
 * Never throws: a mail outage must surface as a recorded failed delivery the
 * caller can retry, not as a 500 that leaves the person wondering whether the
 * customer got the bill.
 */
export async function deliverInvoiceEmail(
  organizationId: string,
  invoice: ManagedInvoice,
  options: {
    contactEmail: string | null;
    orgName: string | null;
    csv: string;
    /** Distinguishes the attempts in Mailgun's own logs. A breadcrumb, not a key. */
    attempt: number;
  },
): Promise<InvoiceDeliveryOutcome> {
  const { recipients, rejected } = invoiceRecipients(options.contactEmail);
  const url = invoiceUrl(organizationId, invoice.id);
  const subject = invoiceEmailSubject(invoice, options.orgName);

  // Built even when mail is unconfigured, exactly like the report deliveries:
  // `sendEmails` logs the "recipients but no mail provider" line, and
  // short-circuiting here would make that failure silent.
  const messages: EmailMessage[] = recipients.map((to) => ({
    to,
    subject,
    text: formatInvoiceEmailText(invoice, options.orgName, url),
    html: formatInvoiceEmailHtml(invoice, options.orgName, url),
    attachments: [
      {
        filename: invoiceCsvFilename(invoice),
        content: options.csv,
        contentType: "text/csv; charset=utf-8",
      },
    ],
    traceKey: `invoice:${invoice.id}:${options.attempt}:${to}`,
  }));

  const result = await sendEmails(messages, `invoice ${invoice.number ?? invoice.id}`);
  const outcome = classifyInvoiceDelivery({
    // Addresses that could not even be attempted still count as attempted: the
    // customer names them, and "your invoice silently went nowhere" has to show
    // up as a failure rather than as a clean success.
    attempted: recipients.length,
    succeeded: result.succeeded,
    rejected,
    mailConfigured: isEmailConfigured(),
  });
  return { ...outcome, recipients };
}
