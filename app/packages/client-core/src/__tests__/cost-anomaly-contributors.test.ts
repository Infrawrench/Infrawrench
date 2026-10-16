import { describe, expect, it } from "vitest";
import {
  costAnomalyContributorFilters,
  costAnomalyContributorGraphConfig,
  costAnomalyContributorName,
  costAnomalyContributorPhrase,
  costAnomalyDriver,
  costAnomalyHeadlineContributors,
  costAnomalyLeadContributor,
  describeCostAnomalyContributor,
  foldCostAnomalyContributors,
  formatContributorShare,
  splitCostAnomalyDriverHint,
  type CostAnomalyContributor,
} from "../cost-anomaly-contributors";

function c(partial: Partial<CostAnomalyContributor>): CostAnomalyContributor {
  return {
    facet: "resource",
    key: "i-1",
    tagKey: null,
    label: "i-1",
    accountId: "acc_a",
    resource: null,
    actualCents: 10_000,
    baselineCents: 1_000,
    deltaCents: 9_000,
    share: 0.5,
    ...partial,
  };
}

describe("costAnomalyDriver", () => {
  it("picks the resource with the largest positive delta", () => {
    const contributors = [
      c({ key: "i-small", deltaCents: 100 }),
      c({ facet: "account", key: "acc_a", deltaCents: 50_000 }),
      c({ key: "i-big", deltaCents: 9_000 }),
    ];
    expect(costAnomalyDriver({ contributors })?.key).toBe("i-big");
  });

  it("needs a real share of the rise to be called the driver", () => {
    expect(costAnomalyDriver({ contributors: [c({ share: 0.12 })] })).toBeNull();
    expect(costAnomalyDriver({ contributors: [c({ share: null })] })).toBeNull();
    expect(costAnomalyDriver({ contributors: [c({ share: 0.2 })] })?.key).toBe("i-1");
  });

  it("is null when no resource rose, and never the folded other row", () => {
    expect(costAnomalyDriver({ contributors: [c({ deltaCents: -5 })] })).toBeNull();
    expect(
      costAnomalyDriver({ contributors: [c({ other: true, key: "", deltaCents: 9_000 })] }),
    ).toBeNull();
    expect(costAnomalyDriver({})).toBeNull();
  });
});

describe("costAnomalyLeadContributor", () => {
  it("falls back to the most specific facet that rose when there is no resource", () => {
    const contributors = [
      c({ facet: "region", key: "us-east-1", deltaCents: 7_000 }),
      c({ facet: "account", key: "acc_b", deltaCents: 3_000 }),
    ];
    expect(costAnomalyLeadContributor({ contributors })?.facet).toBe("account");
  });
});

describe("formatting", () => {
  it("renders shares, names and lines", () => {
    expect(formatContributorShare(0.638)).toBe("64%");
    expect(formatContributorShare(0.001)).toBe("<1%");
    expect(formatContributorShare(null)).toBeNull();
    expect(formatContributorShare(-0.2)).toBeNull();
    expect(costAnomalyContributorName(c({ key: "i-1", label: "web-1" }))).toBe("web-1 (i-1)");
    expect(costAnomalyContributorPhrase(c({ facet: "account", key: "acc_1", label: "Prod" }))).toBe(
      "account Prod (acc_1)",
    );
    expect(costAnomalyContributorName(c({ facet: "tag", tagKey: "team", key: "" }))).toBe(
      "team=(untagged)",
    );
    expect(
      describeCostAnomalyContributor(
        c({ key: "i-1", label: "web-1", deltaCents: 42_000, baselineCents: 1_200, share: 0.64 }),
        "USD",
      ),
    ).toBe("resource web-1 (i-1): +$420 vs a $12/day baseline, 64% of the rise");
  });
});

describe("foldCostAnomalyContributors", () => {
  const contributors = [
    c({ key: "i-visible", accountId: "acc_a", deltaCents: 5_000, share: 0.5 }),
    c({ key: "i-hidden", accountId: "acc_b", deltaCents: 3_000, share: 0.3 }),
    c({ key: "i-hidden-2", accountId: null, deltaCents: 1_000, share: 0.1 }),
    c({ facet: "region", key: "us-east-1", accountId: null, deltaCents: 9_000, share: 0.9 }),
  ];

  it("returns everything for an unrestricted viewer", () => {
    expect(foldCostAnomalyContributors(contributors, null)).toEqual(contributors);
  });

  it("keeps visible accounts' rows and folds the rest into one other row per facet", () => {
    const folded = foldCostAnomalyContributors(contributors, new Set(["acc_a"]));
    expect(folded.map((r) => [r.facet, r.key, r.other ?? false])).toEqual([
      ["resource", "i-visible", false],
      ["resource", "", true],
      ["region", "", true],
    ]);
    const other = folded[1]!;
    expect(other.deltaCents).toBe(4_000);
    expect(other.share).toBeCloseTo(0.4);
    expect(other.label).toBe("Other");
    // Nothing about what was folded leaks through.
    expect(JSON.stringify(folded)).not.toContain("i-hidden");
    expect(JSON.stringify(folded)).not.toContain("us-east-1");
  });
});

