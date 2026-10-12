import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORECARD_LEVELS,
  SCORECARD_CHECK_TYPES,
  computeScorecardScore,
  defaultScorecardInput,
  isScorecardLevelDrop,
  normalizeScorecardInput,
  scorecardAppliesTo,
  scorecardLevelFor,
  validateScorecardInput,
} from "../scorecards";

describe("computeScorecardScore", () => {
  it("weights passing checks over applicable ones", () => {
    expect(
      computeScorecardScore([
        { status: "pass", weight: 2 },
        { status: "fail", weight: 1 },
        { status: "not_applicable", weight: 5 },
      ]),
    ).toBe(66.7);
  });

  it("counts an errored check as failing", () => {
    expect(
      computeScorecardScore([
        { status: "pass", weight: 1 },
        { status: "error", weight: 1 },
      ]),
    ).toBe(50);
  });

  it("is null, not zero, when nothing applies", () => {
    expect(computeScorecardScore([{ status: "not_applicable", weight: 1 }])).toBeNull();
    expect(computeScorecardScore([])).toBeNull();
  });
});

describe("levels", () => {
  it("picks the highest level the score reaches", () => {
    expect(scorecardLevelFor(95, DEFAULT_SCORECARD_LEVELS)?.key).toBe("gold");
    expect(scorecardLevelFor(75, DEFAULT_SCORECARD_LEVELS)?.key).toBe("silver");
    expect(scorecardLevelFor(49.9, DEFAULT_SCORECARD_LEVELS)).toBeNull();
    expect(scorecardLevelFor(null, DEFAULT_SCORECARD_LEVELS)).toBeNull();
  });

  it("works regardless of stored order", () => {
    const reversed = [...DEFAULT_SCORECARD_LEVELS].reverse();
    expect(scorecardLevelFor(80, reversed)?.key).toBe("silver");
  });

  it("detects drops, including off the ladder, and ignores rises and first results", () => {
    expect(isScorecardLevelDrop("gold", "silver", DEFAULT_SCORECARD_LEVELS)).toBe(true);
    expect(isScorecardLevelDrop("bronze", null, DEFAULT_SCORECARD_LEVELS)).toBe(true);
    expect(isScorecardLevelDrop("silver", "gold", DEFAULT_SCORECARD_LEVELS)).toBe(false);
    expect(isScorecardLevelDrop(null, "bronze", DEFAULT_SCORECARD_LEVELS)).toBe(false);
    expect(isScorecardLevelDrop("gold", "gold", DEFAULT_SCORECARD_LEVELS)).toBe(false);
  });
});

describe("scorecardAppliesTo", () => {
  it("applies to every service when no tiers are set", () => {
    expect(scorecardAppliesTo({ applicableTiers: [], enabled: true }, null)).toBe(true);
  });

  it("restricts to the listed tiers and skips untiered services", () => {
    const card = { applicableTiers: [1, 2] as Array<1 | 2>, enabled: true };
    expect(scorecardAppliesTo(card, 1)).toBe(true);
    expect(scorecardAppliesTo(card, 3)).toBe(false);
    expect(scorecardAppliesTo(card, null)).toBe(false);
  });

  it("never applies when disabled", () => {
    expect(scorecardAppliesTo({ applicableTiers: [], enabled: false }, 1)).toBe(false);
  });
});

describe("the default scorecard", () => {
  it("carries every registered check and validates", () => {
    const input = defaultScorecardInput();
    expect(input.checks.map((c) => c.type)).toEqual(SCORECARD_CHECK_TYPES.map((d) => d.type));
    expect(validateScorecardInput(input)).toBeNull();
  });
});

describe("validateScorecardInput", () => {
  const base = defaultScorecardInput();

  it("rejects out-of-range weights and params", () => {
    expect(
      validateScorecardInput({ ...base, checks: [{ ...base.checks[0]!, weight: 11 }] }),
    ).toMatch(/Weights/);
    const drill = base.checks.find((c) => c.type === "backups_verified")!;
    expect(
      validateScorecardInput({ ...base, checks: [{ ...drill, params: { drillWithinDays: 0 } }] }),
    ).toMatch(/between/);
  });

  it("rejects duplicate level keys and minimums", () => {
    const [bronze] = DEFAULT_SCORECARD_LEVELS;
    expect(validateScorecardInput({ ...base, levels: [bronze!, bronze!] })).toMatch(/unique/);
    expect(
      validateScorecardInput({ ...base, levels: [bronze!, { ...bronze!, key: "x" }] }),
    ).toMatch(/share/);
  });

  it("rejects unknown check types and severities", () => {
    expect(
      validateScorecardInput({
        ...base,
        checks: [{ id: "a", type: "nope" as never, name: null, weight: 1, params: {} }],
      }),
    ).toMatch(/Unknown/);
    const posture = base.checks.find((c) => c.type === "no_critical_posture")!;
    expect(
      validateScorecardInput({
        ...base,
        checks: [{ ...posture, params: { severities: ["dire"] } }],
      }),
    ).toMatch(/severity/);
  });
});

describe("normalizeScorecardInput", () => {
  it("sorts levels and fills check params from the registry", () => {
    const base = defaultScorecardInput();
    const drill = base.checks.find((c) => c.type === "backups_verified")!;
    const out = normalizeScorecardInput({
      ...base,
      checks: [{ ...drill, params: {} }],
      levels: [...base.levels].reverse(),
      applicableTiers: [2, 1, 2],
    });
    expect(out.levels.map((l) => l.key)).toEqual(["bronze", "silver", "gold"]);
    expect(out.checks[0]!.params).toEqual({ drillWithinDays: 90 });
    expect(out.applicableTiers).toEqual([1, 2]);
  });
});
