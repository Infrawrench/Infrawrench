import { describe, expect, it } from "vitest";
import {
  bucketCostAnnotations,
  costAnomalyAnnotationInput,
  costAnomalyExplanationPrefill,
  countUnexplainedCostAnomalies,
  isCostAnomalyExplained,
  type CostAnnotation,
  type CostAnomaly,
} from "@infrawrench/client-core";
import {
  CostAnomalyAcknowledgeError,
  planAnomalyAcknowledgement,
  type AcknowledgeableAnomaly,
} from "../cost/anomaly-acknowledge";

function anomaly(overrides: Partial<AcknowledgeableAnomaly> = {}): AcknowledgeableAnomaly {
  return { day: "2026-07-30", acknowledgedAt: null, annotationId: null, ...overrides };
}

/** A full wire anomaly, for the helpers that read one. */
function row(overrides: Partial<CostAnomaly> = {}): CostAnomaly {
  return {
    id: "a1",
    day: "2026-07-30",
    kind: "spike",
    dimension: "service",
    dimensionKey: "Amazon EC2",
    currency: "USD",
    actualCents: 27_300,
    baselineCents: 10_000,
    thresholdCents: 15_000,
    detectedAt: "2026-07-31T02:00:00.000Z",
    notifiedAt: null,
    hints: [],
    acknowledgement: null,
    ...overrides,
  };
}

describe("planAnomalyAcknowledgement", () => {
  it("mints a note on the anomaly's own day, org-wide, as a moment", () => {
    const plan = planAnomalyAcknowledgement(anomaly(), "  Migrated the API fleet to Graviton  ");
    expect(plan).toEqual({
      action: "create",
      input: {
        // The anomalous day, not today: the note explains a bar that may be a
        // month old.
        startDate: "2026-07-30",
        endDate: null,
        text: "Migrated the API fleet to Graviton",
        // Org-wide — the whole point of acknowledging rather than commenting.
        costReportId: null,
      },
    });
  });

  it("rewords the existing note rather than filing a second one", () => {
    const plan = planAnomalyAcknowledgement(
      anomaly({ acknowledgedAt: new Date("2026-08-01"), annotationId: "ann-1" }),
      "Actually the nightly backfill re-ran",
    );
    // Text only: the note's date and scope may have been edited deliberately
    // since, and a correction to the wording must not undo that.
    expect(plan).toEqual({
      action: "update",
      annotationId: "ann-1",
      text: "Actually the nightly backfill re-ran",
    });
  });

  it("does not resurrect a note that was deleted on purpose", () => {
    // Acknowledged before, but `annotation_id` is null — the foreign key nulled
    // it when somebody deleted the marker. Correcting the sentence updates the
    // record; it does not put the marker back.
    const plan = planAnomalyAcknowledgement(
      anomaly({ acknowledgedAt: new Date("2026-08-01"), annotationId: null }),
      "Still the migration, worded better",
    );
    expect(plan).toEqual({ action: "none", reason: "annotation-deleted" });
  });

  it("refuses an explanation an annotation could not hold", () => {
    expect(() => planAnomalyAcknowledgement(anomaly(), "   ")).toThrow(CostAnomalyAcknowledgeError);
    expect(() => planAnomalyAcknowledgement(anomaly(), "x".repeat(501))).toThrow(
      CostAnomalyAcknowledgeError,
    );
    // …and the message is the one the composer shows, not a schema dump.
    expect(() => planAnomalyAcknowledgement(anomaly(), "")).toThrow(/needs some text/);
  });
});

describe("the note lands on the bar it explains", () => {
  /** The annotation an acknowledgement would create, as the API returns it. */
  function noteFor(day: string): CostAnnotation {
    const input = costAnomalyAnnotationInput({ day }, "Migrated the API fleet");
    return {
      id: "ann-1",
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      text: input.text,
      costReportId: input.costReportId ?? null,
      createdByUserId: "user-1",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      costAnomalyId: "a1",
    };
  }

  it("marks the anomalous day itself at daily binning", () => {
    const markers = bucketCostAnnotations(
      [noteFor("2026-07-30")],
      ["2026-07-29", "2026-07-30", "2026-07-31"],
      "daily",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.bucket).toBe("2026-07-30");
    // A moment, so no shading past its own bar.
    expect(markers[0]!.endBucket).toBeNull();
  });

  it("marks the week and the month containing it at coarser binnings", () => {
    // 2026-07-30 is a Thursday; its week starts Monday 2026-07-27.
    const weekly = bucketCostAnnotations(
      [noteFor("2026-07-30")],
      ["2026-07-20", "2026-07-27", "2026-08-03"],
      "weekly",
    );
    expect(weekly[0]!.bucket).toBe("2026-07-27");

    const monthly = bucketCostAnnotations(
      [noteFor("2026-07-30")],
      ["2026-06-01", "2026-07-01", "2026-08-01"],
      "monthly",
    );
    expect(monthly[0]!.bucket).toBe("2026-07-01");
  });

  it("draws nothing on a chart whose window excludes the anomaly", () => {
    expect(
      bucketCostAnnotations([noteFor("2026-07-30")], ["2026-09-01", "2026-09-02"], "daily"),
    ).toEqual([]);
  });
});

describe("explained findings stop nagging without disappearing", () => {
  it("counts only the unexplained ones", () => {
    const rows = [
      row({ id: "a1" }),
      row({
        id: "a2",
        acknowledgement: {
          explanation: "Migrated the API fleet",
          acknowledgedAt: "2026-08-01T00:00:00.000Z",
          acknowledgedByUserId: "user-1",
          annotationId: "ann-1",
        },
      }),
      row({ id: "a3" }),
    ];
    expect(countUnexplainedCostAnomalies(rows)).toBe(2);
    // The explained row is still in the list — the detection record survives.
    expect(rows).toHaveLength(3);
  });

  it("stays explained after its note is deleted", () => {
    const orphaned = row({
      acknowledgement: {
        explanation: "Migrated the API fleet",
        acknowledgedAt: "2026-08-01T00:00:00.000Z",
        acknowledgedByUserId: "user-1",
        // The marker is gone; the acknowledgement is not.
        annotationId: null,
      },
    });
    expect(isCostAnomalyExplained(orphaned)).toBe(true);
    expect(countUnexplainedCostAnomalies([orphaned])).toBe(0);
  });

  it("reads an older server's row, with no acknowledgement field at all, as unexplained", () => {
    const { acknowledgement: _omitted, ...legacy } = row();
    expect(isCostAnomalyExplained(legacy as CostAnomaly)).toBe(false);
  });
});

describe("costAnomalyExplanationPrefill", () => {
  it("opens the composer with the change, so a sentence only has to be finished", () => {
    expect(costAnomalyExplanationPrefill(row())).toBe("Amazon EC2 spend +173% — ");
  });

  it("never quotes a percentage for a new source", () => {
    const prefill = costAnomalyExplanationPrefill(
      row({ kind: "new_source", baselineCents: 1, actualCents: 5000 }),
    );
    expect(prefill).toBe("Amazon EC2 started spending — ");
    expect(prefill).not.toMatch(/%/);
  });
});
