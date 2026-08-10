import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Emailing an invoice to the customer it bills.
 *
 * Three properties, all of them the sort that only bite in front of a paying
 * customer:
 *
 * 1. **The document travels with the message.** The CSV is attached, so the
 *    invoice is readable from the mail years later without a link that has to
 *    keep resolving.
 * 2. **Nothing reached anyone / something did** is the only distinction that
 *    decides whether sending again is safe, so the classification has to draw
 *    it exactly — a partial delivery is terminal, never retried.
 * 3. **Addresses come from what the customer record actually says**, including
 *    the several-addresses-in-one-field shape people type.
 */

const { sendEmails, isEmailConfigured } = vi.hoisted(() => ({
  sendEmails: vi.fn(),
  isEmailConfigured: vi.fn(() => true),
}));
vi.mock("../email", () => ({ sendEmails, isEmailConfigured }));

import type { ManagedInvoice } from "@infrawrench/client-core";
import {
  classifyInvoiceDelivery,
  deliverInvoiceEmail,
  formatInvoiceEmailHtml,
  formatInvoiceEmailText,
  invoiceCsvFilename,
  invoiceEmailSubject,
  invoiceRecipients,
} from "../cost/invoice-delivery";

function invoice(overrides: Partial<ManagedInvoice> = {}): ManagedInvoice {
  return {
    id: "inv-1",
    managedAccountId: "cust-1",
    managedAccountName: "Northwind Trading",
    number: "INV-2026-0001",
    status: "sent",
    periodFrom: "2026-01-01",
    periodTo: "2026-01-31",
    currency: "GBP",
    notes: null,
    lines: [],
    totals: { collected: {}, adjustment: {}, adjusted: {}, billed: { GBP: 1104 } },
    derivation: {
      costBasis: "amortized",
      applyBillingRules: true,
      rateDate: "2026-01-31",
      rates: [{ currency: "USD", rate: 0.8, effectiveFrom: "2026-01-01" }],
      unconverted: [],
      rules: [],
      scope: { costCentres: [], accounts: [] },
      missingScope: [],
    },
    live: false,
    computedAt: "2026-02-01T10:00:00.000Z",
    issuedAt: "2026-02-01T10:00:00.000Z",
    approvedByUserId: "user-2",
    sentAt: null,
    sentByUserId: null,
    delivery: null,
    voidedAt: null,
    voidedByUserId: null,
    voidReason: null,
    supersedesInvoiceId: null,
    supersededByInvoiceId: null,
    createdByUserId: "user-1",
    createdAt: "2026-02-01T09:00:00.000Z",
    updatedAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isEmailConfigured.mockReturnValue(true);
  sendEmails.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
});

describe("invoiceRecipients", () => {
  it("reads one address, several, or none", () => {
    expect(invoiceRecipients("ap@northwind.example").recipients).toEqual(["ap@northwind.example"]);
    // The shape people actually type into a single contact field.
    expect(invoiceRecipients("AP@northwind.example, finance@northwind.example").recipients).toEqual(
      ["ap@northwind.example", "finance@northwind.example"],
    );
    expect(invoiceRecipients("a@x.example; b@x.example").recipients).toEqual([
      "a@x.example",
      "b@x.example",
    ]);
    expect(invoiceRecipients(null).recipients).toEqual([]);
    expect(invoiceRecipients("   ").recipients).toEqual([]);
  });

  it("drops what is not an address, and says which — one typo must not cost the rest their invoice", () => {
    const { recipients, rejected } = invoiceRecipients("ap@northwind.example, accounts payable");
    expect(recipients).toEqual(["ap@northwind.example"]);
    expect(rejected).toEqual(["accounts payable"]);
  });

  it("sends one copy per address, not two for the same one written twice", () => {
    expect(invoiceRecipients("ap@x.example, AP@x.example").recipients).toEqual(["ap@x.example"]);
  });
});

