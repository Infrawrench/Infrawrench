import { describe, expect, it } from "vitest";

import {
  changeCostImpactAnnotationText,
  clampChangeImpactWindowDays,
  costBasisLabel,
  formatChangeCostImpact,
  formatSignedPerDay,
  parseCostBasis,
  type ChangeCostImpact,
} from "../change-cost-impact";

function measured(overrides: Partial<ChangeCostImpact> = {}): ChangeCostImpact {
  return {
    status: "measured",
    costBasis: "cash",
    windowDays: 7,
    effectiveWindowDays: 7,
    eventDay: "2026-06-15",
    before: { from: "2026-06-08", to: "2026-06-14" },
    after: { from: "2026-06-16", to: "2026-06-22" },
    series: [
      {
        currency: "USD",
        beforePerDay: 10,
        afterPerDay: 22,
        deltaPerDay: 12,
        deltaPercent: 120,
        beforeTotal: 70,
        afterTotal: 154,
      },
    ],
    confidence: "high",
    reasons: [],
    overlappingChanges: 0,
    ...overrides,
  };
}

describe("formatChangeCostImpact", () => {
  it("names the basis and the window, because a bare delta is unreadable", () => {
    expect(formatChangeCostImpact(measured())).toBe(
      "+$12/day (+120%) · cash basis, 7d before/after",
    );
  });

  it("names the amortized basis when that is what was asked for", () => {
    expect(formatChangeCostImpact(measured({ costBasis: "amortized" }))).toContain(
      "amortized basis",
    );
  });

  it("renders nothing at all for an unmeasurable impact in compact mode", () => {
    // The alternative is a row of "unknown" beside every security group that
    // was never billable — noise that trains people to ignore the column.
    const unknown = measured({ status: "unknown", series: [], reasons: ["no_cost_data"] });
    expect(formatChangeCostImpact(unknown)).toBeNull();
  });

  it("says why when the reader asked", () => {
    const unknown = measured({
      status: "unknown",
      series: [],
      reasons: ["period_native_provider"],
    });
    expect(formatChangeCostImpact(unknown, { verbose: true })).toBe(
      "Cost impact unknown — this provider bills by invoice period, not by day.",
    );
  });

  it("omits the percentage when the before window spent nothing", () => {
    const created = measured({
      series: [
        {
          currency: "USD",
          beforePerDay: 0,
          afterPerDay: 5,
          deltaPerDay: 5,
          deltaPercent: null,
          beforeTotal: 0,
          afterTotal: 35,
        },
      ],
    });
    expect(formatChangeCostImpact(created)).toBe("+$5/day · cash basis, 7d before/after");
  });
});

describe("formatSignedPerDay", () => {
  it("signs the direction and formats money through the shared formatter", () => {
    expect(formatSignedPerDay(12.5, "USD")).toBe("+$12.50/day");
    expect(formatSignedPerDay(12.37, "USD")).toBe("+$12.37/day");
    // U+2212, not a hyphen — it aligns with digits in a column of these.
    expect(formatSignedPerDay(-3, "USD")).toBe("−$3/day");
    expect(formatSignedPerDay(0, "USD")).toBe("$0/day");
  });
});

describe("changeCostImpactAnnotationText", () => {
  it("writes a note naming the subject, the delta and the basis", () => {
    expect(
      changeCostImpactAnnotationText({ kind: "change", label: "api-prod updated" }, measured()),
    ).toBe("Change: api-prod updated — +$12/day (+120%) · cash basis, 7d before/after");
  });

  it("says when other changes overlapped rather than claiming the whole delta", () => {
    const contested = measured({ overlappingChanges: 2, confidence: "medium" });
    expect(
      changeCostImpactAnnotationText({ kind: "deployment", label: "acme/web → prod" }, contested),
    ).toContain("(other changes overlapped)");
  });

  it("refuses to write a note for an unmeasurable impact", () => {
    // A note reading "$0.00/day" would say something we did not measure.
    const unknown = measured({ status: "unknown", series: [], reasons: ["no_cost_data"] });
    expect(
      changeCostImpactAnnotationText({ kind: "change", label: "sg-1 updated" }, unknown),
    ).toBeNull();
  });
});

describe("clampChangeImpactWindowDays", () => {
  it("defaults to 7 and clamps to the supported range", () => {
    expect(clampChangeImpactWindowDays(undefined)).toBe(7);
    expect(clampChangeImpactWindowDays(Number.NaN)).toBe(7);
    expect(clampChangeImpactWindowDays(1)).toBe(2);
    expect(clampChangeImpactWindowDays(400)).toBe(30);
    expect(clampChangeImpactWindowDays(14)).toBe(14);
  });
});

describe("parseCostBasis", () => {
  it("defaults absent to cash and rejects anything else outright", () => {
    expect(parseCostBasis(undefined)).toBe("cash");
    expect(parseCostBasis("amortized")).toBe("amortized");
    // Not a fall-through to the default: a caller who asked for a basis we do
    // not have must be told, not silently answered on a different one.
    expect(parseCostBasis("blended")).toBeNull();
  });
});

describe("costBasisLabel", () => {
  it("is the one spelling every surface prints", () => {
    expect(costBasisLabel("cash")).toBe("cash basis");
    expect(costBasisLabel("amortized")).toBe("amortized basis");
  });
});
