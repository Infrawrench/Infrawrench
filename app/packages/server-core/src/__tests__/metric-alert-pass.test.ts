import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The metric-alert pass's claim protocol, in the style of the poller's
 * `claim.test.ts`: the drizzle `sql` tag is replaced by a capture object so
 * the statement text and bound values can be asserted directly, and the
 * evaluator is mocked at its module boundary.
 */

const execute = vi.fn();
const updateWhere = vi.fn();
const updateSet = vi.fn((_v: unknown) => ({ where: updateWhere }));
const update = vi.fn((_t: unknown) => ({ set: updateSet }));
vi.mock("../db/client", () => ({
  db: {
    execute: (q: unknown) => execute(q),
    update: (t: unknown) => update(t),
  },
}));

vi.mock("../db/schema", () => ({
  metricAlertRules: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

const evaluateMetricAlertRule = vi.fn();
vi.mock("../metric-alerts/eval", () => ({
  evaluateMetricAlertRule: (...a: unknown[]) => evaluateMetricAlertRule(...a),
}));

const { METRIC_ALERT_LEASE_MS, claimDueMetricAlertRules, runMetricAlertPass } =
  await import("../metric-alerts/pass");

interface CapturedSql {
  strings: string[];
  values: unknown[];
}

function capturedSql(): CapturedSql {
  return execute.mock.calls[0]![0] as CapturedSql;
}

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
  execute.mockResolvedValue([]);
  updateWhere.mockResolvedValue(undefined);
  evaluateMetricAlertRule.mockResolvedValue(undefined);
});

describe("claimDueMetricAlertRules", () => {
  it("claims with SKIP LOCKED and writes the lease into next_eval_at", async () => {
    await claimDueMetricAlertRules(8);
    const q = capturedSql();
    const text = q.strings.join("?");
    expect(text).toContain("FOR UPDATE SKIP LOCKED");
    expect(text).toContain("UPDATE metric_alert_rules");
    expect(text).toContain("SET next_eval_at = now()");
    expect(text).toContain("enabled = true");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("next_eval_at IS NULL OR next_eval_at <= now()");
    expect(q.values).toEqual([METRIC_ALERT_LEASE_MS, 8]);
  });

  it("maps snake_case rows to the rule shape", async () => {
    execute.mockResolvedValue([dbRow("r1")]);
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
    execute.mockResolvedValue([dbRow("r1"), dbRow("r2")]);
    const outcome = await runMetricAlertPass({ limit: 8 });
    expect(outcome).toEqual({ claimed: 2 });
    expect(evaluateMetricAlertRule).toHaveBeenCalledTimes(2);
    // Both rules rescheduled: lastEvalAt + nextEvalAt written.
    expect(updateSet).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastEvalAt: expect.any(Date), nextEvalAt: expect.any(Date) }),
    );
  });

  it("does nothing when no rules are due", async () => {
    const outcome = await runMetricAlertPass();
    expect(outcome).toEqual({ claimed: 0 });
    expect(evaluateMetricAlertRule).not.toHaveBeenCalled();
  });

  it("never throws when the claim fails", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMetricAlertPass()).resolves.toEqual({ claimed: 0 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("still reschedules other rules when one evaluation rejects", async () => {
    execute.mockResolvedValue([dbRow("r1"), dbRow("r2")]);
    evaluateMetricAlertRule.mockRejectedValueOnce(new Error("boom"));
    await runMetricAlertPass();
    // r1's reschedule is skipped (its lease bounds the retry); r2 completes.
    expect(updateSet).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease when the reschedule write fails", async () => {
    execute.mockResolvedValue([dbRow("r1")]);
    updateWhere.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMetricAlertPass()).resolves.toEqual({ claimed: 1 });
    expect(errSpy).toHaveBeenCalledWith(
      "[metric-alerts] rule r1 reschedule failed:",
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
