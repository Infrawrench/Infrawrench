/**
 * The showback report with the org's billing rules applied — the surface where
 * an adjustment is actually a chargeback, so the properties are sharper here
 * than on a chart.
 *
 * 1. **Off by default.** A chargeback statement that silently showed marked-up
 *    numbers is one the receiving team could not reconcile, so the rules are
 *    not even read unless asked for.
 * 2. **Reallocation conserves money at the report level too.** Moving a shared
 *    cluster onto the teams that use it changes who owes what and not how much
 *    is owed in total.
 * 3. **Fixed charges land on the centre they name**, pro-rated over the period,
 *    and are still reported separately so they can be subtracted back out.
 * 4. **The collected totals come back beside the adjusted ones.**
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostCentre } from "@infrawrench/client-core";

const mockListCostCentres = vi.fn();
const mockListAllocationRules = vi.fn();
const mockGetShowbackSpend = vi.fn();
const mockResolveBilling = vi.fn();

vi.mock("@infrawrench/server-core/cost/allocation", () => ({
  listCostCentres: (...args: unknown[]) => mockListCostCentres(...args),
  listAllocationRules: (...args: unknown[]) => mockListAllocationRules(...args),
}));
vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  getShowbackSpend: (...args: unknown[]) => mockGetShowbackSpend(...args),
}));
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: (...args: unknown[]) => mockResolveBilling(...args),
}));
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  loadConversionContext: vi.fn().mockResolvedValue({ displayCurrency: null, rates: [] }),
}));

const { getShowbackReport } = await import("@/services/showback");

function centre(id: string, name: string): CostCentre {
  return {
    id,
    name,
    description: null,
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const CENTRES = [centre("cc-eng", "Engineering"), centre("cc-data", "Data")];
const FROM = "2026-09-01";
const TO = "2026-09-30";

const MARKUP = {
  adjustments: {
    factors: [{ ruleId: "r1", name: "Overhead", match: {}, factor: 1.2 }],
    reallocations: [],
    fixed: [],
  },
  rules: [
    { id: "r1", name: "Overhead", kind: "percentage" as const, summary: "+20% on all spend" },
  ],
};

function totalsOf(report: Awaited<ReturnType<typeof getShowbackReport>>, currency: string) {
  // `totals` is spend allocated *directly* to a centre, so summing it across
  // every row is the org's spend for the period — parents do not double count.
  return report.centres.reduce((sum, c) => sum + (c.totals[currency] ?? 0), 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListCostCentres.mockResolvedValue(CENTRES);
  mockListAllocationRules.mockResolvedValue([]);
  mockGetShowbackSpend.mockResolvedValue([]);
  mockResolveBilling.mockResolvedValue(MARKUP);
});

describe("an unadjusted showback report", () => {
  it("does not read the rules table and passes no adjustments to the reader", async () => {
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-eng", currency: "USD", amount: 1000 },
    ]);
    const report = await getShowbackReport("org-1", FROM, TO);

    expect(mockResolveBilling).not.toHaveBeenCalled();
    expect(mockGetShowbackSpend.mock.calls[0]![5]).toBeUndefined();
    expect(report.adjustment).toBeUndefined();
    expect(totalsOf(report, "USD")).toBe(1000);
  });
});

describe("an adjusted showback report", () => {
  it("compiles the rules into the same single scan and reports the collected totals", async () => {
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-eng", currency: "USD", amount: 1200, rawAmount: 1000 },
      { costCentreId: "cc-data", currency: "USD", amount: 600, rawAmount: 500 },
    ]);
    const report = await getShowbackReport("org-1", FROM, TO, undefined, undefined, true);

    expect(mockGetShowbackSpend).toHaveBeenCalledTimes(1);
    expect(mockGetShowbackSpend.mock.calls[0]![5]).toEqual(MARKUP.adjustments);
    expect(totalsOf(report, "USD")).toBe(1800);
    expect(report.adjustment?.rawTotals).toEqual({ USD: 1500 });
    expect(report.adjustment?.rules.map((r) => r.name)).toEqual(["Overhead"]);
  });

  it("conserves the total when a reallocation moves spend between centres", async () => {
    // The reader already applied the reallocation, so the money arrives under
    // different centres. What must hold at this level is that the report's own
    // arithmetic neither creates nor loses any of it.
    mockResolveBilling.mockResolvedValue({
      adjustments: {
        factors: [],
        reallocations: [
          {
            ruleId: "r1",
            name: "Shared cluster",
            match: { service: "AmazonEKS" },
            targetKind: "cost_centre" as const,
            targetId: "cc-data",
          },
        ],
        fixed: [],
      },
      rules: [
        {
          id: "r1",
          name: "Shared cluster",
          kind: "reallocation" as const,
          summary: "move to cost centre cc-data on service AmazonEKS",
        },
      ],
    });
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-eng", currency: "USD", amount: 700, rawAmount: 1000 },
      { costCentreId: "cc-data", currency: "USD", amount: 800, rawAmount: 500 },
    ]);
    const report = await getShowbackReport("org-1", FROM, TO, undefined, undefined, true);

    expect(totalsOf(report, "USD")).toBe(1500);
    expect(report.adjustment?.rawTotals).toEqual({ USD: 1500 });
    // No fixed rule, so the two are exactly equal: reallocation moved money
    // between centres and created none.
    expect(report.adjustment?.fixedTotals).toEqual({});
  });

  it("books a fixed charge onto the centre it names, and still reports it apart", async () => {
    mockResolveBilling.mockResolvedValue({
      adjustments: {
        factors: [],
        reallocations: [],
        fixed: [
          {
            ruleId: "f1",
            name: "Platform overhead",
            amount: 3000,
            currency: "USD",
            period: "monthly" as const,
            targetKind: "cost_centre" as const,
            targetId: "cc-eng",
          },
        ],
      },
      rules: [],
    });
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "cc-eng", currency: "USD", amount: 1000, rawAmount: 1000 },
    ]);
    const report = await getShowbackReport("org-1", FROM, TO, undefined, undefined, true);

    const eng = report.centres.find((c) => c.costCentreId === "cc-eng")!;
    expect(eng.totals["USD"]).toBe(4000);
    expect(report.adjustment?.fixedTotals).toEqual({ USD: 3000 });
    // The collected figure is untouched by a charge no provider ever billed.
    expect(report.adjustment?.rawTotals).toEqual({ USD: 1000 });
  });

  it("pro-rates a fixed charge over a partial period", async () => {
    mockResolveBilling.mockResolvedValue({
      adjustments: {
        factors: [],
        reallocations: [],
        fixed: [
          {
            ruleId: "f1",
            name: "Platform overhead",
            amount: 3000,
            currency: "USD",
            period: "monthly" as const,
            targetKind: "cost_centre" as const,
            targetId: "cc-eng",
          },
        ],
      },
      rules: [],
    });
    const report = await getShowbackReport("org-1", FROM, "2026-09-10", undefined, undefined, true);
    expect(report.adjustment?.fixedTotals["USD"]).toBeCloseTo(1000, 6);
  });

  it("puts an untargeted or account-targeted fixed charge in Unallocated, not on a centre", async () => {
    // A charge nobody agreed to must not be invented onto somebody's centre.
    mockResolveBilling.mockResolvedValue({
      adjustments: {
        factors: [],
        reallocations: [],
        fixed: [
          {
            ruleId: "f1",
            name: "Org-level",
            amount: 900,
            currency: "USD",
            period: "monthly" as const,
            targetKind: null,
            targetId: null,
          },
          {
            ruleId: "f2",
            name: "Account-booked",
            amount: 100,
            currency: "USD",
            period: "monthly" as const,
            targetKind: "account" as const,
            targetId: "acct-a",
          },
        ],
      },
      rules: [],
    });
    const report = await getShowbackReport("org-1", FROM, TO, undefined, undefined, true);

    const unallocated = report.centres.find((c) => c.costCentreId === null)!;
    expect(unallocated.totals["USD"]).toBe(1000);
    for (const c of report.centres.filter((x) => x.costCentreId !== null)) {
      expect(c.totals["USD"] ?? 0).toBe(0);
    }
  });
});
