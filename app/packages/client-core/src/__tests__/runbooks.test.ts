import { describe, expect, it } from "vitest";

import {
  RUNBOOK_LIMITS,
  isSafeRunbookUrl,
  nextPendingStep,
  normalizeRunbookSteps,
  runbookMatchesResource,
  runbookProgress,
  validateRunbookInput,
  type RunbookRunStep,
  type RunbookStepInput,
} from "../runbooks";

function step(overrides: Partial<RunbookRunStep> = {}): RunbookRunStep {
  return {
    stepId: "s1",
    title: "Do the thing",
    kind: "manual",
    status: "pending",
    note: null,
    workflowRunId: null,
    actorUserId: null,
    actorName: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("validateRunbookInput", () => {
  it("accepts a minimal runbook", () => {
    expect(validateRunbookInput({ name: "Failover" })).toBeNull();
  });

  it("requires a name", () => {
    expect(validateRunbookInput({ name: "  " })).toBe("A name is required.");
  });

  it("rejects an over-long name", () => {
    expect(validateRunbookInput({ name: "x".repeat(RUNBOOK_LIMITS.nameMaxLength + 1) })).toContain(
      "Name must be",
    );
  });

  it("rejects a tag value with no key", () => {
    expect(validateRunbookInput({ name: "A", tagValue: "prod" })).toBe(
      "A tag value needs a tag key.",
    );
  });

  it("names the offending step by position", () => {
    expect(
      validateRunbookInput({
        name: "A",
        steps: [
          { kind: "manual", title: "First" },
          { kind: "manual", title: "" },
        ],
      }),
    ).toBe("Step 2 needs a title.");
  });

  it("requires a workflow on a workflow step", () => {
    expect(
      validateRunbookInput({ name: "A", steps: [{ kind: "workflow", title: "Fail over" }] }),
    ).toBe("Step 1 runs a workflow, so it needs one selected.");
  });

  it("requires an https URL on a link step", () => {
    expect(validateRunbookInput({ name: "A", steps: [{ kind: "link", title: "Console" }] })).toBe(
      "Step 1 is a link, so it needs a URL.",
    );
    expect(
      validateRunbookInput({
        name: "A",
        steps: [{ kind: "link", title: "Console", url: "javascript:alert(1)" }],
      }),
    ).toContain("https://");
  });
});

describe("isSafeRunbookUrl", () => {
  it("accepts https and nothing else", () => {
    expect(isSafeRunbookUrl("https://console.aws.amazon.com")).toBe(true);
    // A runbook link is authored by one colleague and clicked by another
    // mid-incident — the worst possible moment to be discerning.
    expect(isSafeRunbookUrl("http://internal.example.com")).toBe(false);
    expect(isSafeRunbookUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRunbookUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeRunbookUrl("not a url")).toBe(false);
  });
});

describe("normalizeRunbookSteps", () => {
  let counter = 0;
  const makeId = () => `generated-${++counter}`;

  it("keeps existing ids and assigns ids to new steps", () => {
    counter = 0;
    const steps: RunbookStepInput[] = [
      { id: "kept", kind: "manual", title: " Trim me " },
      { kind: "manual", title: "New" },
    ];
    const result = normalizeRunbookSteps(steps, makeId);
    expect(result[0]?.id).toBe("kept");
    expect(result[0]?.title).toBe("Trim me");
    expect(result[1]?.id).toBe("generated-1");
  });

  it("drops the reference belonging to the other kind", () => {
    // A step switched from link to workflow that kept its URL would render a
    // button pointing somewhere nobody meant.
    counter = 0;
    const result = normalizeRunbookSteps(
      [{ kind: "workflow", title: "Run it", workflowId: "wf1", url: "https://example.com" }],
      makeId,
    );
    expect(result[0]?.workflowId).toBe("wf1");
    expect(result[0]).not.toHaveProperty("url");
  });

  it("defaults an absent body to empty rather than undefined", () => {
    counter = 0;
    expect(normalizeRunbookSteps([{ kind: "manual", title: "T" }], makeId)[0]?.body).toBe("");
  });
});

describe("runbookProgress", () => {
  it("is zero for an empty run", () => {
    expect(runbookProgress([])).toMatchObject({ total: 0, percent: 0, pending: 0 });
  });

  it("counts a skipped step as settled but not as done", () => {
    // Otherwise a responder reaches 100% by skipping everything, and the
    // number people glance at stops meaning "nothing is waiting on me".
    const progress = runbookProgress([
      step({ stepId: "a", status: "done" }),
      step({ stepId: "b", status: "skipped" }),
      step({ stepId: "c", status: "pending" }),
      step({ stepId: "d", status: "failed" }),
    ]);
    expect(progress).toMatchObject({
      total: 4,
      done: 1,
      skipped: 1,
      failed: 1,
      pending: 1,
      percent: 75,
    });
  });

  it("reaches 100 only when nothing is pending", () => {
    expect(
      runbookProgress([step({ status: "done" }), step({ stepId: "b", status: "skipped" })]).percent,
    ).toBe(100);
  });
});

describe("nextPendingStep", () => {
  it("returns the first step still waiting", () => {
    expect(
      nextPendingStep([
        step({ stepId: "a", status: "done" }),
        step({ stepId: "b", status: "pending" }),
        step({ stepId: "c", status: "pending" }),
      ])?.stepId,
    ).toBe("b");
  });

  it("is null when everything has settled", () => {
    expect(nextPendingStep([step({ status: "skipped" })])).toBeNull();
  });
});

describe("runbookMatchesResource", () => {
  const base = { resourceTypeIds: [], tagKey: null, tagValue: null, enabled: true };

  it("an empty selector matches everything", () => {
    expect(runbookMatchesResource(base, { resourceTypeId: "droplet" })).toBe(true);
  });

  it("a disabled runbook matches nothing", () => {
    expect(runbookMatchesResource({ ...base, enabled: false }, { resourceTypeId: "droplet" })).toBe(
      false,
    );
  });

  it("narrows by resource type", () => {
    const book = { ...base, resourceTypeIds: ["rds-instance", "droplet"] };
    expect(runbookMatchesResource(book, { resourceTypeId: "droplet" })).toBe(true);
    expect(runbookMatchesResource(book, { resourceTypeId: "s3-bucket" })).toBe(false);
  });

  it("matches the tag key case-insensitively and the value exactly", () => {
    // Providers disagree about tag-key case; a value is a value.
    const book = { ...base, tagKey: "Environment", tagValue: "prod" };
    expect(
      runbookMatchesResource(book, { resourceTypeId: "droplet", tags: { environment: "prod" } }),
    ).toBe(true);
    expect(
      runbookMatchesResource(book, { resourceTypeId: "droplet", tags: { environment: "Prod" } }),
    ).toBe(false);
    expect(runbookMatchesResource(book, { resourceTypeId: "droplet", tags: {} })).toBe(false);
  });

  it("treats a key with no value as a presence check", () => {
    const book = { ...base, tagKey: "owner", tagValue: null };
    expect(
      runbookMatchesResource(book, { resourceTypeId: "droplet", tags: { owner: "anyone" } }),
    ).toBe(true);
  });
});
