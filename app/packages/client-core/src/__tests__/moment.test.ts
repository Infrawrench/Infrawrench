import { describe, expect, it } from "vitest";
import {
  buildMomentTimeline,
  clampMomentWindow,
  compareMomentEvents,
  describeIncidentBadge,
  incidentsCovering,
  momentSearchParams,
  momentWindowBounds,
  DEFAULT_MOMENT_WINDOW_MINUTES,
  MOMENT_WINDOW_LIMITS,
  type MomentEvent,
  type MomentIncidentSpan,
} from "../moment";

function event(
  overrides: Partial<MomentEvent> & Pick<MomentEvent, "id" | "timestamp">,
): MomentEvent {
  return {
    feed: "changes",
    kind: "change.updated",
    title: "something changed",
    severity: "info",
    ...overrides,
  };
}

function incident(
  overrides: Partial<MomentIncidentSpan> & Pick<MomentIncidentSpan, "id">,
): MomentIncidentSpan {
  return {
    pluginId: "digitalocean",
    pluginName: "DigitalOcean",
    title: "API errors in NYC3",
    impact: "major",
    startedAt: "2026-08-03T02:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

describe("clampMomentWindow", () => {
  it("defaults non-finite input", () => {
    expect(clampMomentWindow(undefined)).toBe(DEFAULT_MOMENT_WINDOW_MINUTES);
    expect(clampMomentWindow(Number.NaN)).toBe(DEFAULT_MOMENT_WINDOW_MINUTES);
  });

  it("clamps to the limits and rounds", () => {
    expect(clampMomentWindow(0)).toBe(MOMENT_WINDOW_LIMITS.min);
    expect(clampMomentWindow(99999)).toBe(MOMENT_WINDOW_LIMITS.max);
    expect(clampMomentWindow(14.6)).toBe(15);
  });
});

describe("momentWindowBounds", () => {
  it("returns at ± window", () => {
    const { from, to } = momentWindowBounds("2026-08-03T03:14:00.000Z", 15);
    expect(from.toISOString()).toBe("2026-08-03T02:59:00.000Z");
    expect(to.toISOString()).toBe("2026-08-03T03:29:00.000Z");
  });

  it("throws on an unparseable centre", () => {
    expect(() => momentWindowBounds("not-a-date", 15)).toThrow(/Invalid moment timestamp/);
  });
});

describe("compareMomentEvents", () => {
  it("sorts chronologically with stable tie-breaks", () => {
    const events = [
      event({ id: "b", timestamp: "2026-08-03T03:10:00.000Z", feed: "audit" }),
      event({ id: "a", timestamp: "2026-08-03T03:10:00.000Z", feed: "changes" }),
      event({ id: "c", timestamp: "2026-08-03T03:05:00.000Z", feed: "freezes" }),
    ];
    events.sort(compareMomentEvents);
    expect(events.map((e) => e.id)).toEqual(["c", "a", "b"]);
  });
});

describe("incidentsCovering", () => {
  const spans = [
    incident({ id: "open" }),
    incident({ id: "closed", resolvedAt: "2026-08-03T03:00:00.000Z" }),
  ];

  it("includes open incidents after their start", () => {
    expect(incidentsCovering("2026-08-03T04:00:00.000Z", spans).map((s) => s.id)).toEqual(["open"]);
  });

  it("includes resolved incidents only inside their span", () => {
    expect(incidentsCovering("2026-08-03T02:30:00.000Z", spans).map((s) => s.id)).toEqual([
      "open",
      "closed",
    ]);
  });

  it("excludes everything before the start", () => {
    expect(incidentsCovering("2026-08-03T01:00:00.000Z", spans)).toEqual([]);
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(incidentsCovering("garbage", spans)).toEqual([]);
  });
});

describe("describeIncidentBadge", () => {
  it("is null with no spans", () => {
    expect(describeIncidentBadge([])).toBeNull();
  });

  it("names the provider once", () => {
    expect(describeIncidentBadge([incident({ id: "a" }), incident({ id: "b" })])).toBe(
      "during DigitalOcean incident",
    );
  });

  it("pluralizes across distinct providers", () => {
    expect(
      describeIncidentBadge([
        incident({ id: "a" }),
        incident({ id: "b", pluginId: "hetzner", pluginName: "Hetzner Cloud" }),
      ]),
    ).toBe("during DigitalOcean, Hetzner Cloud incidents");
  });
});

describe("buildMomentTimeline", () => {
  const minute = (m: number) => `2026-08-03T03:${String(m).padStart(2, "0")}:00.000Z`;

  it("collapses a dense same-resource run into a burst", () => {
    const events = [
      event({ id: "1", timestamp: minute(10), resourceId: "r1", resourceName: "api-1" }),
      event({ id: "2", timestamp: minute(12), resourceId: "r1", resourceName: "api-1" }),
      event({ id: "3", timestamp: minute(14), resourceId: "r1", resourceName: "api-1" }),
      event({ id: "4", timestamp: minute(20), resourceId: "r2" }),
    ];
    const items = buildMomentTimeline(events, []);
    expect(items).toHaveLength(2);
    const [first, second] = items;
    expect(first?.kind).toBe("burst");
    if (first?.kind === "burst") {
      expect(first.resourceId).toBe("r1");
      expect(first.events.map((e) => e.id)).toEqual(["1", "2", "3"]);
    }
    expect(second?.kind).toBe("event");
  });

  it("does not group events with no resource id", () => {
    const events = [
      event({ id: "1", timestamp: minute(10) }),
      event({ id: "2", timestamp: minute(11) }),
      event({ id: "3", timestamp: minute(12) }),
    ];
    const items = buildMomentTimeline(events, []);
    expect(items.every((item) => item.kind === "event")).toBe(true);
  });

  it("breaks a run when the gap exceeds the threshold", () => {
    const events = [
      event({ id: "1", timestamp: minute(0), resourceId: "r1" }),
      event({ id: "2", timestamp: minute(2), resourceId: "r1" }),
      event({ id: "3", timestamp: minute(30), resourceId: "r1" }),
    ];
    const items = buildMomentTimeline(events, []);
    expect(items.every((item) => item.kind === "event")).toBe(true);
  });

  it("keeps runs below the minimum as single events", () => {
    const events = [
      event({ id: "1", timestamp: minute(0), resourceId: "r1" }),
      event({ id: "2", timestamp: minute(1), resourceId: "r1" }),
    ];
    const items = buildMomentTimeline(events, []);
    expect(items.every((item) => item.kind === "event")).toBe(true);
  });

  it("badges events and bursts with the incidents covering them", () => {
    const spans = [incident({ id: "inc1", startedAt: minute(5), resolvedAt: minute(15) })];
    const events = [
      event({ id: "in", timestamp: minute(10) }),
      event({ id: "out", timestamp: minute(20) }),
      event({ id: "b1", timestamp: minute(6), resourceId: "r1" }),
      event({ id: "b2", timestamp: minute(7), resourceId: "r1" }),
      event({ id: "b3", timestamp: minute(8), resourceId: "r1" }),
    ];
    const items = buildMomentTimeline(events, spans);
    const burst = items.find((item) => item.kind === "burst");
    expect(burst?.incidentIds).toEqual(["inc1"]);
    const single = items.find((item) => item.kind === "event" && item.event.id === "in");
    expect(single?.incidentIds).toEqual(["inc1"]);
    const outside = items.find((item) => item.kind === "event" && item.event.id === "out");
    expect(outside?.incidentIds).toEqual([]);
  });

  it("sorts unordered input chronologically", () => {
    const events = [
      event({ id: "late", timestamp: minute(30) }),
      event({ id: "early", timestamp: minute(1) }),
    ];
    const items = buildMomentTimeline(events, []);
    expect(items.map((item) => item.key)).toEqual(["early", "late"]);
  });
});

describe("momentSearchParams", () => {
  it("serializes valid values", () => {
    expect(momentSearchParams({ at: "2026-08-03T03:14:00Z", windowMinutes: 15 })).toBe(
      `at=${encodeURIComponent("2026-08-03T03:14:00Z")}&window=15`,
    );
  });

  it("drops invalid dates and non-finite windows", () => {
    expect(momentSearchParams({ at: "garbage", windowMinutes: Number.NaN })).toBe("");
    expect(momentSearchParams({})).toBe("");
  });
});
