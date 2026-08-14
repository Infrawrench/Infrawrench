import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Budget-triggered workflows: threshold comparison, the once-per-crossing claim
 * on `workflows.budget_last_fired_key`, and the `infra.event` payload handed to
 * the run. The DB and the runner are both mocked — this is about the decision,
 * not the plumbing.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const runOrgWorkflow = vi.fn(async () => ({ runId: "r1", result: {} }));
vi.mock("../workflows/runner", () => ({ runOrgWorkflow }));

// Real Drizzle over a recording driver: the conditional claim UPDATE renders
// its actual SQL (and shadow-validates under test:postgres:shadow). Its rows
// are the `returning({ id })` result; [] means someone else won.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The claim UPDATEs issued. Params: [key, updatedAt, workflowId, key again]. */
const claims = () => pg.queries.filter((q) => q.sql.startsWith('update "workflows"'));

let mod: typeof import("../workflows/budget-triggers");

const BUDGET = { id: "b1", name: "Cloud spend", amountCents: 100_000, currency: "USD" };

function workflow(trigger: Record<string, unknown>) {
  return { id: "wf1", organizationId: "org1", trigger: { kind: "budget", ...trigger } };
}

async function fire(
  trigger: Record<string, unknown>,
  status: { month: string; actualCents: number; forecastCents: number | null },
) {
  await mod.fireBudgetTriggerWorkflows({
    organizationId: "org1",
    budget: BUDGET,
    status,
    candidates: [workflow(trigger)],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  pg.setRows([{ id: "wf1" }]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mod = await import("../workflows/budget-triggers");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireBudgetTriggerWorkflows", () => {
  const july = { month: "2026-07", actualCents: 60_000, forecastCents: 120_000 };

  it("runs the workflow when actual spend reaches the threshold", async () => {
    await fire({ budgetId: "b1", percent: 50 }, july);
    expect(runOrgWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        workflowId: "wf1",
        triggerSource: "budget",
        event: expect.objectContaining({
          kind: "budget",
          budgetId: "b1",
          budgetName: "Cloud spend",
          metric: "actual",
          percent: 50,
          observedCents: 60_000,
          actualCents: 60_000,
          forecastCents: 120_000,
          month: "2026-07",
          currency: "USD",
          amountCents: 100_000,
        }),
      }),
    );
  });

  it("does not run below the threshold", async () => {
    await fire({ budgetId: "b1", percent: 80 }, july);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("defaults to 100% of actual spend", async () => {
    await fire({ budgetId: "b1" }, july);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
    await fire({ budgetId: "b1" }, { ...july, actualCents: 100_000 });
    expect(runOrgWorkflow).toHaveBeenCalledTimes(1);
  });

  it("compares against the forecast when asked", async () => {
    await fire({ budgetId: "b1", metric: "forecast" }, july);
    expect(runOrgWorkflow).toHaveBeenCalledTimes(1);
    expect(claims()[0]?.params[0]).toBe("2026-07:forecast:100");
  });

  it("skips a null forecast rather than treating it as zero", async () => {
    await fire(
      { budgetId: "b1", metric: "forecast", percent: 1 },
      { ...july, forecastCents: null },
    );
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("keys the claim by month, measure and percent", async () => {
    await fire({ budgetId: "b1", percent: 50 }, july);
    const claim = claims()[0]!;
    // set "budget_last_fired_key" = $1 ... where id = $3 and key IS DISTINCT FROM $4
    expect(claim.sql).toContain('"budget_last_fired_key" IS DISTINCT FROM');
    expect(claim.params[0]).toBe("2026-07:actual:50");
    expect(claim.params[2]).toBe("wf1");
    expect(claim.params[3]).toBe("2026-07:actual:50");
  });

  it("does not run when another replica already claimed the crossing", async () => {
    pg.setRows([]);
    await fire({ budgetId: "b1", percent: 50 }, july);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("ignores workflows pointed at a different budget", async () => {
    await fire({ budgetId: "other", percent: 1 }, july);
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("ignores a budget with no amount", async () => {
    await mod.fireBudgetTriggerWorkflows({
      organizationId: "org1",
      budget: { ...BUDGET, amountCents: 0 },
      status: july,
      candidates: [workflow({ budgetId: "b1", percent: 1 })],
    });
    expect(runOrgWorkflow).not.toHaveBeenCalled();
  });

  it("never throws when a run fails", async () => {
    runOrgWorkflow.mockRejectedValueOnce(new Error("sandbox exploded"));
    await expect(fire({ budgetId: "b1", percent: 50 }, july)).resolves.toBeUndefined();
  });
});
