import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * The invoice routes' permission boundary and its error mapping.
 *
 * The boundary is the interesting half. `invoices:write` prepares — add a
 * customer, raise a draft — and `invoices:issue` is the irreversible half:
 * approving freezes what a customer will be sent, sending states that they have
 * it, voiding withdraws a document already in their hands. An org that wants a
 * billing clerk preparing the month while only the finance lead issues it needs
 * those two to be genuinely separate, so that separation is pinned here.
 */

const service = {
  listManagedAccounts: vi.fn(),
  getManagedAccount: vi.fn(),
  createManagedAccount: vi.fn(),
  updateManagedAccount: vi.fn(),
  deleteManagedAccount: vi.fn(),
};

class ManagedAccountError extends Error {}
class ManagedAccountNameConflictError extends Error {}
class ManagedAccountScopeConflictError extends Error {
  constructor(readonly conflicts: unknown[]) {
    super('already billed to "Northwind"');
  }
}

vi.mock("@infrawrench/server-core/cost/managed-accounts", () => ({
  ManagedAccountError,
  ManagedAccountNameConflictError,
  ManagedAccountScopeConflictError,
  listManagedAccounts: (...a: unknown[]) => service.listManagedAccounts(...a),
  getManagedAccount: (...a: unknown[]) => service.getManagedAccount(...a),
  createManagedAccount: (...a: unknown[]) => service.createManagedAccount(...a),
  updateManagedAccount: (...a: unknown[]) => service.updateManagedAccount(...a),
  deleteManagedAccount: (...a: unknown[]) => service.deleteManagedAccount(...a),
}));

class InvoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const invoices = {
  listInvoices: vi.fn(),
  getInvoice: vi.fn(),
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
  deleteInvoice: vi.fn(),
  approveInvoice: vi.fn(),
  sendInvoice: vi.fn(),
  voidInvoice: vi.fn(),
  renderInvoiceCsv: vi.fn((..._a: unknown[]) => "number,total\nINV-2026-0001,100\n"),
};

vi.mock("@infrawrench/server-core/cost/invoices", () => ({
  InvoiceError,
  listInvoices: (...a: unknown[]) => invoices.listInvoices(...a),
  getInvoice: (...a: unknown[]) => invoices.getInvoice(...a),
  createInvoice: (...a: unknown[]) => invoices.createInvoice(...a),
  updateInvoice: (...a: unknown[]) => invoices.updateInvoice(...a),
  deleteInvoice: (...a: unknown[]) => invoices.deleteInvoice(...a),
  approveInvoice: (...a: unknown[]) => invoices.approveInvoice(...a),
  sendInvoice: (...a: unknown[]) => invoices.sendInvoice(...a),
  voidInvoice: (...a: unknown[]) => invoices.voidInvoice(...a),
  renderInvoiceCsv: (...a: unknown[]) => invoices.renderInvoiceCsv(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { invoiceRoutes, managedAccountRoutes } = await import("../invoices");

const INVOICE = {
  id: "inv-1",
  managedAccountId: "cust-1",
  managedAccountName: "Northwind",
  number: "INV-2026-0001",
  status: "approved",
  periodFrom: "2026-01-01",
  periodTo: "2026-01-31",
  currency: "GBP",
  totals: { collected: {}, adjustment: {}, adjusted: {}, billed: { GBP: 1104 } },
  derivation: { rateDate: "2026-01-31" },
  supersedesInvoiceId: null,
};

beforeEach(() => vi.clearAllMocks());

describe("permission boundary", () => {
  it("refuses reads without invoices:read, costs:read notwithstanding", async () => {
    const app = buildTestApp(invoiceRoutes, ["costs:read", "costs:write"]);
    const res = await app.request("/");
    expect(res.status).toBe(403);
    expect(invoices.listInvoices).not.toHaveBeenCalled();
  });

  it("lets invoices:write raise a draft but not approve one", async () => {
    const app = buildTestApp(invoiceRoutes, ["invoices:read", "invoices:write"]);

    invoices.createInvoice.mockResolvedValue({ ...INVOICE, status: "draft", number: null });
    const created = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        managedAccountId: "cust-1",
        periodFrom: "2026-01-01",
        periodTo: "2026-01-31",
      }),
    });
    expect(created.status).toBe(200);

    // The maker-checker split: preparing is not issuing.
    const approved = await app.request("/inv-1/approve", { method: "POST" });
    expect(approved.status).toBe(403);
    expect(invoices.approveInvoice).not.toHaveBeenCalled();
  });

  it("lets invoices:issue approve, send and void", async () => {
    const app = buildTestApp(invoiceRoutes, ["invoices:read", "invoices:issue"]);
    invoices.approveInvoice.mockResolvedValue(INVOICE);
    invoices.sendInvoice.mockResolvedValue({ ...INVOICE, status: "sent" });
    invoices.voidInvoice.mockResolvedValue({
      invoice: { ...INVOICE, status: "void" },
      replacement: null,
    });

    expect((await app.request("/inv-1/approve", { method: "POST" })).status).toBe(200);
    expect((await app.request("/inv-1/send", { method: "POST" })).status).toBe(200);
    const voided = await app.request("/inv-1/void", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Wrong cost centre" }),
    });
    expect(voided.status).toBe(200);
  });

  it("does not let invoices:issue create or delete drafts", async () => {
    const app = buildTestApp(invoiceRoutes, ["invoices:read", "invoices:issue"]);
    const created = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        managedAccountId: "c1",
        periodFrom: "2026-01-01",
        periodTo: "2026-01-31",
      }),
    });
    expect(created.status).toBe(403);
    expect((await app.request("/inv-1", { method: "DELETE" })).status).toBe(403);
  });

  it("gates the managed-account routes the same way", async () => {
    const readOnly = buildTestApp(managedAccountRoutes, ["invoices:read"]);
    service.listManagedAccounts.mockResolvedValue([]);
    expect((await readOnly.request("/")).status).toBe(200);
    const created = await readOnly.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", billingCurrency: "GBP" }),
    });
    expect(created.status).toBe(403);
  });
});

