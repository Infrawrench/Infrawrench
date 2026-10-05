/**
 * Cost visibility scopes, tested against the SQL the readers actually emit.
 *
 * The claim the feature rests on is that a scope is applied *where cost
 * queries are built*, not per route. So this suite:
 *
 * 1. calls **every** exported `cost_daily` reader inside a scoped execution and
 *    asserts the scope predicate reaches the statement ClickHouse receives;
 * 2. asserts an unrestricted (or absent) visibility emits the bare org
 *    predicate, byte-identical to before scopes existed;
 * 3. guards the source: no reader may build its own
 *    `eq(costDaily.organization_id, …)`, which is how a future reader would
 *    silently bypass the scope;
 * 4. pins the pure helpers (strict accounts, subtree expansion, org mismatch).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();
const captured = ch.queries;

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

const readers = await import("../clickhouse/cost-readers");
const commitmentReaders = await import("../clickhouse/commitment-readers");
const flowReaders = await import("../clickhouse/network-flow-readers");
const ctx = await import("../cost/visibility-context");
const { expandCentreSubtrees } = ctx;

const ORG = "org-1";

function scoped(
  layers: Array<Partial<import("../cost/visibility-context").CompiledCostVisibilityLayer>>,
): import("../cost/visibility-context").CostVisibility {
  return {
    organizationId: ORG,
    restricted: true,
    userId: "user-1",
    layers: layers.map((l) => ({
      source: {
        kind: "member",
        label: null,
        costCentreIds: [],
        accountIds: [],
        savedFilterId: null,
      },
      accountIds: [],
      costCentreIds: [],
      rules: [],
      filters: null,
      unresolvable: false,
      ...l,
    })),
  };
}

const ACCOUNT_SCOPE = scoped([{ accountIds: ["acct-visible"] }]);

/** Every reader of `cost_daily`, invoked once. New readers must be added here. */
const READ_CALLS: Array<[string, () => Promise<unknown>]> = [
  [
    "queryCosts",
    () =>
      readers.queryCosts(ORG, {
        from: "2026-09-01",
        to: "2026-09-30",
        binning: "daily",
        groupBy: "service",
        filters: [],
      }),
  ],
  ["getResourceCostTotals", () => readers.getResourceCostTotals(ORG, "2026-09-01", "2026-09-30")],
  ["getCostDimensionValues", () => readers.getCostDimensionValues(ORG, "service")],
  ["getCostTagKeys", () => readers.getCostTagKeys(ORG)],
  [
    "queryUsageDaily",
    () =>
      readers.queryUsageDaily(ORG, {
        from: "2026-09-01",
        to: "2026-09-30",
        filters: [],
        usageUnit: "tokens",
      }),
  ],
  ["getCostUsageUnits", () => readers.getCostUsageUnits(ORG)],
  ["getUntaggedSpend", () => readers.getUntaggedSpend(ORG, ["team"], "2026-09-01", "2026-09-30")],
  ["getShowbackSpend", () => readers.getShowbackSpend(ORG, [], "2026-09-01", "2026-09-30")],
  ["getCostCoverage", () => readers.getCostCoverage(ORG)],
  [
    "getCommitmentCoverageCells",
    () => commitmentReaders.getCommitmentCoverageCells(ORG, "2026-09-01", "2026-09-30", ["a"]),
  ],
  [
    "getAccountDataDays",
    () => commitmentReaders.getAccountDataDays(ORG, "2026-09-01", "2026-09-30", ["a"]),
  ],
  [
    "getCommitmentDeliveredTotals",
    () => commitmentReaders.getCommitmentDeliveredTotals(ORG, "2026-09-01", "2026-09-30", ["a"]),
  ],
  [
    "getUncoveredDailySpend",
    () => commitmentReaders.getUncoveredDailySpend(ORG, "2026-09-01", "2026-09-30", ["a"]),
  ],
];

beforeEach(() => {
  captured.length = 0;
  ch.setRows?.([]);
});

describe("every cost_daily reader applies the caller's scope", () => {
  it.each(READ_CALLS)("%s narrows to the scoped accounts", async (_name, call) => {
    await ctx.runWithCostVisibility(ACCOUNT_SCOPE, call);
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) expect(q).toContain("'acct-visible'");
  });

  it.each(READ_CALLS)("%s is unchanged when unrestricted", async (_name, call) => {
    await call();
    const bare = [...captured];
    captured.length = 0;
    await ctx.runWithCostVisibility(ctx.unrestrictedCostVisibility(ORG), call);
    expect(captured).toEqual(bare);
    for (const q of bare) expect(q).not.toContain("acct-visible");
  });

  it("refuses a read for another org than the one the scope was established for", async () => {
    await expect(
      ctx.runWithCostVisibility(ACCOUNT_SCOPE, () => readers.getCostTagKeys("org-2")),
    ).rejects.toThrow(/refusing to read either/);
  });
});

