import { describe, expect, it } from "vitest";
import {
  buildShowbackCentres,
  complianceScore,
  COST_CENTRE_LIMITS,
  costCentreDepths,
  costCentreMoveBlocker,
  costCentrePaths,
  describeTagViolations,
  extractRecordTags,
  fieldsDeclareTagField,
  orderAllocationRules,
  showbackCentreHasChildren,
  taggedSpendPercent,
  tagPolicyViolations,
  type AllocationRule,
  type CostCentre,
} from "../tag-policy";

describe("extractRecordTags", () => {
  it("returns null when no tag-shaped field exists (cannot be tagged)", () => {
    expect(extractRecordTags({ name: "web-1", region: "fra1" })).toBeNull();
    expect(extractRecordTags(null)).toBeNull();
    expect(extractRecordTags(undefined)).toBeNull();
  });

  it("reads a plain object map (values coerced to strings)", () => {
    expect(extractRecordTags({ tags: { owner: "astrid", replicas: 3, ha: true } })).toEqual({
      owner: "astrid",
      replicas: "3",
      ha: "true",
    });
  });

  it("matches tags/labels case-insensitively and merges both", () => {
    expect(extractRecordTags({ Tags: { owner: "a" }, labels: { env: "prod" } })).toEqual({
      owner: "a",
      env: "prod",
    });
  });

  it("parses a comma-separated k=v string (the string-list convention)", () => {
    expect(extractRecordTags({ tags: "owner=astrid, env=prod, standalone" })).toEqual({
      owner: "astrid",
      env: "prod",
      standalone: "",
    });
  });

  it("splits on whichever of = or : appears first so values may contain the other", () => {
    expect(extractRecordTags({ tags: "url=https://example.com, note:a=b" })).toEqual({
      url: "https://example.com",
      note: "a=b",
    });
  });

  it("parses a JSON-encoded map or array", () => {
    expect(extractRecordTags({ tags: '{"owner":"astrid"}' })).toEqual({ owner: "astrid" });
    expect(extractRecordTags({ tags: '[{"key":"env","value":"prod"}]' })).toEqual({ env: "prod" });
    expect(extractRecordTags({ tags: '["owner=astrid","env:prod"]' })).toEqual({
      owner: "astrid",
      env: "prod",
    });
  });

  it("treats a present-but-empty tag field as taggable and untagged", () => {
    expect(extractRecordTags({ tags: "" })).toEqual({});
    expect(extractRecordTags({ tags: "not json {" })).toEqual({ "not json {": "" });
  });
});

describe("tagPolicyViolations", () => {
  const required = [{ key: "owner" }, { key: "env", allowedValues: ["prod", "staging"] }];

  it("passes when every key is present with an allowed value", () => {
    expect(tagPolicyViolations({ Owner: "astrid", env: "prod" }, required)).toEqual([]);
  });

  it("flags missing keys and empty values", () => {
    const violations = tagPolicyViolations({ env: "" }, required);
    expect(violations).toEqual([
      { key: "owner", reason: "missing" },
      { key: "env", reason: "missing" },
    ]);
    expect(describeTagViolations(violations)).toContain('missing required tag "owner"');
  });

  it("flags disallowed values (values compared exactly, keys case-insensitively)", () => {
    expect(tagPolicyViolations({ owner: "a", ENV: "dev" }, required)).toEqual([
      { key: "env", reason: "value_not_allowed", value: "dev", allowedValues: ["prod", "staging"] },
    ]);
  });
});

describe("fieldsDeclareTagField", () => {
  it("recognises tags/labels keys regardless of case", () => {
    expect(fieldsDeclareTagField([{ key: "name" }, { key: "Tags" }])).toBe(true);
    expect(fieldsDeclareTagField([{ key: "labels" }])).toBe(true);
    expect(fieldsDeclareTagField([{ key: "name" }])).toBe(false);
  });
});

