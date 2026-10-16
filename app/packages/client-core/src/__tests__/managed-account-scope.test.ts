import { describe, expect, it } from "vitest";
import {
  applyScopeAssignment,
  classifyUnassignedSpend,
  lastFullMonth,
  previewScopeAssignment,
  scopeBucketOwner,
  type ScopeOwner,
  type ScopeSpendBucket,
} from "../managed-account-scope";

const centres = [
  { id: "eng", name: "Engineering", parentId: null },
  { id: "platform", name: "Platform", parentId: "eng" },
  { id: "search", name: "Search", parentId: "platform" },
  { id: "sales", name: "Sales", parentId: null },
];
const accounts = [
  { id: "a1", displayName: "prod-aws", pluginId: "aws" },
  { id: "a2", displayName: "staging-gcp", pluginId: "gcp" },
  { id: "a3", displayName: "sandbox", pluginId: "aws" },
];
const buckets: ScopeSpendBucket[] = [
  { bucket: "eng", currency: "USD", amount: 10 },
  { bucket: "platform", currency: "USD", amount: 100 },
  { bucket: "search", currency: "USD", amount: 40 },
  { bucket: "sales", currency: "USD", amount: 25 },
  { bucket: "acct:a1", currency: "USD", amount: 300 },
  { bucket: "acct:a2", currency: "EUR", amount: 50 },
  { bucket: "acct:a3", currency: "USD", amount: 5 },
  { bucket: "", currency: "USD", amount: 7 },
  // A centre deleted since: its spend has nowhere to be assigned.
  { bucket: "gone", currency: "USD", amount: 3 },
];
const owners: ScopeOwner[] = [
  { id: "c1", name: "Northwind", costCentreIds: ["platform"], accountIds: ["a1"] },
  { id: "c2", name: "Contoso", costCentreIds: [], accountIds: [] },
];

describe("scopeBucketOwner", () => {
  const byId = new Map(centres.map((c) => [c.id, c]));
  it("bills a centre through any ancestor, and an account by name", () => {
    expect(scopeBucketOwner("search", byId, owners)?.id).toBe("c1");
    expect(scopeBucketOwner("eng", byId, owners)).toBeNull();
    expect(scopeBucketOwner("acct:a1", byId, owners)?.id).toBe("c1");
    expect(scopeBucketOwner("acct:a2", byId, owners)).toBeNull();
    expect(scopeBucketOwner("", byId, owners)).toBeNull();
  });
});

describe("classifyUnassignedSpend", () => {
  const report = classifyUnassignedSpend({
    periodFrom: "2026-01-01",
    periodTo: "2026-01-31",
    buckets,
    centres,
    accounts,
    owners,
  });

  it("lists what no customer is billed for, biggest first, with centre paths", () => {
    expect(report.rows.map((r) => [r.kind, r.id, r.name])).toEqual([
      ["account", "a2", "staging-gcp"],
      ["cost_centre", "sales", "Sales"],
      ["unallocated", null, ""],
      ["cost_centre", "eng", "Engineering"],
      ["account", "a3", "sandbox"],
    ]);
    expect(report.assignable).toBe(4);
  });

  it("totals assigned and unassigned so they add up to everything", () => {
    expect(report.totals.assigned).toEqual({ USD: 440 });
    expect(report.totals.unassigned).toEqual({ USD: 50, EUR: 50 });
    expect(report.totals.all).toEqual({ USD: 490, EUR: 50 });
  });
});

describe("previewScopeAssignment", () => {
  it("moves a centre's whole subtree and an account's unclaimed spend", () => {
    const preview = previewScopeAssignment({
      periodFrom: "2026-01-01",
      periodTo: "2026-01-31",
      assignment: {
        managedAccountId: "c2",
        costCentreIds: ["platform", "sales"],
        accountIds: ["a2"],
      },
      buckets,
      centres,
      accounts,
      owners,
      draftCounts: new Map([
        ["c1", 1],
        ["c2", 2],
      ]),
    });
    expect(preview.target).toEqual({ id: "c2", name: "Contoso" });
    expect(preview.items.map((i) => [i.id, i.fromManagedAccountName, i.amounts])).toEqual([
      ["platform", "Northwind", { USD: 140 }],
      ["sales", null, { USD: 25 }],
      ["a2", null, { EUR: 50 }],
    ]);
    expect(preview.moves).toEqual([
      { fromManagedAccountId: "c1", fromManagedAccountName: "Northwind", amounts: { USD: 140 } },
      { fromManagedAccountId: null, fromManagedAccountName: null, amounts: { USD: 25, EUR: 50 } },
    ]);
    expect(preview.total).toEqual({ USD: 165, EUR: 50 });
    expect(preview.affectedDrafts).toBe(3);
    expect(preview.warnings).toEqual([]);
  });

  it("marks items already with the target and moves nothing for them", () => {
    const preview = previewScopeAssignment({
      periodFrom: "2026-01-01",
      periodTo: "2026-01-31",
      assignment: { managedAccountId: "c1", costCentreIds: ["platform"], accountIds: [] },
      buckets,
      centres,
      accounts,
      owners,
    });
    expect(preview.items[0]!.unchanged).toBe(true);
    expect(preview.total).toEqual({});
  });

  it("warns when a centre sits under another customer's centre", () => {
    const preview = previewScopeAssignment({
      periodFrom: "2026-01-01",
      periodTo: "2026-01-31",
      assignment: { managedAccountId: "c2", costCentreIds: ["search"], accountIds: [] },
      buckets,
      centres,
      accounts,
      owners,
    });
    expect(preview.warnings[0]).toMatch(/Engineering → Platform → Search sits under .*Northwind/);
  });
});

describe("applyScopeAssignment", () => {
  it("takes items off their owner and appends them to the target", () => {
    expect(
      applyScopeAssignment(owners, {
        managedAccountId: "c2",
        costCentreIds: ["platform", "sales"],
        accountIds: ["a1"],
      }),
    ).toEqual([
      { id: "c1", costCentreIds: [], accountIds: [] },
      { id: "c2", costCentreIds: ["platform", "sales"], accountIds: ["a1"] },
    ]);
  });

  it("unassigns with a null target and leaves untouched customers out", () => {
    expect(
      applyScopeAssignment(owners, {
        managedAccountId: null,
        costCentreIds: [],
        accountIds: ["a1"],
      }),
    ).toEqual([{ id: "c1", costCentreIds: ["platform"], accountIds: [] }]);
  });

  it("is a no-op when everything is already in place", () => {
    expect(
      applyScopeAssignment(owners, {
        managedAccountId: "c1",
        costCentreIds: ["platform"],
        accountIds: ["a1"],
      }),
    ).toEqual([]);
  });
});

describe("lastFullMonth", () => {
  it("is the calendar month before now", () => {
    expect(lastFullMonth(new Date("2026-03-15T12:00:00Z"))).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(lastFullMonth(new Date("2026-01-01T00:00:00Z"))).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });
});