describe("classifyInvoiceDelivery", () => {
  it("calls a partial delivery terminal, and says why", () => {
    const outcome = classifyInvoiceDelivery({
      attempted: 3,
      succeeded: 2,
      rejected: [],
      mailConfigured: true,
    });
    expect(outcome.status).toBe("partial");
    expect(outcome.delivered).toBe(2);
    // The sentence that stops someone "fixing" this into an automatic retry.
    expect(outcome.error).toMatch(/second copy of this bill in the inboxes that already have it/);
  });

  it("distinguishes nothing-to-send-to from nothing-got-through", () => {
    expect(
      classifyInvoiceDelivery({ attempted: 0, succeeded: 0, rejected: [], mailConfigured: true })
        .status,
    ).toBe("no_targets");
    expect(
      classifyInvoiceDelivery({ attempted: 2, succeeded: 0, rejected: [], mailConfigured: true })
        .status,
    ).toBe("failed");
  });

  it("names the missing mail provider rather than blaming the addresses", () => {
    const outcome = classifyInvoiceDelivery({
      attempted: 1,
      succeeded: 0,
      rejected: [],
      mailConfigured: false,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/MAILGUN_API_KEY/);
  });

  it("still reports a skipped entry on an otherwise clean send", () => {
    const outcome = classifyInvoiceDelivery({
      attempted: 1,
      succeeded: 1,
      rejected: ["accounts payable"],
      mailConfigured: true,
    });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.error).toMatch(/accounts payable/);
  });
});

describe("the message", () => {
  it("leads with the invoice number and the period", () => {
    expect(invoiceEmailSubject(invoice(), "Fabrikam Cloud")).toBe(
      "Fabrikam Cloud — Invoice INV-2026-0001 · 2026-01-01 to 2026-01-31",
    );
  });

  it("quotes the total and names the attachment", () => {
    const text = formatInvoiceEmailText(invoice(), "Fabrikam Cloud", null);
    expect(text).toContain("1104.00 GBP");
    expect(text).toContain("INV-2026-0001.csv");
    expect(invoiceCsvFilename(invoice())).toBe("INV-2026-0001.csv");
  });

  it("escapes the customer's own text into the HTML part", () => {
    const html = formatInvoiceEmailHtml(
      invoice({ managedAccountName: "Tom & <b>Jerry</b> Ltd" }),
      null,
      null,
    );
    expect(html).toContain("Tom &amp; &lt;b&gt;Jerry&lt;/b&gt; Ltd");
    expect(html).not.toContain("<b>Jerry</b>");
  });
});

describe("deliverInvoiceEmail", () => {
  it("attaches the CSV to one message per recipient", async () => {
    const outcome = await deliverInvoiceEmail("org-1", invoice(), {
      contactEmail: "ap@northwind.example, finance@northwind.example",
      orgName: "Fabrikam Cloud",
      csv: "invoice_number,customer\nINV-2026-0001,Northwind Trading\n",
      attempt: 1,
    });

    const [messages, context] = sendEmails.mock.calls[0] as [
      Array<{
        to: string;
        subject: string;
        traceKey: string;
        attachments: Array<{ filename: string; content: string; contentType: string }>;
      }>,
      string,
    ];
    expect(messages).toHaveLength(2);
    // One request per address: a shared `to:` would leak every recipient's
    // address to the others.
    expect(messages.map((m) => m.to)).toEqual([
      "ap@northwind.example",
      "finance@northwind.example",
    ]);
    expect(messages[0]!.attachments[0]).toMatchObject({
      filename: "INV-2026-0001.csv",
      contentType: "text/csv; charset=utf-8",
    });
    expect(messages[0]!.attachments[0]!.content).toContain("INV-2026-0001");
    // The breadcrumb carries the attempt, so two sends are distinguishable in
    // the provider's own logs.
    expect(messages[0]!.traceKey).toBe("invoice:inv-1:1:ap@northwind.example");
    expect(context).toContain("INV-2026-0001");
    expect(outcome.recipients).toHaveLength(2);
  });

  it("reports a customer with no contact address as no_targets, having sent nothing", async () => {
    sendEmails.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    const outcome = await deliverInvoiceEmail("org-1", invoice(), {
      contactEmail: null,
      orgName: null,
      csv: "",
      attempt: 1,
    });
    expect(outcome.status).toBe("no_targets");
    expect(outcome.error).toMatch(/no contact email/);
  });

  it("counts an address that could not be attempted as attempted and failed", async () => {
    // Mail is unconfigured: `sendEmails` sends nothing and says so. The
    // customer still named an address, so this is a failure, not a clean run.
    isEmailConfigured.mockReturnValue(false);
    sendEmails.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    const outcome = await deliverInvoiceEmail("org-1", invoice(), {
      contactEmail: "ap@northwind.example",
      orgName: null,
      csv: "",
      attempt: 2,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.recipients).toEqual(["ap@northwind.example"]);
    expect(outcome.error).toMatch(/no mail provider configured/);
  });
});
