import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invoice guarantees, pinned.
 *
 * Four properties, and every one of them is the kind that is fine right up
 * until the day it isn't:
 *
 * 1. **An approved invoice does not move.** Cost data restates for days after
 *    the fact. An invoice that silently changed after it was sent to a customer
 *    is the worst outcome this feature could produce, so approval writes the
 *    figures onto the row and every later read returns those bytes — without so
 *    much as querying spend.
 * 2. **The currency is frozen too.** The exchange rate and the day it was read
 *    are part of the document. Restating a rate afterwards must not restate an
 *    invoice a customer already holds.
 * 3. **Void, never delete or edit.** Enforced in the service, so a client that
 *    skips the UI still cannot rewrite history.
 * 4. **The arithmetic reconciles.** `collected + adjustment === adjusted` for
 *    every currency, on every line and in the totals. A total nobody can explain
 *    is a total nobody will pay.
 */

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  desc: (a: unknown) => a,
  asc: (a: unknown) => a,
  inArray: (a: unknown, b: unknown) => ({ op: "in", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  sql: Object.assign((...args: unknown[]) => ({ op: "sql", args }), { raw: (s: string) => s }),
}));

vi.mock("../db/schema", () => ({
  managedInvoices: { id: "id", organizationId: "org", status: "status", number: "number" },
  managedAccounts: { id: "id", organizationId: "org" },
  accounts: { id: "id", organizationId: "org", displayName: "display_name" },
}));

type Row = Record<string, unknown>;

let invoiceRow: Row | null = null;
let numberRows: Array<{ number: string | null }> = [];
const inserted: Row[] = [];

/** Every builder method returns the same thenable, so any chain resolves. */
function chain(result: unknown) {
  const promise = Promise.resolve(result);
  const self: Record<string, unknown> = {};
  for (const key of ["from", "where", "orderBy", "groupBy", "limit", "innerJoin"]) {
    self[key] = () => self;
  }
  self["then"] = (res: unknown, rej: unknown) =>
    promise.then(res as never, rej as never) as unknown;
  return self;
}

const db = {
  // No column list is `getInvoiceRow`; a column list is the invoice-number scan.
  select: (cols?: unknown) =>
    chain(cols === undefined ? (invoiceRow ? [invoiceRow] : []) : numberRows),
  insert: () => ({
    values: (values: Row) => ({
      returning: async () => {
        const row = { createdAt: new Date(), updatedAt: new Date(), ...values };
        inserted.push(row);
        invoiceRow = row;
        return [row];
      },
    }),
  }),
  update: () => ({
    set: (values: Row) => ({
      where: () => ({
        returning: async () => {
          if (!invoiceRow) return [];
          invoiceRow = { ...invoiceRow, ...values };
          return [invoiceRow];
        },
      }),
    }),
  }),
  delete: () => ({
    where: () => ({
      returning: async () => {
        if (!invoiceRow) return [];
        const gone = invoiceRow;
        invoiceRow = null;
        return [gone];
      },
    }),
  }),
};
vi.mock("../db/client", () => ({ db }));

const getShowbackSpend = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ getShowbackSpend }));

const listCostCentres = vi.fn();
const listAllocationRules = vi.fn();
vi.mock("../cost/allocation", () => ({ listCostCentres, listAllocationRules }));

const resolveBillingAdjustments = vi.fn();
vi.mock("../cost/billing-rules", () => ({ resolveBillingAdjustments }));

const listOrgExchangeRates = vi.fn();
vi.mock("../cost/currency-settings", () => ({ listOrgExchangeRates }));

const getManagedAccountRow = vi.fn();
vi.mock("../cost/managed-accounts", () => ({ getManagedAccountRow }));

const ORG = "org-1";

/** A customer billing one cost centre in GBP, with the org's rules applied. */
function customer(overrides: Row = {}): Row {
  return {
    id: "cust-1",
    organizationId: ORG,
    name: "Northwind Trading",
    billingCurrency: "GBP",
    costBasis: "amortized",
    applyBillingRules: true,
    costCentreIds: ["cc-platform"],
    accountIds: [],
    ...overrides,
  };
}