describe("scores", () => {
  it("complianceScore rounds and returns null when nothing is evaluable", () => {
    expect(complianceScore(2, 3)).toBe(67);
    expect(complianceScore(0, 0)).toBeNull();
  });

  it("taggedSpendPercent is null with no spend and clamps to 0-100", () => {
    expect(taggedSpendPercent({ totals: {}, untaggedTotals: {} }, "USD")).toBeNull();
    expect(taggedSpendPercent({ totals: { USD: 100 }, untaggedTotals: { USD: 25 } }, "USD")).toBe(
      75,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Hierarchical cost centres
 * ------------------------------------------------------------------ */

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

function rule(
  id: string,
  costCentreId: string,
  priority: number,
  createdAt = "2026-01-01T00:00:00.000Z",
): AllocationRule {
  return { id, costCentreId, priority, match: {}, createdAt, updatedAt: createdAt };
}

/** Engineering → Platform → Search, plus a sibling Data under Engineering. */
const TREE: CostCentre[] = [
  centre("eng", "Engineering"),
  centre("plat", "Platform", "eng"),
  centre("search", "Search", "plat"),
  centre("data", "Data", "eng"),
  centre("growth", "Growth"),
];

/** The pre-nesting world: three roots, no parents anywhere. */
const FLAT: CostCentre[] = [centre("a", "Platform"), centre("b", "Data"), centre("c", "Growth")];

describe("costCentreDepths", () => {
  it("is 0 everywhere for a flat org", () => {
    expect([...costCentreDepths(FLAT).values()]).toEqual([0, 0, 0]);
  });

  it("counts hops to the root", () => {
    const depths = costCentreDepths(TREE);
    expect(depths.get("eng")).toBe(0);
    expect(depths.get("plat")).toBe(1);
    expect(depths.get("search")).toBe(2);
    expect(depths.get("growth")).toBe(0);
  });

  it("treats a missing, self- or cyclic parent as a root rather than looping", () => {
    const orphan = [centre("x", "X", "gone"), centre("self", "Self", "self")];
    expect(costCentreDepths(orphan).get("x")).toBe(0);
    expect(costCentreDepths(orphan).get("self")).toBe(0);

    const cycle = [centre("p", "P", "q"), centre("q", "Q", "p")];
    const depths = costCentreDepths(cycle);
    expect(depths.get("p")).toBeTypeOf("number");
    expect(depths.get("q")).toBeTypeOf("number");
  });
});

describe("costCentrePaths", () => {
  it("is depth-first with name-sorted siblings and a full path per row", () => {
    expect(costCentrePaths(TREE).map((r) => `${r.depth}:${r.path}`)).toEqual([
      "0:Engineering",
      "1:Engineering → Data",
      "1:Engineering → Platform",
      "2:Engineering → Platform → Search",
      "0:Growth",
    ]);
  });

  it("is exactly the old name-sorted flat list for a flat org", () => {
    expect(costCentrePaths(FLAT).map((r) => r.name)).toEqual(["Data", "Growth", "Platform"]);
    expect(costCentrePaths(FLAT).every((r) => r.depth === 0)).toBe(true);
  });

  it("surfaces a centre stuck in a cycle rather than dropping it", () => {
    const cycle = [centre("p", "P", "q"), centre("q", "Q", "p"), centre("r", "R")];
    expect(
      costCentrePaths(cycle)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["p", "q", "r"]);
  });
});

describe("costCentreMoveBlocker", () => {
  it("allows a plain move and a promotion to the top level", () => {
    expect(costCentreMoveBlocker(TREE, "data", "growth")).toBeNull();
    expect(costCentreMoveBlocker(TREE, "search", null)).toBeNull();
  });

  it("rejects an unknown parent", () => {
    expect(costCentreMoveBlocker(TREE, "data", "nope")).toMatch(/Unknown parent/);
  });

  it("rejects a move into itself or its own descendants (the only cycle)", () => {
    expect(costCentreMoveBlocker(TREE, "eng", "eng")).toMatch(/inside itself/);
    expect(costCentreMoveBlocker(TREE, "eng", "plat")).toMatch(/inside itself/);
    expect(costCentreMoveBlocker(TREE, "eng", "search")).toMatch(/inside itself/);
  });

  it("measures the depth cap over the whole subtree being moved, not just the node", () => {
    // Platform carries Search with it: parent(2) + height(2) = 4, exactly the cap.
    const deep = [...TREE, centre("deep", "Deep", "search")];
    expect(costCentreMoveBlocker(TREE, "plat", "data")).toBeNull();

    // Now Platform is 3 levels tall (Platform → Search → Deep). Under Data
    // (itself at depth 1) that would be 5 — the *leaf* would fit, the subtree
    // does not, which is exactly the case a node-only check would wave through.
    expect(costCentreMoveBlocker(deep, "deep", "data")).toBeNull();
    expect(costCentreMoveBlocker(deep, "plat", "data")).toMatch(
      new RegExp(`at most ${COST_CENTRE_LIMITS.maxDepth} levels`),
    );
  });

  it("never blocks anything in a flat org", () => {
    for (const c of FLAT) expect(costCentreMoveBlocker(FLAT, c.id, null)).toBeNull();
  });
});

describe("orderAllocationRules", () => {
  it("is unchanged for a flat org: priority, then creation time", () => {
    const rules = [
      rule("r3", "a", 5, "2026-01-03T00:00:00.000Z"),
      rule("r1", "b", 0, "2026-01-01T00:00:00.000Z"),
      rule("r2", "c", 5, "2026-01-02T00:00:00.000Z"),
    ];
    expect(orderAllocationRules(rules, FLAT).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps lower priority first even when a child rule sits below a parent rule", () => {
    const parentFirst = rule("parent", "eng", 0);
    const childLater = rule("child", "search", 10);
    expect(orderAllocationRules([childLater, parentFirst], TREE).map((r) => r.id)).toEqual([
      "parent",
      "child",
    ]);
  });

  it("breaks a priority tie in favour of the deeper centre, so a parent catch-all does not steal", () => {
    const parentRule = rule("parent", "eng", 0, "2026-01-01T00:00:00.000Z");
    const childRule = rule("child", "search", 0, "2026-01-02T00:00:00.000Z");
    // Creation time would have put the parent first; depth outranks it.
    expect(orderAllocationRules([parentRule, childRule], TREE).map((r) => r.id)).toEqual([
      "child",
      "parent",
    ]);
  });
});

describe("buildShowbackCentres", () => {
  const totals = (map: Record<string, Record<string, number>>) => new Map(Object.entries(map));

  it("reports own and subtree amounts separately, and rolls up through every level", () => {
    const out = buildShowbackCentres(
      TREE,
      totals({
        eng: { USD: 100 },
        plat: { USD: 200 },
        search: { USD: 40 },
        data: { USD: 60 },
      }),
    );
    const by = new Map(out.map((c) => [c.costCentreId, c]));

    expect(by.get("search")!.totals).toEqual({ USD: 40 });
    expect(by.get("search")!.subtreeTotals).toEqual({ USD: 40 });
    expect(by.get("plat")!.totals).toEqual({ USD: 200 });
    expect(by.get("plat")!.subtreeTotals).toEqual({ USD: 240 });
    // 100 own + 240 Platform subtree + 60 Data.
    expect(by.get("eng")!.totals).toEqual({ USD: 100 });
    expect(by.get("eng")!.subtreeTotals).toEqual({ USD: 400 });
    // A centre with no spend at all still appears, at zero.
    expect(by.get("growth")!.totals).toEqual({});
    expect(by.get("growth")!.subtreeTotals).toEqual({});
  });

  it("never double counts: own totals across the whole list sum to the org total", () => {
    const spend = { eng: { USD: 100 }, plat: { USD: 200 }, search: { USD: 40 }, data: { USD: 60 } };
    const out = buildShowbackCentres(TREE, totals(spend), { USD: 7 });
    const sumOwn = out.reduce((acc, c) => acc + (c.totals["USD"] ?? 0), 0);
    expect(sumOwn).toBe(100 + 200 + 40 + 60 + 7);
  });

  it("rolls up per currency independently", () => {
    const out = buildShowbackCentres(
      TREE,
      totals({ plat: { USD: 10, EUR: 5 }, search: { EUR: 2, SEK: 9 } }),
    );
    const plat = out.find((c) => c.costCentreId === "plat")!;
    expect(plat.totals).toEqual({ USD: 10, EUR: 5 });
    expect(plat.subtreeTotals).toEqual({ USD: 10, EUR: 7, SEK: 9 });
  });

  it("emits depth-first with parent ids and depths for indentation", () => {
    const out = buildShowbackCentres(TREE, totals({}));
    expect(out.map((c) => [c.name, c.depth, c.parentId])).toEqual([
      ["Engineering", 0, null],
      ["Data", 1, "eng"],
      ["Platform", 1, "eng"],
      ["Search", 2, "plat"],
      ["Growth", 0, null],
    ]);
  });

  it("keeps Unallocated a first-class row, last, never nested under a parent", () => {
    const out = buildShowbackCentres(TREE, totals({ eng: { USD: 1 } }), { USD: 33 });
    const last = out[out.length - 1]!;
    expect(last.costCentreId).toBeNull();
    expect(last.name).toBe("Unallocated");
    expect(last.parentId).toBeNull();
    expect(last.depth).toBe(0);
    expect(last.totals).toEqual({ USD: 33 });
    expect(last.subtreeTotals).toEqual({ USD: 33 });
  });

  it("omits Unallocated only when there is genuinely none", () => {
    expect(buildShowbackCentres(TREE, totals({}), {}).some((c) => c.costCentreId === null)).toBe(
      false,
    );
    expect(
      buildShowbackCentres(TREE, totals({}), undefined).some((c) => c.costCentreId === null),
    ).toBe(false);
  });

  it("leaves an existing flat org exactly as it was: subtree equals own, all at depth 0", () => {
    const out = buildShowbackCentres(FLAT, totals({ a: { USD: 10 }, b: { USD: 20 } }), { USD: 5 });
    expect(out.map((c) => c.name)).toEqual(["Data", "Growth", "Platform", "Unallocated"]);
    for (const entry of out) {
      expect(entry.depth).toBe(0);
      expect(entry.parentId).toBeNull();
      expect(entry.subtreeTotals).toEqual(entry.totals);
    }
  });

  it("surfaces a cyclic or orphaned centre as a root instead of losing its spend", () => {
    const broken = [centre("p", "P", "q"), centre("q", "Q", "p"), centre("x", "X", "gone")];
    const out = buildShowbackCentres(
      broken,
      totals({ p: { USD: 1 }, q: { USD: 2 }, x: { USD: 3 } }),
    );
    expect(out.map((c) => c.costCentreId).sort()).toEqual(["p", "q", "x"]);
    expect(out.reduce((acc, c) => acc + (c.totals["USD"] ?? 0), 0)).toBe(6);
  });

  describe("showbackCentreHasChildren", () => {
    it("is false for two unrelated root centres, not true from their shared null parentId", () => {
      const out = buildShowbackCentres(FLAT, totals({}));
      for (const row of out) {
        expect(showbackCentreHasChildren(out, row)).toBe(false);
      }
    });

    it("is false for the synthetic Unallocated row even though every root's parentId is also null", () => {
      // FLAT is all roots, so their parentId is null — the same null
      // Unallocated uses for its own costCentreId. Without the guard this
      // reads every root as Unallocated's child.
      const out = buildShowbackCentres(FLAT, totals({}), { USD: 33 });
      const unallocated = out.find((c) => c.costCentreId === null)!;
      expect(showbackCentreHasChildren(out, unallocated)).toBe(false);
    });

    it("is true for a centre with a genuine child, false for a leaf", () => {
      const out = buildShowbackCentres(TREE, totals({}));
      const eng = out.find((c) => c.costCentreId === "eng")!;
      const search = out.find((c) => c.costCentreId === "search")!;
      expect(showbackCentreHasChildren(out, eng)).toBe(true);
      expect(showbackCentreHasChildren(out, search)).toBe(false);
    });
  });
});
