import { describe, expect, it } from "vitest";

import {
  COST_ANNOTATION_LIMITS,
  bucketCostAnnotations,
  costAnnotationInputError,
  describeCostAnnotationScope,
  formatCostAnnotationDates,
  type CostAnnotation,
} from "../cost-annotations";
import { totalPerBucket, type CostQuerySeries } from "../costs";

function annotation(
  over: Partial<CostAnnotation> & { id: string; startDate: string },
): CostAnnotation {
  return {
    endDate: null,
    text: `note ${over.id}`,
    costReportId: null,
    createdByUserId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("bucketCostAnnotations", () => {
  const daily = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"];

  it("lands a note on the bucket holding its day at every binning", () => {
    const notes = [annotation({ id: "a", startDate: "2026-07-15" })];

    expect(bucketCostAnnotations(notes, daily, "daily")[0]?.bucket).toBe("2026-07-15");
    expect(bucketCostAnnotations(notes, daily, "cumulative")[0]?.bucket).toBe("2026-07-15");
    expect(
      bucketCostAnnotations(notes, ["2026-07-06", "2026-07-13", "2026-07-20"], "weekly")[0]?.bucket,
    ).toBe("2026-07-13");
    expect(
      bucketCostAnnotations(notes, ["2026-06-01", "2026-07-01", "2026-08-01"], "monthly")[0]
        ?.bucket,
    ).toBe("2026-07-01");
  });

  it("puts a Sunday in the week that started six days earlier", () => {
    // Monday-start weeks (toStartOfWeek(day, 1)): 2026-07-19 is a Sunday and
    // belongs to the 2026-07-13 bar, never to the one starting tomorrow.
    const weeks = ["2026-07-06", "2026-07-13", "2026-07-20"];
    expect(
      bucketCostAnnotations(
        [annotation({ id: "sun", startDate: "2026-07-19" })],
        weeks,
        "weekly",
      )[0]?.bucket,
    ).toBe("2026-07-13");
    expect(
      bucketCostAnnotations(
        [annotation({ id: "mon", startDate: "2026-07-20" })],
        weeks,
        "weekly",
      )[0]?.bucket,
    ).toBe("2026-07-20");
  });

  it("draws no marker for a stored date that isn't a date", () => {
    expect(
      bucketCostAnnotations([annotation({ id: "junk", startDate: "July 15" })], daily, "weekly"),
    ).toEqual([]);
  });

  it("collapses several annotations in one bucket into a single marker", () => {
    const notes = [
      annotation({ id: "b", startDate: "2026-07-22", text: "Launched search" }),
      annotation({ id: "a", startDate: "2026-07-04", text: "Graviton migration" }),
      annotation({ id: "c", startDate: "2026-07-30", text: "Price change" }),
    ];
    // All three are July days; at monthly binning they are one bar.
    const markers = bucketCostAnnotations(notes, ["2026-07-01", "2026-08-01"], "monthly");

    expect(markers).toHaveLength(1);
    expect(markers[0]?.bucket).toBe("2026-07-01");
    expect(markers[0]?.annotations.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(markers[0]?.index).toBe(1);
  });

  it("numbers markers in bucket order regardless of input order", () => {
    const notes = [
      annotation({ id: "late", startDate: "2026-07-17" }),
      annotation({ id: "early", startDate: "2026-07-14" }),
    ];
    const markers = bucketCostAnnotations(notes, daily, "daily");

    expect(markers.map((m) => [m.index, m.annotations[0]?.id])).toEqual([
      [1, "early"],
      [2, "late"],
    ]);
  });

  it("drops annotations outside the chart's range entirely", () => {
    const notes = [
      annotation({ id: "before", startDate: "2026-06-01" }),
      annotation({ id: "after", startDate: "2026-09-01" }),
      annotation({ id: "spanBefore", startDate: "2026-05-01", endDate: "2026-06-30" }),
    ];
    expect(bucketCostAnnotations(notes, daily, "daily")).toEqual([]);
  });

  it("never introduces a bucket the chart did not draw", () => {
    const notes = [
      annotation({ id: "in", startDate: "2026-07-15" }),
      annotation({ id: "out", startDate: "2027-01-01" }),
    ];
    const markers = bucketCostAnnotations(notes, daily, "daily");

    for (const marker of markers) {
      expect(daily).toContain(marker.bucket);
      if (marker.endBucket) expect(daily).toContain(marker.endBucket);
    }
  });

  it("clamps a span that starts before or ends after the window", () => {
    const notes = [annotation({ id: "migration", startDate: "2026-07-01", endDate: "2026-08-01" })];
    const markers = bucketCostAnnotations(notes, daily, "daily");

    expect(markers).toHaveLength(1);
    // Marker snaps to the first drawn bucket; shading stops at the last.
    expect(markers[0]?.bucket).toBe("2026-07-13");
    expect(markers[0]?.endBucket).toBe("2026-07-17");
  });

  it("reports no end bucket when the span stays inside one bucket", () => {
    const notes = [annotation({ id: "week", startDate: "2026-07-14", endDate: "2026-07-16" })];

    expect(bucketCostAnnotations(notes, daily, "daily")[0]?.endBucket).toBe("2026-07-16");
    // The same three days are one bar at monthly binning — nothing to shade.
    expect(
      bucketCostAnnotations(notes, ["2026-07-01", "2026-08-01"], "monthly")[0]?.endBucket,
    ).toBeNull();
  });

  it("takes the furthest reach when spans share a marker bucket", () => {
    const notes = [
      annotation({ id: "short", startDate: "2026-07-13", endDate: "2026-07-14" }),
      annotation({ id: "long", startDate: "2026-07-13", endDate: "2026-07-16" }),
    ];
    const markers = bucketCostAnnotations(notes, daily, "daily");

    expect(markers).toHaveLength(1);
    expect(markers[0]?.endBucket).toBe("2026-07-16");
  });

  it("snaps a note in a gap onto the next drawn bucket rather than hiding it", () => {
    // A period with no spend at all returns no row, so it is not an x position.
    const gapped = ["2026-07-13", "2026-07-17"];
    const markers = bucketCostAnnotations(
      [annotation({ id: "gap", startDate: "2026-07-15" })],
      gapped,
      "daily",
    );

    expect(markers[0]?.bucket).toBe("2026-07-17");
  });

  it("draws nothing on an empty chart", () => {
    expect(
      bucketCostAnnotations([annotation({ id: "a", startDate: "2026-07-15" })], [], "daily"),
    ).toEqual([]);
  });

  it("leaves the chart's own data and totals untouched", () => {
    // The guarantee that matters: an annotation is an overlay. Bucketing them
    // must not mutate the series, the bucket list, or what the chart totals to.
    const series: CostQuerySeries[] = [
      {
        key: "aws",
        label: "AWS",
        currency: "USD",
        points: [
          { bucket: "2026-07-13", amount: 10 },
          { bucket: "2026-07-14", amount: 20 },
        ],
      },
      {
        key: "gcp",
        label: "GCP",
        currency: "USD",
        points: [{ bucket: "2026-07-14", amount: 5 }],
      },
    ];
    const before = totalPerBucket(series);
    const buckets = before.map((p) => p.bucket);
    const bucketsCopy = [...buckets];
    const notes = [
      annotation({ id: "a", startDate: "2026-07-13" }),
      annotation({ id: "b", startDate: "2026-07-13", endDate: "2026-07-14" }),
    ];
    const notesCopy = notes.map((n) => ({ ...n }));

    bucketCostAnnotations(notes, buckets, "daily");

    expect(buckets).toEqual(bucketsCopy);
    expect(notes).toEqual(notesCopy);
    expect(totalPerBucket(series)).toEqual(before);
    expect(before.reduce((sum, p) => sum + p.amount, 0)).toBe(35);
  });
});

describe("costAnnotationInputError", () => {
  it("accepts a moment and a span", () => {
    expect(costAnnotationInputError({ startDate: "2026-07-15", text: "Deployed" })).toBeNull();
    expect(
      costAnnotationInputError({
        startDate: "2026-07-15",
        endDate: "2026-07-22",
        text: "Migration week",
      }),
    ).toBeNull();
  });

  it("rejects an empty note, a backwards span, and an over-long one", () => {
    expect(costAnnotationInputError({ startDate: "2026-07-15", text: "   " })).toMatch(/text/);
    expect(
      costAnnotationInputError({ startDate: "2026-07-15", endDate: "2026-07-01", text: "x" }),
    ).toMatch(/before/);
    expect(
      costAnnotationInputError({
        startDate: "2026-07-15",
        text: "x".repeat(COST_ANNOTATION_LIMITS.maxTextLength + 1),
      }),
    ).toMatch(/characters/);
    expect(
      costAnnotationInputError({ startDate: "2020-01-01", endDate: "2026-01-01", text: "x" }),
    ).toMatch(/at most/);
  });

  it("rejects a start that isn't a date", () => {
    expect(costAnnotationInputError({ startDate: "July 15", text: "x" })).toMatch(/date/);
  });
});

describe("labels", () => {
  it("prints a moment as one date and a span as two", () => {
    expect(formatCostAnnotationDates({ startDate: "2026-07-15", endDate: null })).not.toContain(
      "–",
    );
    expect(formatCostAnnotationDates({ startDate: "2026-07-15", endDate: "2026-07-22" })).toContain(
      "–",
    );
    // An end equal to the start is a moment, however it was stored.
    expect(
      formatCostAnnotationDates({ startDate: "2026-07-15", endDate: "2026-07-15" }),
    ).not.toContain("–");
  });

  it("says which scope an annotation is filed under", () => {
    expect(describeCostAnnotationScope({ costReportId: null })).toBe("Org-wide");
    expect(describeCostAnnotationScope({ costReportId: "report-1" })).toBe("This report");
  });
});
