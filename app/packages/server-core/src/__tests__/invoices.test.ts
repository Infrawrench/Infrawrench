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

// Column values are the *row property names*, so a condition built from them
// can be matched straight against a stored row.
vi.mock("../db/schema", () => ({
  managedInvoices: {
    __table: "managed_invoices",
    id: "id",
    organizationId: "organizationId",
    status: "status",
    number: "number",
    managedAccountId: "managedAccountId",
    deliveryAttemptCount: "deliveryAttemptCount",
  },
  managedAccounts: {
    __table: "managed_accounts",
    id: "id",
    organizationId: "organizationId",
    deletedAt: "deletedAt",
  },
  accounts: {
    __table: "accounts",
    id: "id",
    organizationId: "organizationId",
    displayName: "displayName",
  },
  organizations: { __table: "organizations", id: "id", displayName: "displayName" },
}));

type Row = Record<string, unknown>;
type Table = { __table: string };

/**
 * A small in-memory Postgres stand-in.
 *
 * It has to be this rather than a chain that resolves to a fixed array,
 * because two of the properties under test are *about* the database:
 * conditional updates that must not match, and a transaction that must roll
 * back whole. So conditions are actually evaluated against the stored rows, and
 * {@link fakeDb.transaction} restores a snapshot when its callback throws —
 * which is the only reason a test can tell an atomic supersede from a
 * half-applied one.
 */
const store = {
  invoices: new Map<string, Row>(),
  accounts: new Map<string, Row>(),
  cloudAccounts: [] as Row[],
  orgs: [] as Row[],
  numbers: [] as Array<{ number: string | null }>,
  /** Set to make the next insert blow up, standing in for a crash mid-write. */
  failNextInsert: null as string | null,
};
const inserted: Row[] = [];

function setInvoice(row: Row): Row {
  store.invoices.clear();
  store.invoices.set(String(row["id"]), row);
  return row;
}
function invoiceIn(id = "inv-1"): Row | undefined {
  return store.invoices.get(id);
}

/** Flatten a mocked condition tree into predicates over a row. */
type Predicate = { key: string; op: string; value: unknown };
function predicates(cond: unknown, out: Predicate[] = []): Predicate[] {
  const node = cond as { op?: string; args?: unknown[]; a?: unknown; b?: unknown } | null;
  if (!node || typeof node !== "object") return out;
  if (node.op === "and") {
    for (const arg of node.args ?? []) predicates(arg, out);
    return out;
  }
  if (node.op === "eq" || node.op === "in" || node.op === "isNull") {
    out.push({ key: String(node.a), op: node.op, value: node.b });
  }
  return out;
}

function matches(row: Row, cond: unknown): boolean {
  return predicates(cond).every((p) => {
    if (p.op === "eq") return row[p.key] === p.value;
    if (p.op === "in") return Array.isArray(p.value) && p.value.includes(row[p.key]);
    if (p.op === "isNull") return row[p.key] === null || row[p.key] === undefined;
    return true;
  });
}

function tableRows(table: Table): Map<string, Row> | Row[] {
  if (table.__table === "managed_invoices") return store.invoices;
  if (table.__table === "managed_accounts") return store.accounts;
  if (table.__table === "organizations") return store.orgs;
  return store.cloudAccounts;
}

function listOf(table: Table): Row[] {
  const rows = tableRows(table);
  return rows instanceof Map ? [...rows.values()] : rows;
}

/** A write that runs once, whether or not the caller asks for `returning()`. */
function writable(run: () => Row[]) {
  let done: Promise<Row[]> | null = null;
  const exec = (): Promise<Row[]> => (done ??= Promise.resolve().then(run));
  const q = {
    returning: () => q,
    then: (res: unknown, rej: unknown) => exec().then(res as never, rej as never),
  };
  return q;
}

