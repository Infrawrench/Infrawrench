import { describe, expect, it } from "vitest";

import {
  ORG_SCORECARD_PILLARS,
  ORG_SCORECARD_WEIGHTS,
  combineOrgScorecardPillars,
  findingScore,
  orgScorecardBiggestDrag,
  orgScorecardGrade,
  orgScorecardTrendDelta,
  percentClean,
  serviceStandardsReading,
  type OrgScorecardPillar,
  type OrgScorecardPillarId,
} from "../org-scorecard";
import { defaultScorecardInput, type Scorecard, type ScorecardResult } from "../scorecards";

function pillar(
  id: OrgScorecardPillarId,
  score: number | null,
  weight = ORG_SCORECARD_WEIGHTS[id],
): OrgScorecardPillar {
  return {
    id,
    score,
    weight,
    headline: "",
    unassessedReason: score === null ? "nothing to measure" : null,
    nextStep: null,
    facts: [],
  };
}

describe("ORG_SCORECARD_WEIGHTS", () => {
  it("has seven pillars that sum to 100", () => {
    expect(ORG_SCORECARD_PILLARS).toHaveLength(7);
    const total = ORG_SCORECARD_PILLARS.reduce((n, id) => n + ORG_SCORECARD_WEIGHTS[id], 0);
    expect(total).toBe(100);
  });

  it("lists the pillars heaviest first", () => {
    const weights = ORG_SCORECARD_PILLARS.map((id) => ORG_SCORECARD_WEIGHTS[id]);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });
});

describe("orgScorecardGrade", () => {
  it("maps each band", () => {
    expect(orgScorecardGrade(100)).toBe("A");
    expect(orgScorecardGrade(90)).toBe("A");
    expect(orgScorecardGrade(89)).toBe("B");
    expect(orgScorecardGrade(80)).toBe("B");
    expect(orgScorecardGrade(65)).toBe("C");
    expect(orgScorecardGrade(50)).toBe("D");
    expect(orgScorecardGrade(49)).toBe("F");
    expect(orgScorecardGrade(0)).toBe("F");
  });
});

describe("combineOrgScorecardPillars", () => {
  it("is the weighted mean when every pillar is assessed", () => {
    const combined = combineOrgScorecardPillars(ORG_SCORECARD_PILLARS.map((id) => pillar(id, 100)));
    expect(combined.score).toBe(100);
    expect(combined.grade).toBe("A");
    expect(combined.assessedWeight).toBe(100);
  });

  it("weights a heavy pillar more than a light one", () => {
    // Posture is 25, ownership is 5: the same failure must not cost the same.
    const postureBad = combineOrgScorecardPillars([pillar("posture", 0), pillar("ownership", 100)]);
    const ownershipBad = combineOrgScorecardPillars([
      pillar("posture", 100),
      pillar("ownership", 0),
    ]);
    expect(postureBad.score).toBeLessThan(ownershipBad.score!);
  });

  it("excludes an unassessed pillar instead of scoring it zero", () => {
    // An org with no quota-reporting provider has no headroom score, not a
    // headroom score of nought.
    const combined = combineOrgScorecardPillars([pillar("posture", 80), pillar("headroom", null)]);
    expect(combined.score).toBe(80);
    expect(combined.assessedWeight).toBe(ORG_SCORECARD_WEIGHTS.posture);
  });

  it("renormalizes, so gaining a pillar cannot look like a regression", () => {
    const before = combineOrgScorecardPillars([pillar("posture", 70), pillar("services", null)]);
    const after = combineOrgScorecardPillars([pillar("posture", 70), pillar("services", 100)]);
    expect(before.score).toBe(70);
    expect(after.score).toBeGreaterThan(70);
  });

  it("returns null rather than F when nothing could be assessed", () => {
    const combined = combineOrgScorecardPillars([
      pillar("posture", null),
      pillar("headroom", null),
    ]);
    expect(combined.score).toBeNull();
    expect(combined.grade).toBeNull();
    expect(combined.assessedWeight).toBe(0);
  });

  it("returns null for an empty pillar list", () => {
    expect(combineOrgScorecardPillars([]).score).toBeNull();
  });
});

describe("percentClean", () => {
  it("is the clean fraction as a whole percentage", () => {
    expect(percentClean(9, 10)).toBe(90);
    expect(percentClean(1, 3)).toBe(33);
  });

  it("returns null for an empty population rather than a perfect score", () => {
    expect(percentClean(0, 0)).toBeNull();
  });

  it("clamps rather than exceeding 100", () => {
    expect(percentClean(11, 10)).toBe(100);
  });
});

