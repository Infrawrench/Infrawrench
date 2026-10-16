import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service half of bulk assignment and the unassigned-spend finder: that
 * the scan resolves spend the way an invoice does (the org's allocation rules
 * first, then one rule per account), and that an assignment rewrites every
 * affected customer inside one locked transaction. The arithmetic itself is
 * client-core's and tested there.
 */

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  asc: (a: unknown) => a,
  isNull: (a: unknown) => ({ op: "isNull", a }),
  sql: Object.assign((...args: unknown[]) => ({ op: "sql", args }), { raw: (s: string) => s }),
}));

vi.mock("../db/schema", () => ({
  accounts: { __table: "accounts", id: "id", organizationId: "organizationId" },
  managedAccounts: { __table: "managed_accounts", id: "id", organizationId: "organizationId" },
  managedInvoices: { __table: "managed_invoices", managedAccountId: "managedAccountId" },
}));

const cloudAccounts = [
  { id: "a1", displayName: "prod", pluginId: "aws" },
  { id: "a2", displayName: "staging", pluginId: "gcp" },
];
let customers: Array<Record<string, unknown>> = [];
const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
const locks: string[] = [];

function chain(rows: () => unknown[], table: string) {
  const q: Record<string, unknown> = {};
  for (const key of ["where", "orderBy", "groupBy", "limit"]) q[key] = () => q;
  q["for"] = (mode: string) => {
    locks.push(`${table}:${mode}`);
    return q;
  };
  q["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows()).then(res, rej);
  return q;
}

const db = {
  select: () => ({
    from: (table: { __table: string }) =>
      chain(() => {
        if (table.__table === "accounts") return cloudAccounts;
        if (table.__table === "managed_accounts") return customers;
        return [];
      }, table.__table),
  }),
  update: () => ({
    set: (set: Record<string, unknown>) => ({
      where: async (where: unknown) => {
        updates.push({ set, where });
      },
    }),
  }),
  transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(db),
};
vi.mock("../db/client", () => ({ db }));

const getShowbackSpend = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ getShowbackSpend }));

const listCostCentres = vi.fn();
const listAllocationRules = vi.fn();
vi.mock("../cost/allocation", () => ({ listCostCentres, listAllocationRules }));

class ManagedAccountError extends Error {}
const listManagedAccountRows = vi.fn();
vi.mock("../cost/managed-accounts", () => ({ ManagedAccountError, listManagedAccountRows }));

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  locks.length = 0;
  customers = [
    { id: "c1", name: "Northwind", costCentreIds: ["cc-1"], accountIds: ["a1"] },
    { id: "c2", name: "Contoso", costCentreIds: [], accountIds: [] },
  ];
  listCostCentres.mockResolvedValue([
    { id: "cc-1", name: "Platform", parentId: null },
    { id: "cc-2", name: "Search", parentId: null },
  ]);
  listAllocationRules.mockResolvedValue([
    { costCentreId: "cc-1", match: { tagKey: "team", tagValue: "platform" } },
    // A rule for a centre that no longer exists is skipped, as showback skips it.
    { costCentreId: "gone", match: { tagKey: "team", tagValue: "old" } },
  ]);
  listManagedAccountRows.mockImplementation(async () => customers);
  getShowbackSpend.mockResolvedValue([
    { costCentreId: "cc-1", currency: "USD", amount: 100 },
    { costCentreId: "cc-2", currency: "USD", amount: 40 },
    { costCentreId: "acct:a1", currency: "USD", amount: 300 },
    { costCentreId: "acct:a2", currency: "USD", amount: 25 },
  ]);
});

describe("loadScopeSpend", () => {
  it("runs the org's rules first and one rule per account after them, on raw amortized spend", async () => {
    const { loadScopeSpend } = await import("../cost/managed-account-scope");
    await loadScopeSpend("org-1", "2026-01-01", "2026-01-31");
    const [org, rules, from, to, basis, adjustments] = getShowbackSpend.mock.calls[0]!;
    expect([org, from, to, basis, adjustments]).toEqual([
      "org-1",
      "2026-01-01",
      "2026-01-31",
      "amortized",
      undefined,
    ]);
    expect((rules as Array<{ costCentreId: string }>).map((r) => r.costCentreId)).toEqual([
      "cc-1",
      "acct:a1",
      "acct:a2",
    ]);
  });
});

describe("findUnassignedSpend", () => {
  it("reports what no customer bills, over the last full month by default", async () => {
    const { findUnassignedSpend } = await import("../cost/managed-account-scope");
    const report = await findUnassignedSpend("org-1");
    expect(report.rows.map((r) => r.id)).toEqual(["cc-2", "a2"]);
    expect(report.totals.unassigned).toEqual({ USD: 65 });
    expect(report.periodFrom < report.periodTo).toBe(true);
  });

  it("refuses half a period and a backwards one", async () => {
    const { findUnassignedSpend } = await import("../cost/managed-account-scope");
    await expect(findUnassignedSpend("org-1", { from: "2026-01-01" })).rejects.toThrow(/both/);
    await expect(
      findUnassignedSpend("org-1", { from: "2026-02-01", to: "2026-01-01" }),
    ).rejects.toThrow(/before/);
  });
});

describe("assignManagedAccountScope", () => {
  it("rewrites every affected customer under a lock, taking items off their holder", async () => {
    const { assignManagedAccountScope } = await import("../cost/managed-account-scope");
    const changes = await assignManagedAccountScope("org-1", {
      managedAccountId: "c2",
      costCentreIds: ["cc-1", "cc-2"],
      accountIds: ["a1"],
    });
    expect(locks).toEqual(["managed_accounts:update"]);
    expect(changes.map((c) => [c.id, c.after])).toEqual([
      ["c1", { costCentreIds: [], accountIds: [] }],
      ["c2", { costCentreIds: ["cc-1", "cc-2"], accountIds: ["a1"] }],
    ]);
    expect(updates).toHaveLength(2);
  });

  it("refuses an unknown item or a retired target before writing anything", async () => {
    const { assignManagedAccountScope } = await import("../cost/managed-account-scope");
    await expect(
      assignManagedAccountScope("org-1", {
        managedAccountId: "c2",
        costCentreIds: ["nope"],
        accountIds: [],
      }),
    ).rejects.toThrow(/Unknown cost centre or account: nope/);
    await expect(
      assignManagedAccountScope("org-1", {
        managedAccountId: "retired",
        costCentreIds: ["cc-2"],
        accountIds: [],
      }),
    ).rejects.toThrow(/retired/);
    expect(updates).toHaveLength(0);
  });
});
