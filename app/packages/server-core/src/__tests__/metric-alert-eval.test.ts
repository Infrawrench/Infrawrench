import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Metric alert evaluation tests, modelled on `budget-eval.test.ts`: the
 * window maths are covered pure in `metric-alert-window.test.ts`; this suite
 * covers the pipeline — open-claim dedupe, cooldown suppression, the resolve
 * claim, recovery notifications, and notifiedAt accounting. ClickHouse is
 * mocked at the reader boundary and the selector at its module boundary.
 */

const getMetricMinuteSeriesBatch = vi.fn();
vi.mock("../clickhouse/readers", () => ({ getMetricMinuteSeriesBatch }));

const resolveSelectorResources = vi.fn();
vi.mock("../metric-alerts/selector", () => ({
  resolveSelectorResources: (...a: unknown[]) => resolveSelectorResources(...a),
}));

const tables = {
  metricAlertRules: { __t: "metricAlertRules" as const, id: "id" },
  metricAlertEvents: {
    __t: "metricAlertEvents" as const,
    id: "id",
    ruleId: "ruleId",
    resourceId: "resourceId",
    resourceName: "resourceName",
    status: "status",
    notifiedAt: "notifiedAt",
    firedAt: "firedAt",
  },
};
vi.mock("../db/schema", () => tables);

/** Rows the open-events select (the one that calls .orderBy) resolves to. */
let openEventRows: unknown[] = [];
/** Count the cooldown select (awaited without .orderBy) resolves to. */
let cooldownNotifiedCount = 0;
/** Result of the open-firing insert; [{id}] = claim won, [] = already open. */
let insertReturning: Array<{ id: string }> = [];
/** Queue of results for update(...).returning() — the resolve claim. */
let updateReturning: Array<Array<{ id: string }>> = [];
const inserted: Array<Record<string, unknown>> = [];
const updates: Array<{ table: string; set: Record<string, unknown> }> = [];

const db = {
  select: () => ({
    from: () => ({
      where: () => {
        const thenable = Promise.resolve([{ n: cooldownNotifiedCount }]);
        return Object.assign(thenable, {
          orderBy: () => Promise.resolve(openEventRows),
        });
      },
    }),
  }),
  insert: (_table: { __t: string }) => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertReturning),
        }),
      };
    },
  }),
  update: (table: { __t: string }) => ({
    set: (s: Record<string, unknown>) => {
      updates.push({ table: table.__t, set: s });
      return {
        where: () => {
          const thenable = Promise.resolve([]);
          return Object.assign(thenable, {
            returning: () => Promise.resolve(updateReturning.shift() ?? []),
          });
        },
      };
    },
  }),
};
vi.mock("../db/client", () => ({ db }));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

let metricEval: typeof import("../metric-alerts/eval");

const NOW = new Date("2026-08-03T12:00:00Z");
const MINUTE = 60_000;

function rule(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rule1",
    organizationId: "org1",
    name: "High CPU",
    pluginId: "aws",
    resourceTypeId: null,
    tagKey: null,
    tagValue: null,
    metricKey: "CPU %",
    comparator: ">",
    threshold: 90,
    forMinutes: 15,
    cooldownMinutes: 60,
    enabled: true,
    nextEvalAt: null,
    lastEvalAt: null,
    createdByUserId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as never;
}

/** One sample per minute across the trailing 15m window, all at `value`. */
function breachingSamples(value = 97): Array<{ tsMs: number; value: number }> {
  return Array.from({ length: 15 }, (_, i) => ({
    tsMs: NOW.getTime() - (14 - i) * MINUTE,
    value,
  }));
}

function samplesFor(entries: Record<string, Array<{ tsMs: number; value: number }>>) {
  getMetricMinuteSeriesBatch.mockResolvedValue(new Map(Object.entries(entries)));
}

