import { describe, expect, it } from "vitest";
import type { SeatListResponse } from "@infrawrench/client-core";
import {
  observeSeats,
  planFindingObservations,
  regionFromFields,
  resourceContextFromFields,
  type ObservedFinding,
  type StoredFindingState,
} from "../savings/findings";

function observed(kind: ObservedFinding["kind"], sourceId: string): ObservedFinding {
  return {
    kind,
    sourceId,
    title: sourceId,
    detail: null,
    pluginId: "aws",
    pluginName: "AWS",
    accountId: "a1",
    accountName: "Prod",
    region: null,
    resourceId: sourceId,
    resourceName: sourceId,
    resourceTypeId: null,
    resourceTypeName: null,
    tags: {},
    monthly: null,
  };
}

function stored(
  kind: StoredFindingState["kind"],
  sourceId: string,
  over: Partial<StoredFindingState> = {},
): StoredFindingState {
  return { kind, sourceId, status: "ready", resolution: null, goneAt: null, ...over };
}

const ALL = new Set(["orphan", "oversized", "extended_support", "seat"] as const);

describe("planFindingObservations", () => {
  it("records new findings as fresh and known ones as seen", () => {
    const plan = planFindingObservations(
      [stored("orphan", "a")],
      [observed("orphan", "a"), observed("orphan", "b")],
      ALL,
      true,
    );
    expect(plan.fresh.map((f) => f.sourceId)).toEqual(["b"]);
    expect(plan.seen.map((f) => f.sourceId)).toEqual(["a"]);
    expect(plan.gone).toEqual([]);
  });

  it("completes open findings that went away, as resolved", () => {
    const plan = planFindingObservations(
      [
        stored("orphan", "ready"),
        stored("orphan", "working", { status: "in_progress" }),
        stored("orphan", "archived", { status: "archived" }),
        stored("orphan", "done", { status: "completed", resolution: "manual" }),
      ],
      [],
      ALL,
      true,
    );
    expect(plan.gone.map((g) => g.sourceId)).toEqual(["ready", "working", "archived", "done"]);
    expect(plan.resolved.map((g) => g.sourceId)).toEqual(["ready", "working"]);
    expect(plan.transitions).toEqual([
      {
        kind: "orphan",
        sourceId: "ready",
        previousStatus: "ready",
        status: "completed",
        resolution: "resolved",
      },
      {
        kind: "orphan",
        sourceId: "working",
        previousStatus: "in_progress",
        status: "completed",
        resolution: "resolved",
      },
    ]);
  });

  it("never concludes absence for a finder that failed, or from a read", () => {
    const rows = [stored("orphan", "a"), stored("seat", "inactive:s1")];
    const scanOnlyOrphans = planFindingObservations(rows, [], new Set(["orphan"] as const), true);
    expect(scanOnlyOrphans.gone.map((g) => g.sourceId)).toEqual(["a"]);
    const read = planFindingObservations(rows, [], ALL, false);
    expect(read.gone).toEqual([]);
    expect(read.transitions).toEqual([]);
  });

  it("reopens an automatically resolved finding that came back, and nothing a person set", () => {
    const gone = new Date("2026-10-01T00:00:00Z");
    const plan = planFindingObservations(
      [
        stored("oversized", "auto", { status: "completed", resolution: "resolved", goneAt: gone }),
        stored("oversized", "manual", { status: "completed", resolution: "manual", goneAt: gone }),
        stored("oversized", "archived", { status: "archived", goneAt: gone }),
      ],
      [
        observed("oversized", "auto"),
        observed("oversized", "manual"),
        observed("oversized", "archived"),
      ],
      ALL,
      false,
    );
    expect(plan.returned.map((r) => r.sourceId)).toEqual(["auto", "manual", "archived"]);
    expect(plan.reopened.map((r) => r.sourceId)).toEqual(["auto"]);
    expect(plan.transitions).toEqual([
      {
        kind: "oversized",
        sourceId: "auto",
        previousStatus: "completed",
        status: "ready",
        resolution: null,
      },
    ]);
  });

  it("does not mark an already-gone finding gone twice", () => {
    const plan = planFindingObservations(
      [stored("orphan", "a", { status: "completed", resolution: "resolved", goneAt: new Date() })],
      [],
      ALL,
      true,
    );
    expect(plan.gone).toEqual([]);
  });
});

describe("resource context", () => {
  it("reads region and tags from stored fields", () => {
    expect(regionFromFields({ location: "westeurope" })).toBe("westeurope");
    expect(regionFromFields({ region: "", zone: "us-central1-a" })).toBe("us-central1-a");
    expect(regionFromFields(null)).toBeNull();
    expect(resourceContextFromFields({ region: "nyc3", tags: { env: "prod" } })).toEqual({
      region: "nyc3",
      tags: { env: "prod" },
    });
  });
});

describe("observeSeats", () => {
  it("keys each finding on its kind and seat, and prices it", () => {
    const feed = {
      inactiveDays: 30,
      seats: [
        {
          id: "s1",
          accountId: "a1",
          accountName: "GitHub org",
          pluginId: "github",
          pluginName: "GitHub",
          memberId: "m1",
          seatKey: "",
          name: "Ada",
          email: null,
          login: "ada",
          product: "Copilot",
          activitySource: "Copilot last activity",
        },
      ],
      findings: [{ kind: "inactive", seatId: "s1", monthlySaving: 19, currency: "USD" }],
    } as unknown as SeatListResponse;
    const [f] = observeSeats(feed);
    expect(f).toMatchObject({
      kind: "seat",
      sourceId: "inactive:s1",
      title: "Unused Copilot seat for Ada",
      accountId: "a1",
      resourceId: null,
      monthly: { amount: 19, currency: "USD" },
    });
  });
});
