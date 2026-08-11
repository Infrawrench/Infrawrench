import { describe, expect, it } from "vitest";
import {
  buildIncidentTimeline,
  compareIncidentTimelineEntries,
  formatIncidentDuration,
  incidentSeverityRank,
  incidentWindow,
  postmortemFilename,
  renderPostmortemMarkdown,
  type Incident,
  type IncidentArtifact,
  type IncidentMetricAlertEvent,
  type IncidentNote,
  type IncidentProbeTransition,
  type IncidentTimelineEntry,
} from "../incidents";
import type { MomentEvent } from "../moment";

const START = "2026-08-11T03:00:00.000Z";
const END = "2026-08-11T04:00:00.000Z";
const NOW = "2026-08-11T05:00:00.000Z";

function artifact(over: Partial<IncidentArtifact> = {}): IncidentArtifact {
  return {
    id: "art-1",
    kind: "freeze",
    status: "created",
    label: "Incident: checkout down",
    refId: "freeze-1",
    refSecondary: null,
    error: null,
    createdAt: START,
    updatedAt: START,
    ...over,
  };
}

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: "inc-1",
    title: "Checkout is down",
    severity: "sev1",
    status: "resolved",
    summary: "Payments 500ing.",
    startedAt: START,
    mitigatedAt: "2026-08-11T03:30:00.000Z",
    resolvedAt: END,
    declaredByUserId: "u-1",
    declaredByName: "Astrid",
    resolvedByUserId: "u-1",
    affectedResourceIds: ["res-1"],
    affectedAccountIds: [],
    issueUrl: null,
    createdAt: START,
    updatedAt: END,
    artifacts: [],
    noteCount: 0,
    ...over,
  };
}

function momentEvent(over: Partial<MomentEvent> = {}): MomentEvent {
  return {
    id: "chg-1",
    feed: "changes",
    kind: "change.updated",
    timestamp: "2026-08-11T03:10:00.000Z",
    title: "api-prod-1 changed (size)",
    severity: "warning",
    ...over,
  };
}

function emptyInput(over: Partial<Parameters<typeof buildIncidentTimeline>[0]> = {}) {
  return {
    incident: incident(),
    notes: [] as IncidentNote[],
    events: [] as MomentEvent[],
    probeTransitions: [] as IncidentProbeTransition[],
    metricAlertEvents: [] as IncidentMetricAlertEvent[],
    now: NOW,
    ...over,
  };
}

describe("incidentWindow", () => {
  it("ends at resolvedAt when the incident is resolved", () => {
    const { fromMs, toMs } = incidentWindow(incident(), NOW);
    expect(fromMs).toBe(Date.parse(START));
    expect(toMs).toBe(Date.parse(END));
  });

  it("ends at now while the incident is still open", () => {
    const { toMs } = incidentWindow(incident({ resolvedAt: null }), NOW);
    expect(toMs).toBe(Date.parse(NOW));
  });
});

describe("incidentSeverityRank", () => {
  it("ranks sev1 worst", () => {
    expect(incidentSeverityRank("sev1")).toBeLessThan(incidentSeverityRank("sev4"));
  });
});

describe("buildIncidentTimeline — the empty window", () => {
  it("still tells the story of the incident itself", () => {
    const { entries, truncated } = buildIncidentTimeline(emptyInput());
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.kind)).toEqual([
      "incident.declared",
      "incident.mitigated",
      "incident.resolved",
    ]);
  });

  it("omits mitigated and resolved for an open incident", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({ incident: incident({ status: "open", mitigatedAt: null, resolvedAt: null }) }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("incident.declared");
  });

  it("reports the window it actually used", () => {
    const { from, to } = buildIncidentTimeline(emptyInput());
    expect(from).toBe(START);
    expect(to).toBe(END);
  });
});

