import { describe, expect, it } from "vitest";
import {
  incidentHasRetryableArtifacts,
  isIncidentArtifactFailure,
  planIncidentArtifactRetry,
  stripControlCharacters,
  buildIncidentTimeline,
  type Incident,
  type IncidentArtifact,
} from "../incidents";

/**
 * Regressions for three review findings, each of which was a real bug:
 *
 * 1. A close that failed left the artefact in `created`, so the retry path —
 *    which selects on status — could never see it. The incident sat resolved
 *    with a live change freeze and nothing in the product able to lift it.
 * 2. Retrying a failed status-page notice passed an empty component list, so
 *    the republished notice covered the whole page instead of the components
 *    the operator picked. A retry silently widened a customer-visible outage.
 * 3. Control characters in operator-supplied text reached a terminal verbatim.
 */

const START = "2026-08-11T03:00:00.000Z";
const END = "2026-08-11T04:00:00.000Z";

function artifact(over: Partial<IncidentArtifact> = {}): IncidentArtifact {
  return {
    id: "art-1",
    kind: "freeze",
    status: "created",
    label: null,
    refId: "freeze-1",
    refSecondary: null,
    error: null,
    request: null,
    createdAt: START,
    updatedAt: START,
    ...over,
  };
}

function incident(artifacts: IncidentArtifact[]): Incident {
  return {
    id: "inc-1",
    title: "Checkout is down",
    severity: "sev1",
    status: "resolved",
    summary: null,
    startedAt: START,
    mitigatedAt: null,
    resolvedAt: END,
    declaredByUserId: null,
    declaredByName: null,
    resolvedByUserId: null,
    affectedResourceIds: [],
    affectedAccountIds: [],
    issueUrl: null,
    createdAt: START,
    updatedAt: END,
    artifacts,
    noteCount: 0,
  };
}

describe("a close that failed is retryable (finding 1)", () => {
  it("counts as a failure state", () => {
    expect(isIncidentArtifactFailure("close_failed")).toBe(true);
    expect(isIncidentArtifactFailure("failed")).toBe(true);
    expect(isIncidentArtifactFailure("created")).toBe(false);
    expect(isIncidentArtifactFailure("closed")).toBe(false);
  });

  it("is planned for RE-CLOSING, never for re-creation", () => {
    // The bug: this artefact used to stay `created` with an error attached, so
    // the retry path saw nothing to do and the freeze stayed up forever.
    const plan = planIncidentArtifactRetry(
      incident([
        artifact({
          status: "close_failed",
          error: "Could not lift: upstream 500",
          updatedAt: END,
        }),
      ]),
    );
    expect(plan.reclose.map((a) => a.kind)).toEqual(["freeze"]);
    // Re-creating would open a SECOND freeze — worse than the failure it fixes.
    expect(plan.recreate).toEqual([]);
  });

  it("plans creation and closure independently when both went wrong", () => {
    const plan = planIncidentArtifactRetry(
      incident([
        artifact({ id: "a", kind: "slack", status: "failed", error: "channel_not_found" }),
        artifact({ id: "b", kind: "freeze", status: "close_failed", error: "boom" }),
        artifact({ id: "c", kind: "moment", status: "created" }),
        artifact({ id: "d", kind: "status-page", status: "closed" }),
      ]),
    );
    expect(plan.recreate.map((a) => a.kind)).toEqual(["slack"]);
    expect(plan.reclose.map((a) => a.kind)).toEqual(["freeze"]);
  });

  it("plans nothing when everything is healthy", () => {
    const healthy = incident([
      artifact({ id: "a", status: "created" }),
      artifact({ id: "b", kind: "status-page", status: "closed" }),
    ]);
    const plan = planIncidentArtifactRetry(healthy);
    expect(plan.recreate).toEqual([]);
    expect(plan.reclose).toEqual([]);
    expect(incidentHasRetryableArtifacts(healthy)).toBe(false);
  });

  it("is visible on the timeline as a critical entry naming the consequence", () => {
    const { entries } = buildIncidentTimeline({
      incident: incident([
        artifact({
          kind: "freeze",
          status: "close_failed",
          error: "Could not lift: upstream 500",
          updatedAt: "2026-08-11T03:59:00.000Z",
        }),
      ]),
      notes: [],
      events: [],
      probeTransitions: [],
      metricAlertEvents: [],
      now: END,
    });
    const entry = entries.find((e) => e.kind === "artifact.close_failed");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("critical");
    // "still open" is the bit an operator needs — the freeze is still blocking.
    expect(entry!.title).toContain("still open");
    expect(entry!.detail).toBe("Could not lift: upstream 500");
  });
});

describe("a status-page retry keeps its original scope (finding 2)", () => {
  it("carries the components the operator picked on the failed artefact", () => {
    const plan = planIncidentArtifactRetry(
      incident([
        artifact({
          kind: "status-page",
          status: "failed",
          refId: null,
          error: "status page unreachable",
          request: { statusPageId: "page-1", componentIds: ["comp-a", "comp-b"] },
        }),
      ]),
    );
    const [retry] = plan.recreate;
    expect(retry?.request?.statusPageId).toBe("page-1");
    // The bug: this used to come back empty, and an empty component list on a
    // status page means the WHOLE page is reported as affected.
    expect(retry?.request?.componentIds).toEqual(["comp-a", "comp-b"]);
  });

  it("keeps an intentionally page-wide notice page-wide", () => {
    const plan = planIncidentArtifactRetry(
      incident([
        artifact({
          kind: "status-page",
          status: "failed",
          refId: null,
          request: { statusPageId: "page-1", componentIds: [] },
        }),
      ]),
    );
    expect(plan.recreate[0]?.request?.componentIds).toEqual([]);
  });
});

describe("stripControlCharacters (finding 3)", () => {
  // Every control character is written as an escape so this file stays plain
  // text — a test for control-character handling that embeds raw control bytes
  // is a file no reviewer can read and most tools call binary.
  const ESC = "\u001b";

  it("removes the sequences that let a title drive a terminal", () => {
    // Erase-display, cursor-home, and an OSC window-title set.
    const hostile = `Checkout${ESC}[2J${ESC}[Hdown${ESC}]0;pwned\u0007`;
    expect(stripControlCharacters(hostile)).toBe("Checkout[2J[Hdown]0;pwned");
    expect(stripControlCharacters(hostile)).not.toContain(ESC);
    expect(stripControlCharacters(hostile)).not.toContain("\u0007");
  });

  it("removes carriage returns, which overwrite the line already printed", () => {
    expect(stripControlCharacters("real\rfake")).toBe("realfake");
  });

  it("removes C1 controls, which are a second way in on some terminals", () => {
    expect(stripControlCharacters("a\u009bm b")).toBe("am b");
  });

  it("keeps newlines and tabs — a summary is allowed paragraphs", () => {
    expect(stripControlCharacters("line one\nline two\tindented")).toBe(
      "line one\nline two\tindented",
    );
  });

  it("leaves ordinary text, including non-ASCII, exactly alone", () => {
    expect(stripControlCharacters("Checkout — 500s · café 🙂")).toBe("Checkout — 500s · café 🙂");
  });
});
