import { describe, expect, it } from "vitest";

import {
  SCORECARD_WEIGHTS,
  biggestDrag,
  combinePillars,
  findingScore,
  percentClean,
  scoreToGrade,
  trendDelta,
  type ScorecardPillar,
  type ScorecardPillarId,
} from "../scorecard";

function pillar(
  id: ScorecardPillarId,
  score: number | null,
  weight = SCORECARD_WEIGHTS[id],
): ScorecardPillar {
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

describe("scoreToGrade", () => {
  it("maps each band", () => {
    expect(scoreToGrade(100)).toBe("A");
    expect(scoreToGrade(90)).toBe("A");
    expect(scoreToGrade(89)).toBe("B");
    expect(scoreToGrade(80)).toBe("B");
    expect(scoreToGrade(65)).toBe("C");
    expect(scoreToGrade(50)).toBe("D");
    expect(scoreToGrade(49)).toBe("F");
    expect(scoreToGrade(0)).toBe("F");
  });
});

describe("combinePillars", () => {
  it("is the weighted mean when every pillar is assessed", () => {
    const combined = combinePillars([
      pillar("security", 100),
      pillar("recoverability", 100),
      pillar("deadlines", 100),
      pillar("headroom", 100),
      pillar("access", 100),
      pillar("ownership", 100),
    ]);
    expect(combined.score).toBe(100);
    expect(combined.grade).toBe("A");
    expect(combined.assessedWeight).toBe(100);
  });

  it("weights a heavy pillar more than a light one", () => {
    // Security is 30, ownership is 5: the same failure must not cost the same.
    const securityBad = combinePillars([pillar("security", 0), pillar("ownership", 100)]);
    const ownershipBad = combinePillars([pillar("security", 100), pillar("ownership", 0)]);
    expect(securityBad.score).toBeLessThan(ownershipBad.score!);
  });

  it("excludes an unassessed pillar instead of scoring it zero", () => {
    // The whole point: an org with no quota-reporting provider has no headroom
    // score, not a headroom score of nought.
    const withUnassessed = combinePillars([pillar("security", 80), pillar("headroom", null)]);
    expect(withUnassessed.score).toBe(80);
    expect(withUnassessed.assessedWeight).toBe(SCORECARD_WEIGHTS.security);
  });

  it("renormalizes, so gaining a pillar cannot look like a regression", () => {
    // Yesterday: security only. Today: security plus a perfect new pillar.
    const before = combinePillars([pillar("security", 70), pillar("headroom", null)]);
    const after = combinePillars([pillar("security", 70), pillar("headroom", 100)]);
    expect(before.score).toBe(70);
    expect(after.score).toBeGreaterThan(70);
  });

  it("returns null rather than F when nothing could be assessed", () => {
    // A brand new org has no infrastructure to grade; an F on day one is a lie
    // told to someone who has done nothing wrong.
    const combined = combinePillars([pillar("security", null), pillar("headroom", null)]);
    expect(combined.score).toBeNull();
    expect(combined.grade).toBeNull();
    expect(combined.assessedWeight).toBe(0);
  });

  it("returns null for an empty pillar list", () => {
    expect(combinePillars([]).score).toBeNull();
  });
});

describe("percentClean", () => {
  it("is the clean fraction as a whole percentage", () => {
    expect(percentClean(9, 10)).toBe(90);
    expect(percentClean(1, 3)).toBe(33);
  });

  it("returns null for an empty population rather than a perfect score", () => {
    // "None of your nought resources are unprotected" is an absence of
    // evidence, not an A.
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
    const oneCritical = findingScore({ ...clean, critical: 1 })!;
    const fourLows = findingScore({ ...clean, low: 4 })!;
    expect(oneCritical).toBeLessThan(fourLows);
  });

  it("reads better across a larger population", () => {
    // Ten findings across ten thousand resources is a better state than ten
    // across twenty, and a raw count says the opposite.
    const small = findingScore({ ...clean, high: 10, population: 20 })!;
    const large = findingScore({ ...clean, high: 10, population: 5000 })!;
    expect(large).toBeGreaterThan(small);
  });

  it("does not let a large org hide a pile of criticals", () => {
    // Past the population ceiling the denominator stops being interesting.
    expect(findingScore({ ...clean, critical: 30, population: 100000 })).toBe(0);
  });

  it("does not score a five-resource org out of existence for one finding", () => {
    // The population floor is what stops a tiny org reading as catastrophic.
    expect(findingScore({ ...clean, medium: 1, population: 5 })).toBeGreaterThan(75);
  });

  it("never leaves the 0–100 range", () => {
    expect(findingScore({ ...clean, critical: 1000, population: 10 })).toBe(0);
  });
});

describe("biggestDrag", () => {
  it("weights the loss rather than picking the lowest score", () => {
    // A 40 on a 5-weight pillar matters less than a 70 on a 30-weight one, and
    // sending somebody to fix the former first wastes their afternoon.
    const worst = biggestDrag([pillar("ownership", 40), pillar("security", 70)]);
    expect(worst?.id).toBe("security");
  });

  it("ignores unassessed pillars", () => {
    expect(biggestDrag([pillar("security", null), pillar("ownership", 40)])?.id).toBe("ownership");
  });

  it("is null when everything is perfect", () => {
    expect(biggestDrag([pillar("security", 100)])).toBeNull();
  });
});

describe("trendDelta", () => {
  const point = (day: string, score: number) => ({
    day,
    score,
    grade: scoreToGrade(score),
    pillars: {},
  });

  it("compares against the oldest stored reading", () => {
    expect(trendDelta([point("2026-08-01", 60), point("2026-08-10", 70)], 75)).toBe(15);
  });

  it("is null with no history or no current score", () => {
    expect(trendDelta([], 75)).toBeNull();
    expect(trendDelta([point("2026-08-01", 60)], null)).toBeNull();
  });
});