describe("buildIncidentTimeline — ordering across sources", () => {
  it("interleaves every source chronologically", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({
        notes: [
          {
            id: "n-1",
            body: "Rolling back",
            authorUserId: "u-1",
            authorName: "Astrid",
            occurredAt: "2026-08-11T03:20:00.000Z",
            createdAt: "2026-08-11T03:21:00.000Z",
          },
        ],
        events: [momentEvent()],
        probeTransitions: [
          {
            probeId: "p-1",
            probeName: "Checkout health",
            status: "down",
            changedAt: "2026-08-11T03:05:00.000Z",
            lastError: "502 Bad Gateway",
          },
          {
            probeId: "p-1",
            probeName: "Checkout health",
            status: "up",
            changedAt: "2026-08-11T03:40:00.000Z",
          },
        ],
        metricAlertEvents: [
          {
            eventId: "ma-1",
            ruleName: "Checkout p99",
            resourceId: "res-1",
            resourceName: "api-prod-1",
            observedValue: 1200,
            firedAt: "2026-08-11T03:15:00.000Z",
            resolvedAt: "2026-08-11T03:45:00.000Z",
          },
        ],
      }),
    );

    expect(entries.map((e) => e.kind)).toEqual([
      "incident.declared",
      "probe.down",
      "change.updated",
      "metric-alert.fired",
      "note",
      "incident.mitigated",
      "probe.up",
      "metric-alert.resolved",
      "incident.resolved",
    ]);
  });

  it("drops anything outside the window, however it was passed in", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({
        events: [
          momentEvent({ id: "before", timestamp: "2026-08-11T02:00:00.000Z" }),
          momentEvent({ id: "after", timestamp: "2026-08-11T04:30:00.000Z" }),
          momentEvent({ id: "inside", timestamp: "2026-08-11T03:10:00.000Z" }),
        ],
      }),
    );
    const momentIds = entries.filter((e) => e.source === "moment").map((e) => e.id);
    expect(momentIds).toEqual(["moment:inside"]);
  });

  it("is deterministic when two sources share a timestamp", () => {
    const at = "2026-08-11T03:10:00.000Z";
    const input = emptyInput({
      events: [momentEvent({ timestamp: at })],
      probeTransitions: [
        { probeId: "p-1", probeName: "Checkout health", status: "down", changedAt: at },
      ],
      notes: [
        {
          id: "n-1",
          body: "Paged",
          authorUserId: null,
          authorName: null,
          occurredAt: at,
          createdAt: at,
        },
      ],
    });
    const first = buildIncidentTimeline(input).entries.map((e) => e.id);
    const second = buildIncidentTimeline(input).entries.map((e) => e.id);
    expect(first).toEqual(second);
    // Source order decides ties: note (1) before moment (3) before probe (4).
    expect(first.slice(1, 4)).toEqual(["note:n-1", "moment:chg-1", `probe:p-1:${at}`]);
  });

  it("renames the provider-incident link kind so it cannot be confused with ours", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({
        events: [
          momentEvent({
            id: "pi-1",
            feed: "statusIncidents",
            kind: "incident.started",
            link: { kind: "incident", id: "provider-1", url: "https://status.example" },
          }),
        ],
      }),
    );
    const entry = entries.find((e) => e.id === "moment:pi-1");
    expect(entry?.link?.kind).toBe("provider-incident");
    expect(entry?.link?.url).toBe("https://status.example");
  });

  it("truncates to the limit rather than returning an unbounded list", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      momentEvent({
        id: `chg-${i}`,
        timestamp: `2026-08-11T03:${String(i + 10).padStart(2, "0")}:00.000Z`,
      }),
    );
    const { entries, truncated } = buildIncidentTimeline(emptyInput({ events, limit: 5 }));
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(5);
  });
});

describe("buildIncidentTimeline — artefacts, including the ones that failed", () => {
  it("shows a created artefact at its creation time", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({ incident: incident({ artifacts: [artifact()] }) }),
    );
    const entry = entries.find((e) => e.source === "artifact");
    expect(entry).toMatchObject({ kind: "artifact.created", title: "Change freeze created" });
  });

  it("surfaces a failed artefact with its error, at critical severity", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({
        incident: incident({
          artifacts: [
            artifact({
              id: "art-2",
              kind: "slack",
              status: "failed",
              refId: null,
              label: null,
              error: "channel_not_found",
              updatedAt: "2026-08-11T03:00:05.000Z",
            }),
          ],
        }),
      }),
    );
    const entry = entries.find((e) => e.kind === "artifact.failed");
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Slack could not be created");
    expect(entry!.detail).toBe("channel_not_found");
    expect(entry!.severity).toBe("critical");
  });

  it("never loses the incident because an artefact failed", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({
        incident: incident({
          artifacts: [
            artifact({ id: "a", kind: "freeze", status: "failed", error: "403 forbidden" }),
            artifact({ id: "b", kind: "status-page", status: "failed", error: "page not found" }),
            artifact({ id: "c", kind: "moment", status: "created", label: "±30m" }),
          ],
        }),
      }),
    );
    expect(entries.some((e) => e.kind === "incident.declared")).toBe(true);
    expect(entries.filter((e) => e.kind === "artifact.failed")).toHaveLength(2);
    expect(entries.filter((e) => e.kind === "artifact.created")).toHaveLength(1);
  });

  it("records a closed artefact at the time it closed", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({
        incident: incident({
          artifacts: [artifact({ status: "closed", updatedAt: "2026-08-11T03:59:00.000Z" })],
        }),
      }),
    );
    const entry = entries.find((e) => e.kind === "artifact.closed");
    expect(entry?.at).toBe("2026-08-11T03:59:00.000Z");
  });
});