describe("scope SQL shape", () => {
  it("a cost-centre layer tests the showback allocation multiIf", async () => {
    await ctx.runWithCostVisibility(
      scoped([
        {
          costCentreIds: ["centre-a"],
          rules: [{ costCentreId: "centre-a", match: { tagKey: "team", tagValue: "platform" } }],
        },
      ]),
      () => readers.getCostTagKeys(ORG),
    );
    expect(captured[0]).toMatch(/multiIf\(.*'team'.*'platform'.*'centre-a'/s);
  });

  it("accounts and centres OR together; a saved filter ANDs on", async () => {
    await ctx.runWithCostVisibility(
      scoped([
        {
          accountIds: ["acct-a"],
          costCentreIds: ["centre-a"],
          rules: [{ costCentreId: "centre-a", match: { pluginId: "aws" } }],
          filters: [{ dimension: "region", op: "in", values: ["eu-west-1"] }],
        },
      ]),
      () => readers.getCostTagKeys(ORG),
    );
    expect(captured[0]).toMatch(/'acct-a'.*OR.*multiIf.*AND.*'eu-west-1'/s);
  });

  it("an empty scope and an unresolvable saved filter match nothing", async () => {
    await ctx.runWithCostVisibility(scoped([{}]), () => readers.getCostTagKeys(ORG));
    await ctx.runWithCostVisibility(scoped([{ accountIds: ["a"], unresolvable: true }]), () =>
      readers.getCostTagKeys(ORG),
    );
    for (const q of captured) expect(q).toMatch(/and 0|AND 0|\(0\)| 0\)/i);
  });

  it("layers intersect: each one is ANDed on", async () => {
    await ctx.runWithCostVisibility(
      scoped([{ accountIds: ["acct-a", "acct-b"] }, { accountIds: ["acct-b"] }]),
      () => readers.getCostTagKeys(ORG),
    );
    const q = captured[0]!;
    expect(q.indexOf("'acct-a'")).toBeGreaterThan(-1);
    expect(q.split("'acct-b'").length - 1).toBe(2);
  });

  it("network flows narrow to strictly visible accounts, and to nothing for a centre-only scope", async () => {
    const range = { from: "2026-09-01", to: "2026-09-30" };
    await ctx.runWithCostVisibility(ACCOUNT_SCOPE, () =>
      flowReaders.readNetworkFlowScopeTotals(ORG, range, {}),
    );
    expect(captured[0]).toContain("'acct-visible'");
    captured.length = 0;
    await ctx.runWithCostVisibility(scoped([{ costCentreIds: ["c"] }]), () =>
      flowReaders.readNetworkFlowScopeTotals(ORG, range, {}),
    );
    expect(captured[0]).toMatch(/ 0\)|and 0/i);
  });
});

describe("pure helpers", () => {
  it("strictlyVisibleAccountIds is null unscoped and intersects layers", () => {
    expect(ctx.strictlyVisibleAccountIds(ORG)).toBeNull();
    ctx.runWithCostVisibility(
      scoped([{ accountIds: ["a", "b"] }, { accountIds: ["b", "c"] }]),
      () => expect([...ctx.strictlyVisibleAccountIds(ORG)!]).toEqual(["b"]),
    );
    // A saved filter (or a centre-only layer) contributes no whole accounts.
    ctx.runWithCostVisibility(
      scoped([{ accountIds: ["a"], filters: [{ dimension: "service", op: "in", values: ["x"] }] }]),
      () => expect(ctx.strictlyVisibleAccountIds(ORG)!.size).toBe(0),
    );
  });

  it("scopedViewerUserId is undefined unrestricted and the owner when scoped", () => {
    expect(ctx.scopedViewerUserId(ORG)).toBeUndefined();
    ctx.runWithCostVisibility(ACCOUNT_SCOPE, () =>
      expect(ctx.scopedViewerUserId(ORG)).toBe("user-1"),
    );
  });

  it("expandCentreSubtrees includes descendants and ignores unknown ids", () => {
    const centres = [
      { id: "eng", parentId: null },
      { id: "platform", parentId: "eng" },
      { id: "sre", parentId: "platform" },
      { id: "sales", parentId: null },
    ];
    expect(expandCentreSubtrees(["eng", "ghost"], centres).sort()).toEqual([
      "eng",
      "platform",
      "sre",
    ]);
  });
});

describe("source guard", () => {
  it("only costDailyOrgCondition builds the cost_daily org predicate", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          const hits = text.match(/eq\(costDaily\.organization_id/g) ?? [];
          // The helper itself holds exactly one. `cost-reconcile.ts` is the
          // collector's write path (it reads back the keys it is about to
          // replace) and must see every row whatever context it runs in.
          const allowed =
            path.endsWith(join("clickhouse", "cost-readers.ts")) ||
            path.endsWith(join("clickhouse", "cost-reconcile.ts"))
              ? 1
              : 0;
          if (hits.length > allowed) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