beforeEach(async () => {
  vi.clearAllMocks();
  openEventRows = [];
  cooldownNotifiedCount = 0;
  insertReturning = [];
  updateReturning = [];
  inserted.length = 0;
  updates.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resolveSelectorResources.mockResolvedValue([{ id: "res1", displayName: "vm-1" }]);
  samplesFor({ res1: breachingSamples() });
  metricEval = await import("../metric-alerts/eval");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateMetricAlertRule — opening firings", () => {
  it("opens a firing and notifies with the metricAlerts trigger and deep-link payload", async () => {
    insertReturning = [{ id: "evt1" }];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      ruleId: "rule1",
      ruleName: "High CPU",
      resourceId: "res1",
      resourceName: "vm-1",
      status: "firing",
      observedValue: 97,
    });
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        trigger: "metricAlerts",
        pushData: expect.objectContaining({ type: "metric_alert", status: "firing" }),
      }),
    );
  });

  it("stamps notifiedAt when any transport delivers", async () => {
    insertReturning = [{ id: "evt1" }];
    routeAlert.mockResolvedValueOnce(routed());
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.table === "metricAlertEvents" && "notifiedAt" in u.set)).toBe(
      true,
    );
  });

  it("leaves notifiedAt unset when every transport fails", async () => {
    insertReturning = [{ id: "evt1" }];
    routeAlert.mockResolvedValue(unroutedResult());
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.filter((u) => "notifiedAt" in u.set)).toHaveLength(0);
  });

  it("does not notify when the open claim is lost (row already open elsewhere)", async () => {
    insertReturning = []; // onConflictDoNothing hit the partial unique index
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("records but does not notify a firing inside the cooldown window", async () => {
    insertReturning = [{ id: "evt1" }];
    cooldownNotifiedCount = 1; // a notified firing for this pair within cooldownMinutes
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted).toHaveLength(1); // stored — the list UI still shows it
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("ignores the cooldown check entirely when cooldownMinutes is 0", async () => {
    insertReturning = [{ id: "evt1" }];
    cooldownNotifiedCount = 5;
    await metricEval.evaluateMetricAlertRule(rule({ cooldownMinutes: 0 }), NOW);
    expect(routeAlert).toHaveBeenCalledTimes(1);
  });

  it("does not open a firing on an insufficient window (sparse samples)", async () => {
    samplesFor({
      res1: [
        { tsMs: NOW.getTime() - MINUTE, value: 97 },
        { tsMs: NOW.getTime(), value: 98 },
      ],
    });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted).toHaveLength(0);
  });

  it("does not open a firing when the window is clear", async () => {
    samplesFor({ res1: breachingSamples(50) });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted).toHaveLength(0);
    expect(routeAlert).not.toHaveBeenCalled();
  });
});

describe("evaluateMetricAlertRule — resolving firings", () => {
  const openEvent = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "evt1",
    resourceId: "res1",
    resourceName: "vm-1",
    notifiedAt: NOW,
    ...over,
  });

  it("resolves a cleared firing and sends the recovery notification", async () => {
    openEventRows = [openEvent()];
    samplesFor({ res1: breachingSamples(50) }); // back under threshold
    updateReturning = [[{ id: "evt1" }]]; // resolve claim won
    await metricEval.evaluateMetricAlertRule(rule(), NOW);

    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(true);
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "metricAlerts",
        // A recovery is good news, so it drops to `info` — which is what lets a
        // rule wake someone for the firing and hold the all-clear till morning.
        severity: "info",
        pushData: expect.objectContaining({ status: "resolved" }),
      }),
    );
  });

  it("stamps resolvedNotifiedAt when the recovery delivers", async () => {
    openEventRows = [openEvent()];
    samplesFor({ res1: breachingSamples(50) });
    updateReturning = [[{ id: "evt1" }]];
    routeAlert.mockResolvedValueOnce(routed());
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => "resolvedNotifiedAt" in u.set)).toBe(true);
  });

  it("resolves quietly when the firing itself was never notified", async () => {
    openEventRows = [openEvent({ notifiedAt: null })];
    samplesFor({ res1: breachingSamples(50) });
    updateReturning = [[{ id: "evt1" }]];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(true);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("does not send a recovery when the resolve claim is lost to another replica", async () => {
    openEventRows = [openEvent()];
    samplesFor({ res1: breachingSamples(50) });
    updateReturning = [[]]; // WHERE status='firing' matched nothing
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("keeps a still-breaching firing open without re-notifying", async () => {
    openEventRows = [openEvent()];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(false);
    expect(routeAlert).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0); // no second row for the same pair
  });

  it("keeps an insufficient-but-breaching firing open (sparse is not recovery)", async () => {
    openEventRows = [openEvent()];
    samplesFor({ res1: [{ tsMs: NOW.getTime() - MINUTE, value: 97 }] });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(false);
  });

  it("resolves when the metric stops reporting entirely (no_data)", async () => {
    openEventRows = [openEvent()];
    samplesFor({});
    updateReturning = [[{ id: "evt1" }]];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(true);
  });

  it("resolves a firing whose resource left the selector, even if still breaching", async () => {
    openEventRows = [openEvent({ resourceId: "gone", resourceName: "old-vm" })];
    resolveSelectorResources.mockResolvedValue([]); // deleted or re-tagged
    samplesFor({ gone: breachingSamples() });
    updateReturning = [[{ id: "evt1" }]];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(true);
  });
});

describe("evaluateMetricAlertRule — resilience", () => {
  it("never throws when the ClickHouse read fails", async () => {
    getMetricMinuteSeriesBatch.mockRejectedValue(new Error("clickhouse down"));
    await expect(metricEval.evaluateMetricAlertRule(rule(), NOW)).resolves.toBeUndefined();
  });

  it("never throws when the selector fails", async () => {
    resolveSelectorResources.mockRejectedValue(new Error("db down"));
    await expect(metricEval.evaluateMetricAlertRule(rule(), NOW)).resolves.toBeUndefined();
  });

  it("queries ClickHouse once for the union of selected and open resources", async () => {
    openEventRows = [{ id: "evt9", resourceId: "gone", resourceName: "old-vm", notifiedAt: null }];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(getMetricMinuteSeriesBatch).toHaveBeenCalledTimes(1);
    const [, ids, seriesLabel] = getMetricMinuteSeriesBatch.mock.calls[0]!;
    expect(ids).toEqual(expect.arrayContaining(["res1", "gone"]));
    expect(seriesLabel).toBe("CPU %");
  });
});
