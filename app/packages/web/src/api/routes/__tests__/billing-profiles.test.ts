import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * Billing profile routes: the permission split (read vs prepare), the error
 * mapping, and the one thing an auditor will check first, that bank account
 * numbers never reach the audit log in full.
 */

const service = {
  listBillingProfiles: vi.fn(),
  getBillingProfile: vi.fn(),
  createBillingProfile: vi.fn(),
  updateBillingProfile: vi.fn(),
  deleteBillingProfile: vi.fn(),
};

class BillingProfileError extends Error {}
class BillingProfileNameConflictError extends Error {}
class BillingProfileInUseError extends Error {
  constructor(readonly customers: string[]) {
    super(`assigned to ${customers.join(", ")}`);
  }
}

vi.mock("@infrawrench/server-core/cost/billing-profiles", () => ({
  BillingProfileError,
  BillingProfileNameConflictError,
  BillingProfileInUseError,
  listBillingProfiles: (...a: unknown[]) => service.listBillingProfiles(...a),
  getBillingProfile: (...a: unknown[]) => service.getBillingProfile(...a),
  createBillingProfile: (...a: unknown[]) => service.createBillingProfile(...a),
  updateBillingProfile: (...a: unknown[]) => service.updateBillingProfile(...a),
  deleteBillingProfile: (...a: unknown[]) => service.deleteBillingProfile(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { billingProfileRoutes } = await import("../billing-profiles");

const BANK = {
  accountName: "Fabrikam Ltd",
  bankName: "West Bank",
  iban: "GB82 WEST 1234 5698 7654 32",
  bic: "WESTGB2L",
  accountNumber: "98765432",
  routingNumber: null,
  instructions: "Pay to 98765432",
};

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "bp-1",
    name: "EU customers",
    legalName: null,
    address: null,
    taxId: null,
    poNumber: null,
    toEmails: [],
    ccEmails: [],
    currency: null,
    paymentTermsDays: 30,
    numberPrefix: "INV",
    numberIncludesYear: true,
    numberStart: 1,
    taxRates: [],
    bank: BANK,
    footer: null,
    logo: null,
    managedAccountIds: ["cust-1"],
    createdByUserId: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => vi.clearAllMocks());

describe("billing profile routes", () => {
  it("reads on invoices:read and writes on invoices:write, never costs:read", async () => {
    const costs = buildTestApp(billingProfileRoutes, ["costs:read", "costs:write"]);
    expect((await costs.request("/")).status).toBe(403);

    const reader = buildTestApp(billingProfileRoutes, ["invoices:read"]);
    service.listBillingProfiles.mockResolvedValue([profile()]);
    expect((await reader.request("/")).status).toBe(200);
    expect((await reader.request("/", json({ name: "x" }))).status).toBe(403);
    expect(service.createBillingProfile).not.toHaveBeenCalled();
  });

  it("never writes a full account number into the audit log", async () => {
    const app = buildTestApp(billingProfileRoutes, ["invoices:write"]);
    service.updateBillingProfile.mockResolvedValue({
      before: profile(),
      after: profile({
        bank: { ...BANK, iban: "DE89 3704 0044 0532 0130 00" },
        paymentTermsDays: 14,
      }),
    });
    const res = await app.request("/bp-1", json({ name: "EU customers" }, "PUT"));
    expect(res.status).toBe(200);
    const entry = mockLogAudit.mock.calls[0]![0] as {
      action: string;
      metadata: { changes: Record<string, unknown>; managedAccountIds: string[] };
    };
    expect(entry.action).toBe("billing_profile.update");
    expect(Object.keys(entry.metadata.changes).sort()).toEqual(["bank", "paymentTermsDays"]);
    const logged = JSON.stringify(entry);
    expect(logged).not.toContain("3704 0044");
    expect(logged).not.toContain("1234 5698");
    expect(logged).not.toContain("98765432");
    expect(entry.metadata.managedAccountIds).toEqual(["cust-1"]);
  });

  it("audits a creation with the bank masked too", async () => {
    const app = buildTestApp(billingProfileRoutes);
    service.createBillingProfile.mockResolvedValue(profile());
    const res = await app.request("/", json({ name: "EU customers" }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(mockLogAudit.mock.calls[0]![0])).not.toContain("1234 5698");
  });

  it("refuses a delete while customers use the profile, naming them", async () => {
    const app = buildTestApp(billingProfileRoutes);
    service.deleteBillingProfile.mockRejectedValue(new BillingProfileInUseError(["Northwind"]));
    const res = await app.request("/bp-1", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ customers: ["Northwind"] });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("maps validation and name conflicts", async () => {
    const app = buildTestApp(billingProfileRoutes);
    service.createBillingProfile.mockRejectedValueOnce(new BillingProfileError("bad IBAN"));
    expect((await app.request("/", json({ name: "x" }))).status).toBe(400);
    service.createBillingProfile.mockRejectedValueOnce(new BillingProfileNameConflictError("dup"));
    expect((await app.request("/", json({ name: "x" }))).status).toBe(409);
    // Shape is checked before the service is reached.
    expect((await app.request("/", json({ name: "" }))).status).toBe(400);
    expect(service.createBillingProfile).toHaveBeenCalledTimes(2);
  });

  it("404s an unknown profile", async () => {
    const app = buildTestApp(billingProfileRoutes);
    service.getBillingProfile.mockResolvedValue(null);
    expect((await app.request("/nope")).status).toBe(404);
    service.updateBillingProfile.mockResolvedValue(null);
    expect((await app.request("/nope", json({ name: "x" }, "PUT"))).status).toBe(404);
  });
});