function makeDb() {
  const api = {
    select: (cols?: unknown) => ({
      from: (table: Table) => {
        let where: unknown;
        const q: Record<string, unknown> = {
          where: (c: unknown) => {
            where = c;
            return q;
          },
        };
        for (const key of ["limit", "orderBy", "groupBy", "innerJoin", "for"]) {
          q[key] = () => q;
        }
        const rows = async (): Promise<Row[]> => {
          // A column list on the invoice table is the invoice-number scan.
          if (table.__table === "managed_invoices" && cols !== undefined) return store.numbers;
          return listOf(table).filter((r) => matches(r, where));
        };
        q["then"] = (res: unknown, rej: unknown) => rows().then(res as never, rej as never);
        return q;
      },
    }),
    insert: (table: Table) => ({
      values: (values: Row) => ({
        returning: async () => {
          if (store.failNextInsert) {
            const message = store.failNextInsert;
            store.failNextInsert = null;
            throw new Error(message);
          }
          const row: Row = {
            deliveryAttemptCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...values,
          };
          const target = tableRows(table);
          if (target instanceof Map) target.set(String(row["id"]), row);
          inserted.push(row);
          return [row];
        },
      }),
    }),
    // `returning()` is optional on a write, and awaiting the builder without it
    // still has to run the statement — which is how the supersede back-link is
    // written, and therefore something this harness must get right.
    update: (table: Table) => ({
      set: (values: Row) => ({
        where: (cond: unknown) =>
          writable(() => {
            const target = tableRows(table);
            return listOf(table)
              .filter((r) => matches(r, cond))
              .map((r) => {
                const next = { ...r, ...values };
                if (target instanceof Map) target.set(String(next["id"]), next);
                return next;
              });
          }),
      }),
    }),
    delete: (table: Table) =>
      ({
        where: (cond: unknown) =>
          writable(() => {
            const target = tableRows(table);
            const hits = listOf(table).filter((r) => matches(r, cond));
            for (const hit of hits) {
              if (target instanceof Map) target.delete(String(hit["id"]));
            }
            return hits;
          }),
      }) as { where: (cond: unknown) => unknown },
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = {
        invoices: new Map([...store.invoices].map(([k, v]) => [k, { ...v }])),
        accounts: new Map([...store.accounts].map(([k, v]) => [k, { ...v }])),
      };
      try {
        return await cb(api);
      } catch (e) {
        // What a real ROLLBACK buys, and the whole point of the harness: a
        // transaction that throws must leave nothing behind.
        store.invoices = snapshot.invoices;
        store.accounts = snapshot.accounts;
        throw e;
      }
    },
  };
  return api;
}

const db = makeDb();
vi.mock("../db/client", () => ({ db }));

