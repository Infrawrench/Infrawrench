import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIRTUAL_TAG_RULE,
  computeMetricSplitWeights,
  describeVirtualTagRule,
  normalizeVirtualTagInput,
  referencedVirtualTagKeys,
  virtualTagInputError,
  virtualTagMetricIds,
  virtualTagSplits,
  virtualTagStaticValues,
  type VirtualTagInput,
  type VirtualTagRule,
} from "../virtual-tags";

function rule(patch: Partial<VirtualTagRule>): VirtualTagRule {
  return { ...DEFAULT_VIRTUAL_TAG_RULE, ...patch };
}

function input(rules: VirtualTagRule[], patch: Partial<VirtualTagInput> = {}): VirtualTagInput {
  return normalizeVirtualTagInput({ key: "team", name: "Team", rules, ...patch });
}

describe("virtualTagInputError", () => {
  it("accepts a well-formed tag of every rule kind", () => {
    const tag = input([
      rule({ query: "provider = 'aws'", kind: "value", value: "platform" }),
      rule({
        kind: "tag",
        sources: [
          { tagKey: "env", valuePrefix: null, query: null },
          { tagKey: "Environment", valuePrefix: "az-", query: "provider = 'azure'" },
        ],
        valueTransform: "lower",
      }),
      rule({
        kind: "split",
        allocations: [
          { value: "a", percent: 60, metricId: null },
          { value: "b", percent: 40, metricId: null },
        ],
      }),
      rule({
        kind: "metric_split",
        startsOn: "2026-01-01",
        endsOn: "2026-12-31",
        allocations: [
          { value: "a", percent: null, metricId: "m1" },
          { value: "b", percent: null, metricId: "m2" },
        ],
      }),
    ]);
    expect(virtualTagInputError(tag)).toBeNull();
  });

  it("refuses bad keys, empty tags and broken filters with the rule number", () => {
    expect(virtualTagInputError(input([rule({ value: "x" })], { key: "bad key" }))).toMatch(
      /key may contain/,
    );
    expect(virtualTagInputError(input([]))).toMatch(/at least one rule/);
    expect(virtualTagInputError(input([], { defaultValue: "other" }))).toBeNull();
    expect(virtualTagInputError(input([rule({ query: "provider >", value: "x" })]))).toMatch(
      /^Rule 1: the filter does not parse/,
    );
    expect(
      virtualTagInputError(input([rule({ query: "virtual_tag['env'] = 'x'", value: "x" })])),
    ).toMatch(/cannot filter on another virtual tag/);
  });

  it("requires split percentages to sum to 100 and dates to be ordered", () => {
    const split = (a: number, b: number) =>
      rule({
        kind: "split",
        allocations: [
          { value: "a", percent: a, metricId: null },
          { value: "b", percent: b, metricId: null },
        ],
      });
    expect(virtualTagInputError(input([split(60, 30)]))).toMatch(/add up to 90/);
    expect(virtualTagInputError(input([split(33.33, 66.67)]))).toBeNull();
    expect(
      virtualTagInputError(
        input([rule({ value: "x", startsOn: "2026-05-01", endsOn: "2026-04-01" })]),
      ),
    ).toMatch(/start date is after the end date/);
  });

  it("normalisation drops fields the rule kind does not use", () => {
    const [normalized] = input([
      rule({
        kind: "value",
        value: " x ",
        allocations: [{ value: "a", percent: 100, metricId: null }],
      }),
    ]).rules;
    expect(normalized).toMatchObject({ value: "x", allocations: [], sources: [] });
  });
});

describe("helpers", () => {
  const rules = [
    rule({ kind: "value", value: "z" }),
    rule({
      kind: "metric_split",
      allocations: [
        { value: "a", percent: null, metricId: "m1" },
        { value: "b", percent: null, metricId: "m2" },
      ],
    }),
  ];

  it("knows when a tag splits and which metrics it needs", () => {
    expect(virtualTagSplits(rules)).toBe(true);
    expect(virtualTagSplits([rules[0]!])).toBe(false);
    expect(virtualTagMetricIds(rules)).toEqual(["m1", "m2"]);
    expect(virtualTagStaticValues({ rules, defaultValue: "other" })).toEqual([
      "a",
      "b",
      "other",
      "z",
    ]);
  });

  it("finds virtual tag references in filters and groupings", () => {
    expect(
      referencedVirtualTagKeys(
        [
          { dimension: "virtual_tag", op: "in", values: ["x"], tagKey: "env" },
          { dimension: "tag", op: "in", values: ["x"], tagKey: "team" },
        ],
        "virtual_tag",
        "team",
      ),
    ).toEqual(["env", "team"]);
    expect(referencedVirtualTagKeys([], "service")).toEqual([]);
  });

  it("describes a rule in one line", () => {
    expect(describeVirtualTagRule(rule({ query: "provider = 'aws'", value: "p" }))).toBe(
      "provider = 'aws' → 'p'",
    );
    expect(describeVirtualTagRule(rules[1]!, (id) => id.toUpperCase())).toBe(
      "everything → 'a' by M1 / 'b' by M2",
    );
  });
});

describe("computeMetricSplitWeights", () => {
  it("weights each day by that day's values", () => {
    const result = computeMetricSplitWeights(
      [new Map([["2026-01-01", 30]]), new Map([["2026-01-01", 10]])],
      "2026-01-01",
      "2026-01-01",
    );
    expect(result.weights).toEqual([[0.75, 0.25]]);
    expect(result.fallbackDays).toBe(0);
  });

  it("carries the last good day forward, including from before the range", () => {
    const result = computeMetricSplitWeights(
      [
        new Map([
          ["2025-12-30", 1],
          ["2026-01-02", 1],
        ]),
        new Map([
          ["2025-12-30", 3],
          ["2026-01-02", 1],
        ]),
      ],
      "2026-01-01",
      "2026-01-03",
    );
    expect(result.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(result.weights).toEqual([
      [0.25, 0.75],
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(result.fallbackDays).toBe(2);
  });

  it("splits evenly when there is nothing to carry, and never sums past one", () => {
    const result = computeMetricSplitWeights(
      [new Map(), new Map([["2026-01-01", 5]]), new Map()],
      "2026-01-01",
      "2026-01-02",
    );
    for (const row of result.weights) {
      expect(row.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 10);
    }
    expect(result.fallbackDays).toBe(2);
  });
});