function draftRow(overrides: Row = {}): Row {
  return {
    id: "inv-1",
    organizationId: ORG,
    managedAccountId: "cust-1",
    managedAccountName: "Northwind Trading",
    number: null,
    status: "draft",
    periodFrom: "2026-01-01",
    periodTo: "2026-01-31",
    currency: "GBP",
    notes: null,
    lines: null,
    totals: null,
    derivation: null,
    computedAt: null,
    issuedAt: null,
    approvedByUserId: null,
    sentAt: null,
    sentByUserId: null,
    voidedAt: null,
    voidedByUserId: null,
    voidReason: null,
    supersedesInvoiceId: null,
    supersededByInvoiceId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-02-01T09:00:00Z"),
    updatedAt: new Date("2026-02-01T09:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invoiceRow = draftRow();
  numberRows = [];
  inserted.length = 0;

  getManagedAccountRow.mockResolvedValue(customer());
  listCostCentres.mockResolvedValue([
    { id: "cc-platform", name: "Platform", parentId: null },
    { id: "cc-search", name: "Search", parentId: "cc-platform" },
  ]);
  listAllocationRules.mockResolvedValue([
    { id: "r1", costCentreId: "cc-platform", match: { tagKey: "team", tagValue: "platform" } },
    { id: "r2", costCentreId: "cc-search", match: { tagKey: "team", tagValue: "search" } },
  ]);
  // A 15% markup, applied in the scan: `amount` is adjusted, `rawAmount` is
  // what the providers actually charged.
  resolveBillingAdjustments.mockResolvedValue({
    adjustments: {
      factors: [{ ruleId: "b1", name: "Platform overhead", match: {}, factor: 1.15 }],
      reallocations: [],
      fixed: [],
    },
    rules: [
      { id: "b1", name: "Platform overhead", kind: "percentage", summary: "+15% on all spend" },
    ],
  });
  getShowbackSpend.mockResolvedValue([
    { costCentreId: "cc-platform", currency: "USD", amount: 1150, rawAmount: 1000 },
    { costCentreId: "cc-search", currency: "USD", amount: 230, rawAmount: 200 },
  ]);
  listOrgExchangeRates.mockResolvedValue([
    { id: "x1", fromCurrency: "USD", toCurrency: "GBP", rate: "0.80", effectiveFrom: "2026-01-01" },
  ]);
});

describe("computeInvoiceFigures", () => {
  it("reconciles: collected plus adjustment equals the invoiced figure", async () => {
    const { computeInvoiceFigures } = await import("../cost/invoices");
    const { managedInvoiceReconciles } = await import("@infrawrench/client-core");

    const figures = await computeInvoiceFigures(
      ORG,
      customer() as never,
      "2026-01-01",
      "2026-01-31",
    );

    // One line: Platform's subtree, which includes Search.
    expect(figures.lines).toHaveLength(1);
    const line = figures.lines[0]!;
    expect(line.kind).toBe("cost_centre");
    expect(line.label).toBe("Platform");
    expect(line.collected).toBe(1200);
    expect(line.adjustment).toBe(180);
    expect(line.adjusted).toBe(1380);
    expect(line.collected + line.adjustment).toBe(line.adjusted);

    expect(figures.totals.collected["USD"]).toBe(1200);
    expect(figures.totals.adjustment["USD"]).toBe(180);
    expect(figures.totals.adjusted["USD"]).toBe(1380);
    expect(managedInvoiceReconciles(figures.totals)).toBe(true);

    // …and the invoiced figure is that, at the rate stated for the period end.
    expect(line.rate).toBe(0.8);
    expect(line.billed).toBe(1104);
    expect(figures.totals.billed).toEqual({ GBP: 1104 });
    expect(figures.derivation.rateDate).toBe("2026-01-31");
  });

  it("bills a subtree once when a parent and its child are both in scope", async () => {
    const { computeInvoiceFigures } = await import("../cost/invoices");
    const figures = await computeInvoiceFigures(
      ORG,
      customer({ costCentreIds: ["cc-platform", "cc-search"] }) as never,
      "2026-01-01",
      "2026-01-31",
    );
    // Not two lines totalling 1380 + 230: Search is inside Platform's subtree,
    // and billing both would charge the customer for Search twice.
    expect(figures.lines).toHaveLength(1);
    expect(figures.totals.adjusted["USD"]).toBe(1380);
  });

  it("carries an unconvertible currency rather than dropping or inventing it", async () => {
    getShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-platform", currency: "SEK", amount: 4000, rawAmount: 4000 },
    ]);
    const { computeInvoiceFigures } = await import("../cost/invoices");
    const figures = await computeInvoiceFigures(
      ORG,
      customer() as never,
      "2026-01-01",
      "2026-01-31",
    );
    expect(figures.lines[0]!.rate).toBeNull();
    expect(figures.lines[0]!.billed).toBeNull();
    expect(figures.derivation.unconverted).toEqual(["SEK"]);
    // The amount is still in the total, in its own currency — never short.
    expect(figures.totals.billed).toEqual({ SEK: 4000 });
  });

  it("does not read the billing rules for a pass-through customer", async () => {
    getShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-platform", currency: "USD", amount: 1000 },
    ]);
    const { computeInvoiceFigures } = await import("../cost/invoices");
    const figures = await computeInvoiceFigures(
      ORG,
      customer({ applyBillingRules: false }) as never,
      "2026-01-01",
      "2026-01-31",
    );
    expect(resolveBillingAdjustments).not.toHaveBeenCalled();
    expect(figures.lines[0]!.adjustment).toBe(0);
    expect(figures.lines[0]!.collected).toBe(1000);
    expect(figures.lines[0]!.adjusted).toBe(1000);
  });
});