describe("compareIncidentTimelineEntries", () => {
  const entry = (over: Partial<IncidentTimelineEntry>): IncidentTimelineEntry => ({
    id: "x",
    source: "moment",
    kind: "k",
    at: START,
    title: "t",
    severity: "info",
    ...over,
  });

  it("sorts unparseable timestamps last", () => {
    const sorted = [entry({ id: "bad", at: "not a date" }), entry({ id: "good" })].sort(
      compareIncidentTimelineEntries,
    );
    expect(sorted.map((e) => e.id)).toEqual(["good", "bad"]);
  });

  it("treats equivalent instants with different offsets as equal in time", () => {
    const a = entry({ id: "a", at: "2026-08-11T03:00:00.000Z", source: "note" });
    const b = entry({ id: "b", at: "2026-08-11T05:00:00.000+02:00", source: "probe" });
    // Same instant, so the source order decides: note (1) before probe (4).
    expect([b, a].sort(compareIncidentTimelineEntries).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("formatIncidentDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatIncidentDuration(START, "2026-08-11T04:42:00.000Z")).toBe("1h 42m");
  });

  it("formats days", () => {
    expect(formatIncidentDuration(START, "2026-08-13T04:00:00.000Z")).toBe("2d 1h");
  });

  it("says so when the span is under a minute", () => {
    expect(formatIncidentDuration(START, "2026-08-11T03:00:20.000Z")).toBe("under a minute");
  });

  it("returns a dash rather than a negative duration", () => {
    expect(formatIncidentDuration(END, START)).toBe("—");
  });
});

describe("renderPostmortemMarkdown", () => {
  it("pre-fills the facts and leaves judgement blank", () => {
    const { entries } = buildIncidentTimeline(
      emptyInput({ events: [momentEvent()], incident: incident({ artifacts: [artifact()] }) }),
    );
    const markdown = renderPostmortemMarkdown({
      incident: incident({ artifacts: [artifact()] }),
      timeline: entries,
      resources: [{ resourceId: "res-1", displayName: "api-prod-1", pluginId: "aws" }],
      notes: [
        {
          id: "n-1",
          body: "Rolled back",
          authorUserId: "u-1",
          authorName: "Astrid",
          occurredAt: "2026-08-11T03:20:00.000Z",
          createdAt: "2026-08-11T03:20:00.000Z",
        },
      ],
      incidentUrl: "https://app.example/org/o/incidents/inc-1",
    });

    expect(markdown).toContain("# Checkout is down");
    expect(markdown).toContain("| Duration | 1h |");
    expect(markdown).toContain("| Time to mitigate | 30m |");
    expect(markdown).toContain("- api-prod-1 (aws)");
    expect(markdown).toContain("api-prod-1 changed (size)");
    expect(markdown).toContain("Rolled back");
    expect(markdown).toContain("- Change freeze: created (Incident: checkout down)");
    expect(markdown).toContain("## Root cause");
    expect(markdown).toContain("- [ ] ");
  });

  it("says so plainly when there is nothing to report", () => {
    const markdown = renderPostmortemMarkdown({
      incident: incident({ artifacts: [] }),
      timeline: [],
      resources: [],
      notes: [],
    });
    expect(markdown).toContain("_None recorded._");
    expect(markdown).toContain("_Nothing was recorded in the incident window._");
    expect(markdown).toContain("_No operator notes were written._");
  });

  it("escapes pipes so a title cannot break the timeline table", () => {
    const markdown = renderPostmortemMarkdown({
      incident: incident(),
      timeline: [
        {
          id: "e",
          source: "note",
          kind: "note",
          at: START,
          title: "grep 'a|b' broke it",
          severity: "info",
        },
      ],
      resources: [],
      notes: [],
    });
    expect(markdown).toContain("grep 'a\\|b' broke it");
  });
});

describe("postmortemFilename", () => {
  it("slugs the title and dates the file", () => {
    expect(postmortemFilename({ title: "Checkout is DOWN!", startedAt: START })).toBe(
      "postmortem-2026-08-11-checkout-is-down.md",
    );
  });

  it("falls back when the title has nothing sluggable in it", () => {
    expect(postmortemFilename({ title: "!!!", startedAt: START })).toBe(
      "postmortem-2026-08-11-incident.md",
    );
  });
});