describe("error mapping", () => {
  it("surfaces the service's refusal verbatim with its own status", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.deleteInvoice.mockRejectedValue(
      new InvoiceError("Void it and raise a corrective invoice.", 409),
    );
    const res = await app.request("/inv-1", { method: "DELETE" });
    expect(res.status).toBe(409);
    // The user reads the same sentence the UI's disabled tooltip shows.
    expect(await res.json()).toEqual({ error: "Void it and raise a corrective invoice." });
  });

  it("maps a scope conflict to 409 and names the other customer", async () => {
    const app = buildTestApp(managedAccountRoutes);
    service.createManagedAccount.mockRejectedValue(
      new ManagedAccountScopeConflictError([
        { kind: "cost_centre", id: "cc-1", ownerName: "Northwind" },
      ]),
    );
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Contoso", billingCurrency: "GBP", costCentreIds: ["cc-1"] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; conflicts: unknown[] };
    expect(body.error).toContain("Northwind");
    expect(body.conflicts).toHaveLength(1);
  });

  it("passes the resend flag through, and defaults it off for a bodyless send", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.sendInvoice.mockResolvedValue({ ...INVOICE, status: "sent", delivery: null });

    // The ordinary first send: no body at all.
    await app.request("/inv-1/send", { method: "POST" });
    expect(invoices.sendInvoice).toHaveBeenLastCalledWith("org-1", "inv-1", "user-1", {
      resend: false,
    });

    // The deliberate second copy has to be asked for in as many words.
    await app.request("/inv-1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resend: true }),
    });
    expect(invoices.sendInvoice).toHaveBeenLastCalledWith("org-1", "inv-1", "user-1", {
      resend: true,
    });
  });

  it("surfaces the refusal to double-send as a 409 the user can read", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.sendInvoice.mockRejectedValue(
      new InvoiceError("This invoice already reached 1 of 1 recipient on 2026-02-01.", 409),
    );
    const res = await app.request("/inv-1/send", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: "This invoice already reached 1 of 1 recipient on 2026-02-01.",
    });
  });

  it("rejects a void with no reason before reaching the service", async () => {
    const app = buildTestApp(invoiceRoutes);
    const res = await app.request("/inv-1/void", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "" }),
    });
    expect(res.status).toBe(400);
    expect(invoices.voidInvoice).not.toHaveBeenCalled();
  });
});

describe("audit", () => {
  it("records the frozen figure on approval, so who-approved-what survives", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.approveInvoice.mockResolvedValue(INVOICE);
    await app.request("/inv-1/approve", { method: "POST" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invoice.approve",
        entityType: "invoice",
        entityId: "inv-1",
        userId: "user-1",
        metadata: expect.objectContaining({
          number: "INV-2026-0001",
          billed: { GBP: 1104 },
          rateDate: "2026-01-31",
        }),
      }),
    );
  });

  it("records what became of the delivery, not merely that Send was pressed", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.sendInvoice.mockResolvedValue({
      ...INVOICE,
      status: "sent",
      delivery: {
        status: "partial",
        recipients: ["ap@northwind.example", "finance@northwind.example"],
        delivered: 1,
        attemptedAt: "2026-02-01T10:00:00.000Z",
        deliveredAt: "2026-02-01T10:00:00.000Z",
        attempts: 1,
        error: "Delivered to 1 of 2 recipients",
      },
    });
    const res = await app.request("/inv-1/send", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invoice.send",
        metadata: expect.objectContaining({
          resend: false,
          deliveryStatus: "partial",
          delivered: 1,
          recipients: ["ap@northwind.example", "finance@northwind.example"],
        }),
      }),
    );
  });

  it("logs the corrective invoice as its own creation, not a side effect", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.voidInvoice.mockResolvedValue({
      invoice: { ...INVOICE, status: "void" },
      replacement: { ...INVOICE, id: "inv-2", number: null, status: "draft" },
    });
    await app.request("/inv-1/void", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Wrong period", supersede: true }),
    });
    const actions = mockLogAudit.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(["invoice.void", "invoice.create"]);
  });
});

describe("export", () => {
  it("serves the CSV as an attachment named after the invoice", async () => {
    const app = buildTestApp(invoiceRoutes);
    invoices.getInvoice.mockResolvedValue(INVOICE);
    const res = await app.request("/inv-1/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="INV-2026-0001.csv"');
    expect(await res.text()).toContain("INV-2026-0001");
  });
});
