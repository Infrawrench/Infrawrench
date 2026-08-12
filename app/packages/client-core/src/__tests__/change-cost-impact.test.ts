import { describe, expect, it } from "vitest";

import {
  changeCostImpactAnnotationText,
  chunkChangeImpactIds,
  clampChangeImpactWindowDays,
  collectChangeImpactResults,
  costBasisLabel,
  MAX_CHANGE_IMPACT_BATCH,
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

describe("chunkChangeImpactIds", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `chg-${i}`);

  it("covers every id past the batch cap instead of truncating to one request", () => {
    // The regression: an infinite-scrolling feed used to send
    // `ids.slice(0, MAX_CHANGE_IMPACT_BATCH)`, so every row past the cap came
    // back with no impact — indistinguishable on screen from "this resource has
    // no cost data". Silently omitting a measurable impact is the one failure
    // this feature exists to avoid, so the ids are chunked, never cut.
    const three = ids(MAX_CHANGE_IMPACT_BATCH * 3);
    const chunks = chunkChangeImpactIds(three);
    expect(chunks.flat()).toEqual(three);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= MAX_CHANGE_IMPACT_BATCH)).toBe(true);
  });

  it("covers a partial final page — three 25-row pages against a 50 cap", () => {
    const loaded = ids(75);
    const chunks = chunkChangeImpactIds(loaded);
    expect(chunks.flat()).toEqual(loaded);
    expect(chunks.map((c) => c.length)).toEqual([50, 25]);
  });

  it("leaves earlier chunks byte-identical when a page is appended", () => {
    // This is what lets a caller key one query per chunk: loading more must
    // refetch only the new chunk, not re-measure everything already on screen.
    const first = chunkChangeImpactIds(ids(50));
    const afterLoadMore = chunkChangeImpactIds(ids(75));
    expect(afterLoadMore[0]).toEqual(first[0]);
  });

  it("issues nothing for an empty feed", () => {
    expect(chunkChangeImpactIds([])).toEqual([]);
  });
});

describe("collectChangeImpactResults", () => {
  const entry = (changeId: string) => ({
    changeId,
    resourceId: `res-${changeId}`,
    impact: measured(),
  });

  it("marks a failed chunk's rows unresolved instead of leaving them blank", () => {
    // The regression: a failed lookup used to render exactly like a successful
    // one that found nothing. Blank already means "no measurable impact" on
    // this surface, so a transient network error silently became a confident,
    // wrong claim about the bill — on a row that otherwise looks fine.
    const chunks = [
      ["a", "b"],
      ["c", "d"],
    ];
    const { impacts, unresolved } = collectChangeImpactResults(chunks, [
      { data: [entry("a"), entry("b")], isError: false },
      { data: undefined, isError: true },
    ]);
    expect(Object.keys(impacts).sort()).toEqual(["a", "b"]);
    expect([...unresolved].sort()).toEqual(["c", "d"]);
  });

  it("clears the unresolved rows once the endpoint recovers", () => {
    // Derived from current results rather than accumulated, so recovery needs
    // no latch to clear and a stale failure cannot outlive it.
    const chunks = [["c", "d"]];
    const failed = collectChangeImpactResults(chunks, [{ data: undefined, isError: true }]);
    expect([...failed.unresolved].sort()).toEqual(["c", "d"]);

    const recovered = collectChangeImpactResults(chunks, [
      { data: [entry("c"), entry("d")], isError: false },
    ]);
    expect(recovered.unresolved.size).toBe(0);
    expect(Object.keys(recovered.impacts).sort()).toEqual(["c", "d"]);
  });

  it("leaves a chunk still in flight blank rather than calling it unresolved", () => {
    // Loading is not failure: a spinner-less blank for a moment is right, an
    // "unavailable" that turns into a number a second later is not.
    const { impacts, unresolved } = collectChangeImpactResults(
      [["a"]],
      [{ data: undefined, isError: false }],
    );
    expect(impacts).toEqual({});
    expect(unresolved.size).toBe(0);
  });

  it("keeps rows that did answer when their chunk errors on a later refetch", () => {
    // react-query reports `data` and `isError` together on a failed background
    // refetch. Those rows have a real answer; only the ones with nothing don't.
    const { impacts, unresolved } = collectChangeImpactResults(
      [["a", "b"]],
      [{ data: [entry("a")], isError: true }],
    );
    expect(Object.keys(impacts)).toEqual(["a"]);
    expect([...unresolved]).toEqual(["b"]);
  });

  it("does not confuse a measurable-but-unknown impact with a failed lookup", () => {
    // "We looked and cannot say" is an answer and stays blank; "we could not
    // look" is not, and says so. Collapsing the two is the whole bug.
    const unknown = measured({ status: "unknown", series: [], reasons: ["no_cost_data"] });
    const { impacts, unresolved } = collectChangeImpactResults(
      [["a"]],
      [{ data: [{ changeId: "a", resourceId: "res-a", impact: unknown }], isError: false }],
    );
    expect(impacts["a"]?.status).toBe("unknown");
    expect(unresolved.size).toBe(0);
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