describe("costAnomalyHeadlineContributors", () => {
  it("leads with the driver, then one qualifying riser per other facet", () => {
    const contributors = [
      c({ key: "i-1", deltaCents: 9_000, share: 0.6 }),
      c({ key: "i-2", deltaCents: 4_000, share: 0.3 }),
      c({ facet: "account", key: "acc_a", deltaCents: 15_000, share: 1 }),
      c({ facet: "region", key: "us-east-1", deltaCents: 1_000, share: 0.07 }),
      c({ facet: "tag", tagKey: "team", key: "data", deltaCents: 8_000, share: 0.55 }),
    ];
    expect(
      costAnomalyHeadlineContributors({ contributors }).map((x) => `${x.facet}:${x.key}`),
    ).toEqual(["resource:i-1", "account:acc_a", "tag:data"]);
    expect(costAnomalyHeadlineContributors({ contributors: [] })).toEqual([]);
  });
});

describe("splitCostAnomalyDriverHint", () => {
  const driver = c({ key: "i-1", label: "web-1", share: 0.7 });

  it("splits off the driver's own sentence and what the timeline saw happen to it", () => {
    expect(
      splitCostAnomalyDriverHint({
        contributors: [driver],
        hints: [
          "resource web-1 (i-1) carried 70% of the rise (+$90), and appeared in the window",
          "Astrid ran a deployment",
        ],
      }),
    ).toEqual({ driverEvent: "appeared", otherHints: ["Astrid ran a deployment"] });
  });

  it("leaves the hints alone when there is no driver, or the first hint is not about it", () => {
    const hints = ["account Prod (acc_a) carried 90% of the rise (+$90)", "x"];
    expect(
      splitCostAnomalyDriverHint({
        contributors: [c({ facet: "account", key: "acc_a", label: "Prod", share: 0.9 })],
        hints,
      }),
    ).toEqual({ driverEvent: null, otherHints: hints });
    expect(splitCostAnomalyDriverHint({ contributors: [driver], hints: ["x"] })).toEqual({
      driverEvent: null,
      otherHints: ["x"],
    });
  });
});

describe("costAnomalyContributorGraphConfig", () => {
  const anomaly = { day: "2026-10-01", dimension: "provider" as const, dimensionKey: "aws" };

  it("draws the contributor daily, four weeks before the day and a week after", () => {
    const config = costAnomalyContributorGraphConfig(anomaly, c({ key: "i-1" }), "2026-10-16");
    expect(config).toMatchObject({
      binning: "daily",
      groupBy: "none",
      dateRange: { kind: "absolute", from: "2026-09-04", to: "2026-10-08" },
      filters: [
        { dimension: "provider", op: "in", values: ["aws"] },
        { dimension: "resource", op: "in", values: ["i-1"] },
      ],
    });
  });

  it("stops at today, and has no chart for a usage unit", () => {
    expect(
      costAnomalyContributorGraphConfig(anomaly, c({ key: "i-1" }), "2026-10-03")?.dateRange,
    ).toEqual({ kind: "absolute", from: "2026-09-04", to: "2026-10-03" });
    expect(costAnomalyContributorGraphConfig(anomaly, c({ facet: "usage_unit" }))).toBeNull();
  });
});

describe("costAnomalyContributorFilters", () => {
  const anomaly = { dimension: "service" as const, dimensionKey: "Amazon EC2" };

  it("narrows the anomaly's own scope to the contributor", () => {
    expect(costAnomalyContributorFilters(anomaly, c({ key: "i-1" }))).toEqual([
      { dimension: "service", op: "in", values: ["Amazon EC2"] },
      { dimension: "resource", op: "in", values: ["i-1"] },
    ]);
    expect(
      costAnomalyContributorFilters(anomaly, c({ facet: "tag", tagKey: "team", key: "data" })),
    ).toEqual([
      { dimension: "service", op: "in", values: ["Amazon EC2"] },
      { dimension: "tag", op: "in", values: ["data"], tagKey: "team" },
    ]);
  });

  it("has no filter for a usage unit or the folded row", () => {
    expect(costAnomalyContributorFilters(anomaly, c({ facet: "usage_unit", key: "Hrs" }))).toBe(
      null,
    );
    expect(costAnomalyContributorFilters(anomaly, c({ other: true }))).toBeNull();
  });
});
