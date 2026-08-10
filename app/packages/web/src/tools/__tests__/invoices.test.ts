import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListManagedAccounts = vi.fn();
const mockGetManagedAccount = vi.fn();
vi.mock("@infrawrench/server-core/cost/managed-accounts", () => ({
  listManagedAccounts: (...a: unknown[]) => mockListManagedAccounts(...a),
  getManagedAccount: (...a: unknown[]) => mockGetManagedAccount(...a),
}));

const mockListInvoices = vi.fn();
const mockGetInvoice = vi.fn();
vi.mock("@infrawrench/server-core/cost/invoices", () => ({
  listInvoices: (...a: unknown[]) => mockListInvoices(...a),
  getInvoice: (...a: unknown[]) => mockGetInvoice(...a),
}));

const mockResolvePerms = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolvePerms(...a),
}));

const { invoiceTools } = await import("../invoices");
const tools = invoiceTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "mcp" as const };

function grant(...permissions: string[]) {
  mockResolvePerms.mockResolvedValue({ permissions, role: null });
}

describe("invoiceTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grant("invoices:read");
  });

  it("exposes reads only — issuing an invoice is not a thing a model does", () => {
    // Approving freezes the figures a customer will be sent and sending states
    // that they have them. Both carry an audit entry naming a person, which a
    // tool call cannot provide.
    expect(tools.every((t) => t.risk === "read")).toBe(true);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_invoice",
      "get_managed_account",
      "list_invoices",
      "list_managed_accounts",
    ]);
  });

  it("gates every tool behind invoices:read, not costs:read", async () => {
    // A cost graph is the org's own spend; a managed account is a customer's
    // contact details and the price they were quoted.
    grant("costs:read");
    for (const t of tools) {
      const result = await t.handler({ invoiceId: "i1", managedAccountId: "c1" }, auth);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("invoices:read");
    }
    expect(mockListInvoices).not.toHaveBeenCalled();
    expect(mockListManagedAccounts).not.toHaveBeenCalled();
  });

  it("list_invoices passes the optional filters straight through", async () => {
    mockListInvoices.mockResolvedValue([]);
    await tool("list_invoices").handler({ managedAccountId: "c1", status: "sent" }, auth);
    expect(mockListInvoices).toHaveBeenCalledWith("o1", {
      managedAccountId: "c1",
      status: "sent",
    });
  });

  it("list_invoices with no filter asks for everything", async () => {
    mockListInvoices.mockResolvedValue([]);
    await tool("list_invoices").handler({}, auth);
    expect(mockListInvoices).toHaveBeenCalledWith("o1", {
      managedAccountId: undefined,
      status: undefined,
    });
  });

  it("get_invoice returns the invoice, live flag included", async () => {
    mockGetInvoice.mockResolvedValue({ id: "i1", live: false, totals: { billed: { GBP: 100 } } });
    const result = await tool("get_invoice").handler({ invoiceId: "i1" }, auth);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('"live": false');
  });

  it("get_invoice reports a missing invoice rather than an empty answer", async () => {
    mockGetInvoice.mockResolvedValue(null);
    const result = await tool("get_invoice").handler({ invoiceId: "nope" }, auth);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("nope");
  });

  it("get_managed_account reports a missing customer", async () => {
    mockGetManagedAccount.mockResolvedValue(null);
    const result = await tool("get_managed_account").handler({ managedAccountId: "nope" }, auth);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("nope");
  });

  it("tells the model that a draft's totals are null rather than zero", () => {
    // The most likely way an agent misreports this feature is quoting a draft
    // as being worth nothing, so the description has to say it outright.
    expect(tool("list_invoices").description).toMatch(/null\b.*not zero/is);
  });
});
