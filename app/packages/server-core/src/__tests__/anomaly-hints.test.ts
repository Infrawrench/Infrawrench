import { describe, expect, it, vi } from "vitest";

// Only the pure half is under test; the module's I/O wrapper drags in the db
// client, which insists on a DATABASE_URL at import time.
vi.mock("../db/client", () => ({ db: {} }));

import {
  anomalyHintWindow,
  composeAnomalyHints,
  MAX_ANOMALY_HINTS,
  type AuditHintEntry,
  type ChangeAggregate,
} from "../cost/anomaly-hints";

/**
 * The pure half of root-cause hints: ranking and phrasing. The I/O wrapper
 * (`buildAnomalyHints`) is exercised through the evaluator's suite, where it
 * is mocked at the module boundary — what these tests pin down is that the
 * evidence reads the way a human would summarize it, and that the cap and
 * the ranking hold whatever the window contained.
 */

function created(resourceTypeId: string, count: number): ChangeAggregate {
  return { changeKind: "created", resourceTypeId, count };
}

function audit(action: string, overrides: Partial<AuditHintEntry> = {}): AuditHintEntry {
  return { action, actorName: "Astrid", entityName: null, ...overrides };
}

describe("anomalyHintWindow", () => {
  it("covers the anomalous day and the whole day before, UTC", () => {
    const { from, to } = anomalyHintWindow("2026-07-28");
    expect(from.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });
});

describe("composeAnomalyHints — change timeline", () => {
  it("aggregates appearances by resource type, plural and singular", () => {
    const hints = composeAnomalyHints([created("gce-instance", 12), created("gcs-bucket", 1)], []);
    expect(hints).toEqual(["12 gce-instance resources appeared", "a gcs-bucket resource appeared"]);
  });

  it("ranks creations above deletions above updates, whatever the counts", () => {
    const hints = composeAnomalyHints(
      [
        { changeKind: "updated", resourceTypeId: "k8s-deployment", count: 40 },
        { changeKind: "deleted", resourceTypeId: "droplet", count: 3 },
        created("gce-instance", 2),
      ],
      [],
    );
    expect(hints).toEqual([
      "2 gce-instance resources appeared",
      "3 droplet resources were removed",
      "40 k8s-deployment resources changed",
    ]);
  });

  it("caps the list and keeps the biggest buckets", () => {
    const hints = composeAnomalyHints(
      [created("a", 1), created("b", 9), created("c", 5), created("d", 7)],
      [],
    );
    expect(hints).toHaveLength(MAX_ANOMALY_HINTS);
    expect(hints[0]).toBe("9 b resources appeared");
    expect(hints).not.toContain("a a resource appeared");
  });
});

describe("composeAnomalyHints — audit log", () => {
  it("names the actor and the workflow, and counts repeats", () => {
    const run = audit("workflow.run", { entityName: "Nightly rebuild" });
    expect(composeAnomalyHints([], [run])).toEqual(['Astrid ran workflow "Nightly rebuild"']);
    expect(composeAnomalyHints([], [run, run, run])).toEqual([
      'Astrid ran workflow "Nightly rebuild" 3 times',
    ]);
  });

  it("keeps two actors running the same workflow as two hints", () => {
    const hints = composeAnomalyHints(
      [],
      [
        audit("workflow.run", { entityName: "Scale up" }),
        audit("workflow.run", { actorName: "Bram", entityName: "Scale up" }),
      ],
    );
    expect(hints).toEqual(['Astrid ran workflow "Scale up"', 'Bram ran workflow "Scale up"']);
  });

  it("says a change freeze was lifted, and ranks it above resource churn", () => {
    const hints = composeAnomalyHints(
      [{ changeKind: "updated", resourceTypeId: "droplet", count: 30 }],
      [audit("change_freeze.end", { entityName: "Prod freeze" })],
    );
    expect(hints[0]).toBe('Astrid lifted change freeze "Prod freeze" early');
  });

  it("attributes API-key actors without inventing a name", () => {
    const hints = composeAnomalyHints([], [audit("workflow.run", { actorName: null })]);
    expect(hints).toEqual(["an API key ran a workflow"]);
  });

  it("collapses schedule create/update/delete into one phrase per actor", () => {
    const hints = composeAnomalyHints(
      [],
      [
        audit("resource_schedule.create"),
        audit("resource_schedule.update"),
        audit("resource_schedule.delete"),
      ],
    );
    expect(hints).toEqual(["Astrid changed a sleep/wake schedule"]);
  });

  it("counts in-app resource creations per actor", () => {
    const hints = composeAnomalyHints(
      [],
      [audit("resource.create"), audit("resource.create"), audit("resource.create")],
    );
    expect(hints).toEqual(["Astrid created 3 resources from Infrawrench"]);
  });

  it("ignores actions with no phrasing rather than guessing one", () => {
    // Callers pre-filter on HINT_AUDIT_ACTIONS; an unmapped action reaching
    // here (a new allowlist entry without a phrase) must degrade to silence.
    expect(composeAnomalyHints([], [audit("page.clear")])).toEqual([]);
  });
});

describe("composeAnomalyHints — merged ranking", () => {
  it("answers the empty window with no hints", () => {
    expect(composeAnomalyHints([], [])).toEqual([]);
  });

  it("mixes both sources and never exceeds the cap", () => {
    const hints = composeAnomalyHints(
      [created("gce-instance", 12), { changeKind: "deleted", resourceTypeId: "disk", count: 2 }],
      [
        audit("change_freeze.end"),
        audit("workflow.run", { entityName: "Scale up" }),
        audit("deployment.plan"),
      ],
    );
    expect(hints).toHaveLength(MAX_ANOMALY_HINTS);
    // The strongest fact from each source survives the cap.
    expect(hints).toContain("12 gce-instance resources appeared");
    expect(hints).toContain("Astrid lifted a change freeze early");
  });
});