describe("freezing at approval", () => {
  it("stores the figures and does not recompute them afterwards", async () => {
    const { approveInvoice, getInvoice } = await import("../cost/invoices");

    const approved = await approveInvoice(ORG, "inv-1", "user-2");
    expect(approved.status).toBe("approved");
    expect(approved.number).toBe("INV-2026-0001");
    expect(approved.approvedByUserId).toBe("user-2");
    expect(approved.live).toBe(false);
    expect(approved.totals.billed).toEqual({ GBP: 1104 });

    // The provider restates January upward by 50%, days later.
    getShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-platform", currency: "USD", amount: 1725, rawAmount: 1500 },
    ]);
    getShowbackSpend.mockClear();

    const reread = await getInvoice(ORG, "inv-1");
    expect(reread!.totals.billed).toEqual({ GBP: 1104 });
    expect(reread!.lines[0]!.collected).toBe(1200);
    expect(reread!.live).toBe(false);
    // Not "it happened to match" — it never asked.
    expect(getShowbackSpend).not.toHaveBeenCalled();
  });

  it("freezes the exchange rate, so restating one cannot restate history", async () => {
    const { approveInvoice, getInvoice } = await import("../cost/invoices");
    const approved = await approveInvoice(ORG, "inv-1", "user-2");
    expect(approved.derivation.rates).toEqual([
      { currency: "USD", rate: 0.8, effectiveFrom: "2026-01-01" },
    ]);

    // The org restates the rate, effective before the invoice's period even
    // began — the most aggressive possible restatement.
    listOrgExchangeRates.mockResolvedValue([
      {
        id: "x2",
        fromCurrency: "USD",
        toCurrency: "GBP",
        rate: "0.50",
        effectiveFrom: "2025-12-01",
      },
    ]);

    const reread = await getInvoice(ORG, "inv-1");
    expect(reread!.derivation.rates[0]!.rate).toBe(0.8);
    expect(reread!.totals.billed).toEqual({ GBP: 1104 });
  });

  it("keeps recomputing a draft, which is the whole difference", async () => {
    const { getInvoice } = await import("../cost/invoices");
    const first = await getInvoice(ORG, "inv-1");
    expect(first!.live).toBe(true);
    expect(first!.totals.billed).toEqual({ GBP: 1104 });

    getShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-platform", currency: "USD", amount: 2300, rawAmount: 2000 },
    ]);
    const second = await getInvoice(ORG, "inv-1");
    expect(second!.live).toBe(true);
    expect(second!.totals.billed).toEqual({ GBP: 1840 });
  });

  it("refuses to approve an invoice it cannot express in the customer's currency", async () => {
    getShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-platform", currency: "SEK", amount: 4000, rawAmount: 4000 },
    ]);
    const { approveInvoice } = await import("../cost/invoices");
    await expect(approveInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(/SEK/);
    // Nothing was written: the draft is still a draft.
    expect(invoiceRow!["status"]).toBe("draft");
  });

  it("numbers from the period's year, not the day the button was pressed", async () => {
    invoiceRow = draftRow({ periodFrom: "2025-12-01", periodTo: "2025-12-31" });
    numberRows = [{ number: "INV-2025-0007" }];
    // The org's rate has to have been in force by the period's end — the rate
    // in `beforeEach` starts on 2026-01-01, which is later than this December
    // period and would (correctly) block approval.
    listOrgExchangeRates.mockResolvedValue([
      {
        id: "x0",
        fromCurrency: "USD",
        toCurrency: "GBP",
        rate: "0.80",
        effectiveFrom: "2025-11-01",
      },
    ]);
    const { approveInvoice } = await import("../cost/invoices");
    const approved = await approveInvoice(ORG, "inv-1", "user-2");
    expect(approved.number).toBe("INV-2025-0008");
  });
});

