/**
 * The showback report over a *tree* of cost centres.
 *
 * The two things worth pinning here are the ones a reader of the numbers would
 * be hurt by if they broke silently: an org that never nests must report byte
 * for byte what it always did, and a cost row must be allocated exactly once no
 * matter how many rules could have claimed it — a parent's rule and a child's
 * included. The rollup arithmetic itself is unit-tested in client-core; what
 * this file adds is that the service wires it to one single-pass query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AllocationRule, CostCentre } from "@infrawrench/client-core";

const mockListCostCentres = vi.fn();
const mockListAllocationRules = vi.fn();
const mockGetShowbackSpend = vi.fn();

// Mocked rather than imported for real: both modules reach server-core's db /
// ClickHouse clients, which throw at import time without their env.
vi.mock("@infrawrench/server-core/cost/allocation", () => ({
  listCostCentres: (...args: unknown[]) => mockListCostCentres(...args),
  listAllocationRules: (...args: unknown[]) => mockListAllocationRules(...args),
}));

vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  getShowbackSpend: (...args: unknown[]) => mockGetShowbackSpend(...args),
}));

// Same reason: the billing-rule resolver reaches Postgres. None of these cases
// asks for an adjusted report, so it is never called — it only has to exist.
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: vi.fn(),
}));

// The conversion *arithmetic* is deliberately left real — it is pure — so a
// report that silently stopped converting subtree totals would fail here.
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  loadConversionContext: vi.fn().mockResolvedValue({ displayCurrency: null, rates: [] }),
}));

const { getShowbackReport } = await import("@/services/showback");

function centre(id: string, name: string, parentId: string | null = null): CostCentre {
  return {
    id,
    name,
    description: null,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function rule(id: string, costCentreId: string, priority: number): AllocationRule {
  return {
    id,
    costCentreId,
    priority,
    match: { tagKey: "team" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const RANGE = ["2026-07-01", "2026-07-31"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockListAllocationRules.mockResolvedValue([]);
  mockGetShowbackSpend.mockResolvedValue([]);
});

describe("getShowbackReport — an existing flat org", () => {
  const FLAT = [centre("plat", "Platform"), centre("data", "Data")];

  it("reports the same rows it always did, with subtree equal to own", async () => {
    mockListCostCentres.mockResolvedValue(FLAT);
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "plat", currency: "USD", amount: 300 },
      { costCentreId: "data", currency: "USD", amount: 120 },
    ]);

    const report = await getShowbackReport("org1", ...RANGE);

    expect(report.centres.map((c) => c.name)).toEqual(["Data", "Platform"]);
    for (const entry of report.centres) {
      expect(entry.depth).toBe(0);
      expect(entry.parentId).toBeNull();
      expect(entry.subtreeTotals).toEqual(entry.totals);
    }
    expect(report.centres.find((c) => c.costCentreId === "plat")!.totals).toEqual({ USD: 300 });
    expect(report.currencies).toEqual(["USD"]);
  });

  it("still reports unallocated spend as its own last row", async () => {
    mockListCostCentres.mockResolvedValue(FLAT);
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "plat", currency: "USD", amount: 300 },
      // The empty centre id is what the reader returns for a row no rule claimed.
      { costCentreId: "", currency: "USD", amount: 77 },
    ]);

    const report = await getShowbackReport("org1", ...RANGE);
    const last = report.centres[report.centres.length - 1]!;
    expect(last.costCentreId).toBeNull();
    expect(last.name).toBe("Unallocated");
    expect(last.totals).toEqual({ USD: 77 });
    expect(last.subtreeTotals).toEqual({ USD: 77 });
  });
});

describe("getShowbackReport — a nested org", () => {
  const TREE = [
    centre("eng", "Engineering"),
    centre("plat", "Platform", "eng"),
    centre("search", "Search", "plat"),
    centre("data", "Data", "eng"),
  ];

  beforeEach(() => {
    mockListCostCentres.mockResolvedValue(TREE);
  });

  it("rolls own spend up through every ancestor without double counting it", async () => {
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "eng", currency: "USD", amount: 100 },
      { costCentreId: "plat", currency: "USD", amount: 200 },
      { costCentreId: "search", currency: "USD", amount: 40 },
      { costCentreId: "data", currency: "USD", amount: 60 },
      { costCentreId: "", currency: "USD", amount: 10 },
    ]);

    const report = await getShowbackReport("org1", ...RANGE);
    const by = new Map(report.centres.map((c) => [c.costCentreId, c]));

    expect(by.get("eng")!.totals).toEqual({ USD: 100 });
    expect(by.get("eng")!.subtreeTotals).toEqual({ USD: 400 });
    expect(by.get("plat")!.subtreeTotals).toEqual({ USD: 240 });
    expect(by.get("search")!.subtreeTotals).toEqual({ USD: 40 });

    // The invariant the whole design rests on: own totals still add up to the
    // period's spend, so nothing was counted twice by the rollup.
    const ownSum = report.centres.reduce((acc, c) => acc + (c.totals["USD"] ?? 0), 0);
    expect(ownSum).toBe(410);
  });

  it("returns the tree depth-first so the client can indent without re-sorting", async () => {
    const report = await getShowbackReport("org1", ...RANGE);
    expect(report.centres.map((c) => [c.name, c.depth])).toEqual([
      ["Engineering", 0],
      ["Data", 1],
      ["Platform", 1],
      ["Search", 2],
    ]);
  });
});

describe("getShowbackReport — parent and child rules", () => {
  const TREE = [
    centre("eng", "Engineering"),
    centre("plat", "Platform", "eng"),
    centre("search", "Search", "plat"),
  ];

  it("hands ClickHouse one flat pre-ordered rule list — one pass, not one per segment", async () => {
    mockListCostCentres.mockResolvedValue(TREE);
    mockListAllocationRules.mockResolvedValue([
      rule("child", "search", 0),
      rule("parent", "eng", 1),
    ]);

    await getShowbackReport("org1", ...RANGE);

    expect(mockGetShowbackSpend).toHaveBeenCalledTimes(1);
    const [, rules] = mockGetShowbackSpend.mock.calls[0]!;
    // Exactly the order `listAllocationRules` produced — the service does not
    // re-sort, and it does not expand the list per level of the tree.
    expect(rules).toEqual([
      { costCentreId: "search", match: { tagKey: "team" } },
      { costCentreId: "eng", match: { tagKey: "team" } },
    ]);
  });

  it("allocates a row that both a parent rule and a child rule could claim exactly once", async () => {
    mockListCostCentres.mockResolvedValue(TREE);
    mockListAllocationRules.mockResolvedValue([
      rule("child", "search", 0),
      rule("parent", "eng", 1),
    ]);
    // First match wins in the single `multiIf`, so the row comes back attributed
    // to the child and to nothing else.
    mockGetShowbackSpend.mockResolvedValue([
      { costCentreId: "search", currency: "USD", amount: 500 },
    ]);

    const report = await getShowbackReport("org1", ...RANGE);
    const by = new Map(report.centres.map((c) => [c.costCentreId, c]));

    expect(by.get("search")!.totals).toEqual({ USD: 500 });
    // The parent claims none of it directly...
    expect(by.get("eng")!.totals).toEqual({});
    expect(by.get("plat")!.totals).toEqual({});
    // ...but still answers "what does Engineering cost" with the whole 500,
    // counted once on the way up.
    expect(by.get("eng")!.subtreeTotals).toEqual({ USD: 500 });
    const ownSum = report.centres.reduce((acc, c) => acc + (c.totals["USD"] ?? 0), 0);
    expect(ownSum).toBe(500);
  });

  it("drops a rule pointing at a centre the org no longer has rather than relabelling spend", async () => {
    mockListCostCentres.mockResolvedValue(TREE);
    mockListAllocationRules.mockResolvedValue([rule("stale", "gone", 0), rule("ok", "eng", 1)]);

    await getShowbackReport("org1", ...RANGE);
    const [, rules] = mockGetShowbackSpend.mock.calls[0]!;
    expect(rules).toEqual([{ costCentreId: "eng", match: { tagKey: "team" } }]);
  });
});
