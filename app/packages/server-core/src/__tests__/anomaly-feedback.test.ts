import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts: vi.fn() }));

import {
  anomalyFeedbackButtons,
  buildSensitivityAdjustments,
  parseAnomalyFeedbackButtonValue,
  planSetAside,
  scopeFilter,
  setAsideFor,
  sigmaMap,
  sigmasFor,
  type EvalSuppression,
} from "../cost/anomaly-feedback";

const DAYS = ["2026-10-02", "2026-10-03", "2026-10-04"];

function sup(overrides: Partial<EvalSuppression>): EvalSuppression {
  return {
    id: "s1",
    scope: "service",
    scopeKey: "Amazon EC2",
    tagKey: null,
    recurrence: "one_off",
    anchorDay: "2026-10-01",
    startsOn: "2026-10-01",
    expiresOn: "2026-10-08",
    ...overrides,
  };
}

describe("planSetAside", () => {
  it("sets the whole day aside in memory when the scope is the breakdown itself", () => {
    const { exact, reads } = planSetAside([sup({})], DAYS);
    const ctx = { sigmas: new Map(), setAside: exact };
    expect(setAsideFor(ctx, "service", "Amazon EC2", "USD", "2026-10-03")).toEqual({
      amount: Infinity,
      suppressionId: "s1",
    });
    // The provider breakdown has to read what the service spent.
    expect(reads).toEqual([
      { suppression: expect.objectContaining({ id: "s1" }), dimension: "provider", days: DAYS },
    ]);
  });

  it("reads an account scope from both breakdowns, for covered days only", () => {
    // 2026-10-03 is a Saturday; weekly from a Saturday covers only it.
    const s = sup({
      scope: "account",
      scopeKey: "acct-1",
      recurrence: "weekly",
      anchorDay: "2026-09-26",
    });
    const { exact, reads } = planSetAside([s], DAYS);
    expect(exact.size).toBe(0);
    expect(reads.map((r) => [r.dimension, r.days])).toEqual([
      ["provider", ["2026-10-03"]],
      ["service", ["2026-10-03"]],
    ]);
  });

  it("ignores a suppression that covers none of the judged days", () => {
    const { exact, reads } = planSetAside(
      [sup({ startsOn: "2026-11-01", expiresOn: "2026-11-30" })],
      DAYS,
    );
    expect(exact.size).toBe(0);
    expect(reads).toEqual([]);
  });
});

describe("scopeFilter", () => {
  it("compiles tag scopes with their key", () => {
    expect(scopeFilter(sup({ scope: "tag", scopeKey: "launch", tagKey: "team" }))).toEqual([
      { dimension: "tag", op: "in", values: ["launch"], tagKey: "team" },
    ]);
  });
});

describe("sensitivity", () => {
  it("moves only keys with enough expected feedback and no unexpected verdict", () => {
    const counts = [
      { dimension: "service" as const, dimensionKey: "EC2", expected: 3, unexpected: 0 },
      { dimension: "service" as const, dimensionKey: "S3", expected: 5, unexpected: 1 },
      { dimension: "provider" as const, dimensionKey: "gcp", expected: 1, unexpected: 0 },
    ];
    const map = sigmaMap(counts, 3);
    const ctx = { sigmas: map, setAside: new Map() };
    expect(sigmasFor(ctx, "service", "EC2", 3)).toBe(4);
    expect(sigmasFor(ctx, "service", "S3", 3)).toBe(3);
    expect(sigmasFor(ctx, "provider", "gcp", 3)).toBe(3);

    const adjustments = buildSensitivityAdjustments(counts, 3);
    expect(adjustments[0]).toMatchObject({ dimensionKey: "EC2", sigmas: 4 });
    expect(adjustments.find((a) => a.dimensionKey === "S3")?.explanation).toMatch(/^Held at 3σ/);
  });
});

describe("Slack buttons", () => {
  it("round-trips the org and anomaly through the button value", () => {
    const [expected] = anomalyFeedbackButtons("org-1", "anom-1");
    expect(parseAnomalyFeedbackButtonValue(expected!.value)).toEqual({
      organizationId: "org-1",
      anomalyId: "anom-1",
    });
    expect(parseAnomalyFeedbackButtonValue("{not json")).toBeNull();
    expect(parseAnomalyFeedbackButtonValue(JSON.stringify({ o: "org" }))).toBeNull();
  });
});