describe("void, never delete or edit", () => {
  it("refuses to delete an issued invoice", async () => {
    invoiceRow = draftRow({ status: "approved", number: "INV-2026-0001" });
    const { deleteInvoice } = await import("../cost/invoices");
    await expect(deleteInvoice(ORG, "inv-1")).rejects.toThrow(/Void it and raise a corrective/);
    expect(invoiceRow).not.toBeNull();
  });

  it("refuses to delete a sent invoice", async () => {
    invoiceRow = draftRow({ status: "sent", number: "INV-2026-0001" });
    const { deleteInvoice } = await import("../cost/invoices");
    await expect(deleteInvoice(ORG, "inv-1")).rejects.toThrow(/sent to the customer/);
    expect(invoiceRow).not.toBeNull();
  });

  it("refuses to edit an issued invoice's period", async () => {
    invoiceRow = draftRow({ status: "approved", number: "INV-2026-0001" });
    const { updateInvoice } = await import("../cost/invoices");
    await expect(
      updateInvoice(ORG, "inv-1", { periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    ).rejects.toThrow(/frozen/);
    expect(invoiceRow!["periodFrom"]).toBe("2026-01-01");
  });

  it("refuses to void a draft — a draft was never issued", async () => {
    const { voidInvoice } = await import("../cost/invoices");
    await expect(voidInvoice(ORG, "inv-1", "user-2", "wrong period", false)).rejects.toThrow(
      /never issued/,
    );
  });

  it("refuses a void with no reason", async () => {
    invoiceRow = draftRow({ status: "sent", number: "INV-2026-0001" });
    const { voidInvoice } = await import("../cost/invoices");
    await expect(voidInvoice(ORG, "inv-1", "user-2", "   ", false)).rejects.toThrow(
      /needs a reason/,
    );
  });

  it("voids without touching a single figure", async () => {
    const { approveInvoice, voidInvoice } = await import("../cost/invoices");
    const approved = await approveInvoice(ORG, "inv-1", "user-2");
    const frozen = approved.totals;

    const { invoice } = await voidInvoice(ORG, "inv-1", "user-3", "Wrong cost centre", false);
    expect(invoice.status).toBe("void");
    expect(invoice.voidReason).toBe("Wrong cost centre");
    expect(invoice.voidedByUserId).toBe("user-3");
    expect(invoice.totals).toEqual(frozen);
    expect(invoice.number).toBe("INV-2026-0001");
  });

  it("refuses everything on a void invoice, including a second void", async () => {
    invoiceRow = draftRow({ status: "void", number: "INV-2026-0001", voidReason: "wrong" });
    const { deleteInvoice, updateInvoice, voidInvoice, approveInvoice } =
      await import("../cost/invoices");
    await expect(deleteInvoice(ORG, "inv-1")).rejects.toThrow(/historical record/);
    await expect(
      updateInvoice(ORG, "inv-1", { periodFrom: "2026-01-01", periodTo: "2026-01-31" }),
    ).rejects.toThrow(/historical record/);
    await expect(approveInvoice(ORG, "inv-1", "u")).rejects.toThrow(/historical record/);
    await expect(voidInvoice(ORG, "inv-1", "u", "again", false)).rejects.toThrow(/already void/);
  });

  it("refuses to send a draft — approval comes first", async () => {
    const { sendInvoice } = await import("../cost/invoices");
    await expect(sendInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(/Approve this invoice/);
  });
});

describe("renderInvoiceCsv", () => {
  it("carries the derivation and the totals in one file", async () => {
    const { approveInvoice, renderInvoiceCsv } = await import("../cost/invoices");
    const invoice = await approveInvoice(ORG, "inv-1", "user-2");
    const csv = renderInvoiceCsv(invoice);
    const [header, ...rows] = csv.trim().split("\n");

    expect(header).toContain("collected");
    expect(header).toContain("adjustment");
    expect(header).toContain("rate");
    expect(header).toContain("billed");
    // A line and a total row, so the reader never has to sum it themselves.
    expect(
      rows.some((r) => r.startsWith("INV-2026-0001,Northwind Trading") && r.includes("1200")),
    ).toBe(true);
    expect(rows.some((r) => r.includes("Invoice total") && r.includes("1104"))).toBe(true);
  });
});
