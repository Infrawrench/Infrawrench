import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Metric alert evaluation tests, modelled on `budget-eval.test.ts`: the
 * window maths are covered pure in `metric-alert-window.test.ts`; this suite
 * covers the pipeline — open-claim dedupe, cooldown suppression, the resolve
 * claim, recovery notifications, and notifiedAt accounting. ClickHouse is
 * mocked at the reader boundary and the selector at its module boundary.
 */

const sendPushToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0 }));
vi.mock("../push/dispatch", () => ({ sendPushToOrg }));

const sendSlackToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
vi.mock("../slack", () => ({ sendSlackToOrg }));

const sendMsTeamsToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
vi.mock("../msteams", () => ({ sendMsTeamsToOrg }));

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
      resourceId: "res1",
      resourceName: "vm-1",
      status: "firing",
      observedValue: 97,
    });
    expect(sendPushToOrg).toHaveBeenCalledWith(
      "org1",
      "metricAlerts",
      expect.objectContaining({
        data: {
          type: "metric_alert",
          orgId: "org1",
          ruleId: "rule1",
          resourceId: "res1",
          status: "firing",
        },
      }),
    );
    expect(sendSlackToOrg).toHaveBeenCalledWith("org1", "metricAlerts", expect.anything());
    expect(sendMsTeamsToOrg).toHaveBeenCalledWith("org1", "metricAlerts", expect.anything());
  });

  it("stamps notifiedAt when any transport delivers", async () => {
    insertReturning = [{ id: "evt1" }];
    sendSlackToOrg.mockResolvedValueOnce({ attempted: 1, succeeded: 1, failed: 0 });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.table === "metricAlertEvents" && "notifiedAt" in u.set)).toBe(
      true,
    );
  });

  it("leaves notifiedAt unset when every transport fails", async () => {
    insertReturning = [{ id: "evt1" }];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.filter((u) => "notifiedAt" in u.set)).toHaveLength(0);
  });

  it("does not notify when the open claim is lost (row already open elsewhere)", async () => {
    insertReturning = []; // onConflictDoNothing hit the partial unique index
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(sendPushToOrg).not.toHaveBeenCalled();
    expect(sendSlackToOrg).not.toHaveBeenCalled();
  });

  it("records but does not notify a firing inside the cooldown window", async () => {
    insertReturning = [{ id: "evt1" }];
    cooldownNotifiedCount = 1; // a notified firing for this pair within cooldownMinutes
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted).toHaveLength(1); // stored — the list UI still shows it
    expect(sendPushToOrg).not.toHaveBeenCalled();
    expect(sendSlackToOrg).not.toHaveBeenCalled();
  });

  it("ignores the cooldown check entirely when cooldownMinutes is 0", async () => {
    insertReturning = [{ id: "evt1" }];
    cooldownNotifiedCount = 5;
    await metricEval.evaluateMetricAlertRule(rule({ cooldownMinutes: 0 }), NOW);
    expect(sendPushToOrg).toHaveBeenCalledTimes(1);
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
    expect(sendPushToOrg).not.toHaveBeenCalled();
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
    expect(sendPushToOrg).toHaveBeenCalledWith(
      "org1",
      "metricAlerts",
      expect.objectContaining({
        data: expect.objectContaining({ type: "metric_alert", status: "resolved" }),
      }),
    );
  });

  it("stamps resolvedNotifiedAt when the recovery delivers", async () => {
    openEventRows = [openEvent()];
    samplesFor({ res1: breachingSamples(50) });
    updateReturning = [[{ id: "evt1" }]];
    sendSlackToOrg.mockResolvedValueOnce({ attempted: 1, succeeded: 1, failed: 0 });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => "resolvedNotifiedAt" in u.set)).toBe(true);
  });

  it("resolves quietly when the firing itself was never notified", async () => {
    openEventRows = [openEvent({ notifiedAt: null })];
    samplesFor({ res1: breachingSamples(50) });
    updateReturning = [[{ id: "evt1" }]];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(true);
    expect(sendPushToOrg).not.toHaveBeenCalled();
  });

  it("does not send a recovery when the resolve claim is lost to another replica", async () => {
    openEventRows = [openEvent()];
    samplesFor({ res1: breachingSamples(50) });
    updateReturning = [[]]; // WHERE status='firing' matched nothing
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(sendPushToOrg).not.toHaveBeenCalled();
  });

  it("keeps a still-breaching firing open without re-notifying", async () => {
    openEventRows = [openEvent()];
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates.some((u) => u.set["status"] === "resolved")).toBe(false);
    expect(sendPushToOrg).not.toHaveBeenCalled();
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
