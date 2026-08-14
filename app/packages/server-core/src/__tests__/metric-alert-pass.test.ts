import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The metric-alert pass's claim protocol, in the style of the poller's
 * `claim.test.ts`: real Drizzle over a recording driver renders the claim
 * statement and the reschedule UPDATEs, so the statement text and bound
 * values are asserted directly from the captured queries (and shadow-validate
 * under test:postgres:shadow); the evaluator is mocked at its module boundary.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const evaluateMetricAlertRule = vi.fn();
vi.mock("../metric-alerts/eval", () => ({
  evaluateMetricAlertRule: (...a: unknown[]) => evaluateMetricAlertRule(...a),
}));

const { METRIC_ALERT_LEASE_MS, claimDueMetricAlertRules, runMetricAlertPass } =
  await import("../metric-alerts/pass");

/** The reschedule UPDATEs issued, as rendered statements against metric_alert_rules. */
const reschedules = () => pg.queries.filter((q) => q.sql.startsWith('update "metric_alert_rules"'));

function dbRow(id: string) {
  return {
    id,
    organization_id: "org1",
    name: "High CPU",
    plugin_id: "aws",
    resource_type_id: null,
    tag_key: null,
    tag_value: null,
    metric_key: "CPU %",
    comparator: ">",
    threshold: 90,
    for_minutes: 15,
    cooldown_minutes: 60,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pg.reset();
  evaluateMetricAlertRule.mockResolvedValue(undefined);
});

describe("claimDueMetricAlertRules", () => {
  it("claims with SKIP LOCKED and writes the lease into next_eval_at", async () => {
    await claimDueMetricAlertRules(8);
    const q = pg.lastQuery();
    expect(q.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(q.sql).toContain("UPDATE metric_alert_rules");
    expect(q.sql).toContain("SET next_eval_at = now()");
    expect(q.sql).toContain("enabled = true");
    expect(q.sql).toContain("deleted_at IS NULL");
    expect(q.sql).toContain("next_eval_at IS NULL OR next_eval_at <= now()");
    expect(q.params).toEqual([METRIC_ALERT_LEASE_MS, 8]);
  });

  it("maps snake_case rows to the rule shape", async () => {
    pg.queueRows([dbRow("r1")]);
    const rules = await claimDueMetricAlertRules(1);
    expect(rules).toEqual([
      expect.objectContaining({
        id: "r1",
        organizationId: "org1",
        pluginId: "aws",
        resourceTypeId: null,
        metricKey: "CPU %",
        comparator: ">",
        threshold: 90,
        forMinutes: 15,
        cooldownMinutes: 60,
      }),
    ]);
  });
});

describe("runMetricAlertPass", () => {
  it("evaluates each claimed rule and replaces the lease with the true cadence", async () => {
    pg.queueRows([dbRow("r1"), dbRow("r2")]);
    const outcome = await runMetricAlertPass({ limit: 8 });
    expect(outcome).toEqual({ claimed: 2 });
    expect(evaluateMetricAlertRule).toHaveBeenCalledTimes(2);
    // Both rules rescheduled: lastEvalAt + nextEvalAt written.
    expect(reschedules()).toHaveLength(2);
    for (const q of reschedules()) {
      // set last_eval_at = $1, next_eval_at = $2 where id = $3
      expect(q.sql).toContain('"last_eval_at"');
      expect(q.sql).toContain('"next_eval_at"');
    }
    expect(
      reschedules()
        .map((q) => q.params[2])
        .sort(),
    ).toEqual(["r1", "r2"]);
  });

  it("does nothing when no rules are due", async () => {
    const outcome = await runMetricAlertPass();
    expect(outcome).toEqual({ claimed: 0 });
    expect(evaluateMetricAlertRule).not.toHaveBeenCalled();
  });

  it("never throws when the claim fails", async () => {
    const executeSpy = vi.spyOn(pg.db, "execute").mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMetricAlertPass()).resolves.toEqual({ claimed: 0 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    executeSpy.mockRestore();
  });

  it("still reschedules other rules when one evaluation rejects", async () => {
    pg.queueRows([dbRow("r1"), dbRow("r2")]);
    evaluateMetricAlertRule.mockRejectedValueOnce(new Error("boom"));
    await runMetricAlertPass();
    // r1's reschedule is skipped (its lease bounds the retry); r2 completes.
    expect(reschedules()).toHaveLength(1);
  });

  it("keeps the lease when the reschedule write fails", async () => {
    pg.queueRows([dbRow("r1")]);
    const updateSpy = vi.spyOn(pg.db, "update").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMetricAlertPass()).resolves.toEqual({ claimed: 1 });
    expect(errSpy).toHaveBeenCalledWith(
      "[metric-alerts] rule r1 reschedule failed:",
      expect.any(Error),
    );
    errSpy.mockRestore();
    updateSpy.mockRestore();
  });
});