const deliverInvoiceEmail = vi.fn();
vi.mock("../cost/invoice-delivery", () => ({ deliverInvoiceEmail }));

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
    deliveryStatus: null,
    deliveryRecipients: null,
    deliveryDelivered: null,
    deliveryAttemptedAt: null,
    deliveredAt: null,
    deliveryAttemptCount: 0,
    deliveryError: null,
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
  setInvoice(draftRow());
  store.accounts = new Map([["cust-1", customer()]]);
  store.cloudAccounts = [];
  store.orgs = [{ id: ORG, displayName: "Fabrikam Cloud" }];
  store.numbers = [];
  store.failNextInsert = null;
  inserted.length = 0;

  getManagedAccountRow.mockImplementation(async (_org: string, id: string) => {
    // Same row the locked read sees, so a test that mutates the store during a
    // compute is mutating the thing approval will re-read.
    const row = store.accounts.get(id);
    return row ? { ...row } : null;
  });
  deliverInvoiceEmail.mockResolvedValue({
    status: "succeeded",
    recipients: ["ap@northwind.example"],
    delivered: 1,
    error: null,
  });
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
    expect(invoiceIn()!["status"]).toBe("draft");
  });

  it("numbers from the period's year, not the day the button was pressed", async () => {
    setInvoice(draftRow({ periodFrom: "2025-12-01", periodTo: "2025-12-31" }));
    store.numbers = [{ number: "INV-2025-0007" }];
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
    setInvoice(draftRow({ status: "approved", number: "INV-2026-0001" }));
    const { deleteInvoice } = await import("../cost/invoices");
    await expect(deleteInvoice(ORG, "inv-1")).rejects.toThrow(/Void it and raise a corrective/);
    expect(invoiceIn()).toBeDefined();
  });

  it("refuses to delete a sent invoice", async () => {
    setInvoice(draftRow({ status: "sent", number: "INV-2026-0001" }));
    const { deleteInvoice } = await import("../cost/invoices");
    await expect(deleteInvoice(ORG, "inv-1")).rejects.toThrow(/sent to the customer/);
    expect(invoiceIn()).toBeDefined();
  });

  it("refuses to edit an issued invoice's period", async () => {
    setInvoice(draftRow({ status: "approved", number: "INV-2026-0001" }));
    const { updateInvoice } = await import("../cost/invoices");
    await expect(
      updateInvoice(ORG, "inv-1", { periodFrom: "2026-02-01", periodTo: "2026-02-28" }),
    ).rejects.toThrow(/frozen/);
    expect(invoiceIn()!["periodFrom"]).toBe("2026-01-01");
  });

  it("refuses to void a draft — a draft was never issued", async () => {
    const { voidInvoice } = await import("../cost/invoices");
    await expect(voidInvoice(ORG, "inv-1", "user-2", "wrong period", false)).rejects.toThrow(
      /never issued/,
    );
  });

  it("refuses a void with no reason", async () => {
    setInvoice(draftRow({ status: "sent", number: "INV-2026-0001" }));
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
    setInvoice(draftRow({ status: "void", number: "INV-2026-0001", voidReason: "wrong" }));
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

/**
 * Approval freezes **one consistent set of figures**, or nothing.
 *
 * The figures are computed from ClickHouse before the row is written, because
 * a transaction held open across an analytics query would be a lock behind a
 * network call. That leaves a window in which the draft, or the customer it
 * bills, can change — and every one of these tests drives a change through that
 * window by mutating the store from inside the spend query, which is exactly
 * when a concurrent request would commit.
 *
 * Storing the figures anyway would produce the one document this whole feature
 * exists to make impossible: an invoice whose stated period, currency or scope
 * does not describe the numbers printed on it.
 */
describe("approval refuses figures that no longer describe the invoice", () => {
  /** Run `mutate` at the moment the figures are being computed. */
  function duringCompute(mutate: () => void): void {
    getShowbackSpend.mockImplementation(async () => {
      mutate();
      return [{ costCentreId: "cc-platform", currency: "USD", amount: 1150, rawAmount: 1000 }];
    });
  }

  it("refuses when the period was edited while the figures were being computed", async () => {
    const { approveInvoice } = await import("../cost/invoices");
    duringCompute(() => {
      // What `PUT /invoices/:id` does, committed mid-approval.
      const row = invoiceIn()!;
      row["periodFrom"] = "2026-02-01";
      row["periodTo"] = "2026-02-28";
    });

    await expect(approveInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(
      /changed while it was being approved.*the period \(now 2026-02-01 → 2026-02-28\)/s,
    );

    // Nothing was frozen: no number, no lines, still a draft. The alternative
    // is a February invoice carrying January's figures.
    const row = invoiceIn()!;
    expect(row["status"]).toBe("draft");
    expect(row["number"]).toBeNull();
    expect(row["lines"]).toBeNull();
    expect(row["issuedAt"]).toBeNull();
  });

  it("refuses when the customer's scope changed, not only its period", async () => {
    const { approveInvoice } = await import("../cost/invoices");
    duringCompute(() => {
      store.accounts.get("cust-1")!["costCentreIds"] = ["cc-search"];
    });
    await expect(approveInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(
      /the cost centres in scope/,
    );
    expect(invoiceIn()!["status"]).toBe("draft");
  });

  it("refuses when the billing currency changed — the figures were converted at the old one", async () => {
    const { approveInvoice } = await import("../cost/invoices");
    duringCompute(() => {
      store.accounts.get("cust-1")!["billingCurrency"] = "EUR";
    });
    await expect(approveInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(/the billing currency/);
    expect(invoiceIn()!["status"]).toBe("draft");
  });

  it("refuses when the cost basis or the billing-rules flag changed", async () => {
    const { approveInvoice } = await import("../cost/invoices");
    duringCompute(() => {
      const account = store.accounts.get("cust-1")!;
      account["costBasis"] = "cash";
      account["applyBillingRules"] = false;
    });
    await expect(approveInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(
      /the cost basis, whether the billing rules apply/,
    );
    expect(invoiceIn()!["status"]).toBe("draft");
  });

  it("refuses when the customer was retired mid-approval", async () => {
    const { approveInvoice } = await import("../cost/invoices");
    duringCompute(() => {
      store.accounts.delete("cust-1");
    });
    await expect(approveInvoice(ORG, "inv-1", "user-2")).rejects.toThrow(/was retired/);
    expect(invoiceIn()!["status"]).toBe("draft");
  });

  it("still approves when nothing changed under it", async () => {
    const { approveInvoice } = await import("../cost/invoices");
    const approved = await approveInvoice(ORG, "inv-1", "user-2");
    expect(approved.status).toBe("approved");
    expect(approved.periodFrom).toBe("2026-01-01");
    expect(approved.totals.billed).toEqual({ GBP: 1104 });
  });
});

/**
 * Void and supersede are **one act**.
 *
 * Void is irreversible and `void` refuses every action that could produce a
 * correction, so an invoice voided without its corrective draft strands the
 * user with no way forward. The failure injected here is the ordinary one — a
 * connection dropping between two writes — and the only acceptable outcome is
 * that neither write survives.
 */
describe("void and supersede apply whole or not at all", () => {
  it("leaves the invoice issued when the corrective draft cannot be raised", async () => {
    const { approveInvoice, voidInvoice, getInvoice } = await import("../cost/invoices");
    await approveInvoice(ORG, "inv-1", "user-2");

    store.failNextInsert = "connection terminated unexpectedly";
    await expect(voidInvoice(ORG, "inv-1", "user-3", "Wrong cost centre", true)).rejects.toThrow(
      /connection terminated/,
    );

    // The half-applied state this transaction exists to prevent: void, with no
    // correction and no way to raise one.
    const row = invoiceIn()!;
    expect(row["status"]).toBe("approved");
    expect(row["voidedAt"]).toBeNull();
    expect(row["voidReason"]).toBeNull();
    expect(inserted).toHaveLength(0);

    const reread = await getInvoice(ORG, "inv-1");
    expect(reread!.status).toBe("approved");
    expect(reread!.supersededByInvoiceId).toBeNull();
  });

  it("leaves the invoice issued when the customer has been retired", async () => {
    const { approveInvoice, voidInvoice } = await import("../cost/invoices");
    await approveInvoice(ORG, "inv-1", "user-2");
    store.accounts.delete("cust-1");

    await expect(voidInvoice(ORG, "inv-1", "user-3", "Wrong period", true)).rejects.toThrow(
      /Nothing has been voided/,
    );
    expect(invoiceIn()!["status"]).toBe("approved");
  });

  it("links the pair both ways in one act", async () => {
    const { approveInvoice, voidInvoice } = await import("../cost/invoices");
    await approveInvoice(ORG, "inv-1", "user-2");

    const { invoice, replacement } = await voidInvoice(
      ORG,
      "inv-1",
      "user-3",
      "Wrong cost centre",
      true,
    );
    expect(invoice.status).toBe("void");
    expect(replacement).not.toBeNull();
    // Both directions, or the correction is undiscoverable from one end.
    expect(invoice.supersededByInvoiceId).toBe(replacement!.id);
    expect(replacement!.supersedesInvoiceId).toBe("inv-1");
    expect(replacement!.status).toBe("draft");
    expect(replacement!.periodFrom).toBe("2026-01-01");
    // The void invoice keeps every figure it was issued with.
    expect(invoice.totals.billed).toEqual({ GBP: 1104 });
  });

  it("refuses a second corrective invoice for the same void", async () => {
    const { approveInvoice, voidInvoice, createInvoice } = await import("../cost/invoices");
    await approveInvoice(ORG, "inv-1", "user-2");
    await voidInvoice(ORG, "inv-1", "user-3", "Wrong cost centre", true);

    await expect(
      createInvoice(
        ORG,
        {
          managedAccountId: "cust-1",
          periodFrom: "2026-01-01",
          periodTo: "2026-01-31",
          supersedesInvoiceId: "inv-1",
        },
        "user-3",
      ),
    ).rejects.toThrow(/already been superseded/);
  });
});

/**
 * Delivery: where the frozen document went.
 *
 * Two rules carry the whole design. **A send that reached nobody is retryable
 * with no ceremony**, because there is no inbox to duplicate into. **A send
 * that reached somebody is not**, because the mail provider has no idempotency
 * key and the customer would receive the same bill twice. And neither one may
 * touch a figure.
 */
describe("sending delivers the invoice", () => {
  async function approved() {
    const { approveInvoice } = await import("../cost/invoices");
    return approveInvoice(ORG, "inv-1", "user-2");
  }

  it("emails the frozen invoice with its CSV and records the outcome", async () => {
    const { sendInvoice } = await import("../cost/invoices");
    await approved();

    const sent = await sendInvoice(ORG, "inv-1", "user-9");
    expect(sent.status).toBe("sent");
    expect(sent.sentByUserId).toBe("user-9");
    expect(sent.delivery).toMatchObject({
      status: "succeeded",
      delivered: 1,
      recipients: ["ap@northwind.example"],
      attempts: 1,
    });
    expect(sent.delivery!.deliveredAt).not.toBeNull();

    const [, , options] = deliverInvoiceEmail.mock.calls[0] as [string, unknown, { csv: string }];
    // The artifact the customer needs to check the arithmetic, not a link to it.
    expect(options.csv).toContain("INV-2026-0001");
    expect(options.csv).toContain("Invoice total");

    // Delivery is bookkeeping about a frozen document; it restates nothing.
    expect(sent.totals.billed).toEqual({ GBP: 1104 });
    expect(sent.lines[0]!.collected).toBe(1200);
    expect(getShowbackSpend).toHaveBeenCalledTimes(1); // the approval's, not a second one
  });

  it("retries a delivery that reached nobody, with no confirmation", async () => {
    const { sendInvoice } = await import("../cost/invoices");
    await approved();
    deliverInvoiceEmail.mockResolvedValue({
      status: "failed",
      recipients: ["ap@northwind.example"],
      delivered: 0,
      error: "email to ap@northwind.example: HTTP 502",
    });

    const failed = await sendInvoice(ORG, "inv-1", "user-9");
    // Visibly failed — and still released: a person did decide to send it.
    expect(failed.status).toBe("sent");
    expect(failed.delivery!.status).toBe("failed");
    expect(failed.delivery!.deliveredAt).toBeNull();
    expect(failed.delivery!.error).toMatch(/HTTP 502/);

    deliverInvoiceEmail.mockResolvedValue({
      status: "succeeded",
      recipients: ["ap@northwind.example"],
      delivered: 1,
      error: null,
    });
    const retried = await sendInvoice(ORG, "inv-1", "user-9");
    expect(retried.delivery).toMatchObject({ status: "succeeded", attempts: 2 });
    // The release is recorded once, by the person who made it.
    expect(retried.sentAt).toBe(failed.sentAt);
    expect(retried.sentByUserId).toBe("user-9");
  });

  it("refuses a second copy of a delivered invoice unless it is asked for", async () => {
    const { sendInvoice } = await import("../cost/invoices");
    await approved();
    const sent = await sendInvoice(ORG, "inv-1", "user-9");

    await expect(sendInvoice(ORG, "inv-1", "user-9")).rejects.toThrow(/second copy/);
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(1);

    const again = await sendInvoice(ORG, "inv-1", "user-4", { resend: true });
    expect(again.delivery).toMatchObject({ status: "succeeded", attempts: 2 });
    // A deliberate second copy does not rewrite who released the invoice.
    expect(again.sentAt).toBe(sent.sentAt);
    expect(again.sentByUserId).toBe("user-9");
  });

  it("refuses to send again after an interrupted attempt whose outcome is unknown", async () => {
    const { sendInvoice } = await import("../cost/invoices");
    await approved();
    // The shape a process that died between claiming an attempt and recording
    // its result leaves behind.
    const row = invoiceIn()!;
    row["status"] = "sent";
    row["deliveryStatus"] = "pending";
    row["deliveryAttemptedAt"] = new Date();
    row["deliveryAttemptCount"] = 1;

    await expect(sendInvoice(ORG, "inv-1", "user-9")).rejects.toThrow(/interrupted/);
    expect(deliverInvoiceEmail).not.toHaveBeenCalled();
  });

  it("records a customer with nowhere to send as a failure, not a success", async () => {
    const { sendInvoice } = await import("../cost/invoices");
    await approved();
    deliverInvoiceEmail.mockResolvedValue({
      status: "no_targets",
      recipients: [],
      delivered: 0,
      error: "This customer has no contact email.",
    });

    const sent = await sendInvoice(ORG, "inv-1", "user-9");
    expect(sent.delivery!.status).toBe("no_targets");
    // And it is retryable once the address is added, without a confirmation.
    expect(await sendInvoice(ORG, "inv-1", "user-9")).toBeTruthy();
  });
});