describe("findingScore", () => {
  const clean = { critical: 0, high: 0, medium: 0, low: 0, population: 100 };

  it("is 100 with no findings", () => {
    expect(findingScore(clean)).toBe(100);
  });

  it("returns null for an empty population", () => {
    expect(findingScore({ ...clean, population: 0 })).toBeNull();
  });

  it("costs a critical more than several lows", () => {
    expect(findingScore({ ...clean, critical: 1 })!).toBeLessThan(
      findingScore({ ...clean, low: 4 })!,
    );
  });

  it("reads better across a larger population", () => {
    const small = findingScore({ ...clean, high: 10, population: 20 })!;
    const large = findingScore({ ...clean, high: 10, population: 5000 })!;
    expect(large).toBeGreaterThan(small);
  });

  it("does not let a large org hide a pile of criticals", () => {
    expect(findingScore({ ...clean, critical: 30, population: 100000 })).toBe(0);
  });

  it("does not score a five-resource org out of existence for one finding", () => {
    expect(findingScore({ ...clean, medium: 1, population: 5 })).toBeGreaterThan(75);
  });

  it("never leaves the 0-100 range", () => {
    expect(findingScore({ ...clean, critical: 1000, population: 10 })).toBe(0);
  });
});

describe("orgScorecardBiggestDrag", () => {
  it("weights the loss rather than picking the lowest score", () => {
    const worst = orgScorecardBiggestDrag([pillar("ownership", 40), pillar("posture", 70)]);
    expect(worst?.id).toBe("posture");
  });

  it("ignores unassessed pillars", () => {
    expect(orgScorecardBiggestDrag([pillar("posture", null), pillar("ownership", 40)])?.id).toBe(
      "ownership",
    );
  });

  it("is null when everything is perfect", () => {
    expect(orgScorecardBiggestDrag([pillar("posture", 100)])).toBeNull();
  });
});

describe("orgScorecardTrendDelta", () => {
  const point = (day: string, score: number) => ({
    day,
    score,
    grade: orgScorecardGrade(score),
    pillars: {},
  });

  it("compares against the oldest stored reading", () => {
    expect(orgScorecardTrendDelta([point("2026-08-01", 60), point("2026-08-10", 70)], 75)).toBe(15);
  });

  it("is null with no history or no current score", () => {
    expect(orgScorecardTrendDelta([], 75)).toBeNull();
    expect(orgScorecardTrendDelta([point("2026-08-01", 60)], null)).toBeNull();
  });
});

describe("serviceStandardsReading", () => {
  const NOW = Date.parse("2026-10-12T09:00:00.000Z");
  const card = (id: string, overrides: Partial<Scorecard> = {}): Scorecard => ({
    ...defaultScorecardInput(),
    id,
    name: id,
    isDefault: false,
    lastEvaluatedAt: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  });
  const service = (id: string, tier: 1 | 2 | 3 | 4 | null = null) => ({
    id,
    name: id,
    slug: id,
    tier,
    ownerTeam: null,
  });
  const result = (
    scorecardId: string,
    serviceId: string,
    score: number | null,
  ): ScorecardResult => ({
    scorecardId,
    scorecardName: scorecardId,
    serviceId,
    score,
    level: null,
    levelName: null,
    checks: [],
    evaluatedAt: new Date(NOW).toISOString(),
  });

  it("is the mean of the scored pairs", () => {
    const reading = serviceStandardsReading(
      {
        scorecards: [card("prod")],
        services: [service("a"), service("b")],
        results: [result("prod", "a", 80), result("prod", "b", 60)],
      },
      NOW,
    );
    expect(reading.score).toBe(70);
    expect(reading.scored).toBe(2);
    expect(reading.worst).toEqual({ serviceName: "b", scorecardName: "prod", score: 60 });
  });

  it("is null rather than zero when nothing is scored", () => {
    // No services, or services whose every check is not applicable: excluded
    // from the org grade, never counted against it.
    expect(
      serviceStandardsReading({ scorecards: [card("prod")], services: [], results: [] }, NOW).score,
    ).toBeNull();
    expect(
      serviceStandardsReading(
        {
          scorecards: [card("prod")],
          services: [service("a")],
          results: [result("prod", "a", null)],
        },
        NOW,
      ).score,
    ).toBeNull();
  });

  it("counts only the pairs a scorecard applies to by tier", () => {
    // A stored result for a tier the scorecard no longer covers is not part
    // of the current bar, the same rule the matrix and the evidence follow.
    const reading = serviceStandardsReading(
      {
        scorecards: [card("tier1", { applicableTiers: [1] })],
        services: [service("critical", 1), service("internal", 3)],
        results: [result("tier1", "critical", 90), result("tier1", "internal", 10)],
      },
      NOW,
    );
    expect(reading.score).toBe(90);
    expect(reading.pairs).toBe(1);
  });

  it("ignores disabled scorecards", () => {
    const reading = serviceStandardsReading(
      {
        scorecards: [card("off", { enabled: false })],
        services: [service("a")],
        results: [result("off", "a", 20)],
      },
      NOW,
    );
    expect(reading.score).toBeNull();
  });
});
