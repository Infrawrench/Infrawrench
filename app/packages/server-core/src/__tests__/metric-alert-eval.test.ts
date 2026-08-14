import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertReachedImpl, routed, unroutedResult } from "./helpers/route-alert";
import { fakePostgres } from "./helpers/fake-postgres";

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

// Real Drizzle over a recording driver against the real schema — every
// statement renders its actual SQL (and shadow-validates under
// test:postgres:shadow). Each test queues its rows FIFO in execution order:
// the open-events select first, then the open claim's / resolve claim's
// RETURNING, then the cooldown count where the pass reaches it.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The event inserts issued, i.e. the open claims. */
const inserted = () =>
  pg.queries.filter((q) => q.sql.startsWith('insert into "metric_alert_events"'));
/** The event updates issued — stamps and resolves. */
const updates = () => pg.queries.filter((q) => q.sql.startsWith('update "metric_alert_events"'));
/** The resolve claims: updates whose SET flips status to "resolved". */
const resolveUpdates = () =>
  updates().filter(
    (u) => u.sql.split(" where ")[0]!.includes('"status"') && u.params[0] === "resolved",
  );

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
  alertReached: alertReachedImpl,
}));

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
  pg.reset();
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
    pg.queueRows([]); // no open events
    pg.queueRows([{ id: "evt1" }]); // the open claim's RETURNING — claim won
    pg.queueRows([{ n: 0 }]); // cooldown probe: nothing notified recently
    await metricEval.evaluateMetricAlertRule(rule(), NOW);

    expect(inserted()).toHaveLength(1);
    // (id), ruleId, ruleName, organizationId, resourceId, resourceName,
    // status, observedValue, firedAt — the rendered statement's column order.
    expect(inserted()[0]!.params.slice(1)).toEqual([
      "rule1",
      "High CPU",
      "org1",
      "res1",
      "vm-1",
      "firing",
      97,
      NOW.toISOString(),
    ]);
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        trigger: "metricAlerts",
        pushData: expect.objectContaining({ type: "metric_alert", status: "firing" }),
      }),
    );
  });

  it("stamps notifiedAt when any transport delivers", async () => {
    pg.queueRows([]);
    pg.queueRows([{ id: "evt1" }]);
    pg.queueRows([{ n: 0 }]);
    routeAlert.mockResolvedValueOnce(routed());
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates().some((u) => u.sql.includes('"notified_at"'))).toBe(true);
  });

  it("leaves notifiedAt unset when every transport fails", async () => {
    pg.queueRows([]);
    pg.queueRows([{ id: "evt1" }]);
    pg.queueRows([{ n: 0 }]);
    routeAlert.mockResolvedValue(unroutedResult());
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates().filter((u) => u.sql.includes('"notified_at"'))).toHaveLength(0);
  });

  it("does not notify when the open claim is lost (row already open elsewhere)", async () => {
    pg.queueRows([]);
    pg.queueRows([]); // onConflictDoNothing hit the partial unique index
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("records but does not notify a firing inside the cooldown window", async () => {
    pg.queueRows([]);
    pg.queueRows([{ id: "evt1" }]);
    pg.queueRows([{ n: 1 }]); // a notified firing for this pair within cooldownMinutes
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted()).toHaveLength(1); // stored — the list UI still shows it
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("ignores the cooldown check entirely when cooldownMinutes is 0", async () => {
    pg.queueRows([]);
    pg.queueRows([{ id: "evt1" }]);
    await metricEval.evaluateMetricAlertRule(rule({ cooldownMinutes: 0 }), NOW);
    expect(routeAlert).toHaveBeenCalledTimes(1);
    // No cooldown probe was issued at all — the open-events read stays the
    // only select of the pass.
    expect(pg.queries.filter((q) => q.sql.startsWith("select"))).toHaveLength(1);
  });

  it("does not open a firing on an insufficient window (sparse samples)", async () => {
    pg.queueRows([]);
    samplesFor({
      res1: [
        { tsMs: NOW.getTime() - MINUTE, value: 97 },
        { tsMs: NOW.getTime(), value: 98 },
      ],
    });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted()).toHaveLength(0);
  });

  it("does not open a firing when the window is clear", async () => {
    pg.queueRows([]);
    samplesFor({ res1: breachingSamples(50) });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(inserted()).toHaveLength(0);
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
    pg.queueRows([openEvent()]);
    samplesFor({ res1: breachingSamples(50) }); // back under threshold
    pg.queueRows([{ id: "evt1" }]); // resolve claim won
    await metricEval.evaluateMetricAlertRule(rule(), NOW);

    expect(resolveUpdates().length > 0).toBe(true);
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
    pg.queueRows([openEvent()]);
    samplesFor({ res1: breachingSamples(50) });
    pg.queueRows([{ id: "evt1" }]);
    routeAlert.mockResolvedValueOnce(routed());
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(updates().some((u) => u.sql.includes('"resolved_notified_at"'))).toBe(true);
  });

  it("resolves quietly when the firing itself was never notified", async () => {
    pg.queueRows([openEvent({ notifiedAt: null })]);
    samplesFor({ res1: breachingSamples(50) });
    pg.queueRows([{ id: "evt1" }]);
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(resolveUpdates().length > 0).toBe(true);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("does not send a recovery when the resolve claim is lost to another replica", async () => {
    pg.queueRows([openEvent()]);
    samplesFor({ res1: breachingSamples(50) });
    pg.queueRows([]); // WHERE status='firing' matched nothing
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("keeps a still-breaching firing open without re-notifying", async () => {
    pg.queueRows([openEvent()]);
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(resolveUpdates()).toHaveLength(0);
    expect(routeAlert).not.toHaveBeenCalled();
    expect(inserted()).toHaveLength(0); // no second row for the same pair
  });

  it("keeps an insufficient-but-breaching firing open (sparse is not recovery)", async () => {
    pg.queueRows([openEvent()]);
    samplesFor({ res1: [{ tsMs: NOW.getTime() - MINUTE, value: 97 }] });
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(resolveUpdates()).toHaveLength(0);
  });

  it("resolves when the metric stops reporting entirely (no_data)", async () => {
    pg.queueRows([openEvent()]);
    samplesFor({});
    pg.queueRows([{ id: "evt1" }]);
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(resolveUpdates().length > 0).toBe(true);
  });

  it("resolves a firing whose resource left the selector, even if still breaching", async () => {
    pg.queueRows([openEvent({ resourceId: "gone", resourceName: "old-vm" })]);
    resolveSelectorResources.mockResolvedValue([]); // deleted or re-tagged
    samplesFor({ gone: breachingSamples() });
    pg.queueRows([{ id: "evt1" }]);
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(resolveUpdates().length > 0).toBe(true);
  });
});

describe("evaluateMetricAlertRule — resilience", () => {
  it("never throws when the ClickHouse read fails", async () => {
    pg.queueRows([]); // the open-events read still runs first
    getMetricMinuteSeriesBatch.mockRejectedValue(new Error("clickhouse down"));
    await expect(metricEval.evaluateMetricAlertRule(rule(), NOW)).resolves.toBeUndefined();
  });

  it("never throws when the selector fails", async () => {
    resolveSelectorResources.mockRejectedValue(new Error("db down"));
    await expect(metricEval.evaluateMetricAlertRule(rule(), NOW)).resolves.toBeUndefined();
  });

  it("queries ClickHouse once for the union of selected and open resources", async () => {
    pg.queueRows([{ id: "evt9", resourceId: "gone", resourceName: "old-vm", notifiedAt: null }]);
    await metricEval.evaluateMetricAlertRule(rule(), NOW);
    expect(getMetricMinuteSeriesBatch).toHaveBeenCalledTimes(1);
    const [, ids, seriesLabel] = getMetricMinuteSeriesBatch.mock.calls[0]!;
    expect(ids).toEqual(expect.arrayContaining(["res1", "gone"]));
    expect(seriesLabel).toBe("CPU %");
  });
});
