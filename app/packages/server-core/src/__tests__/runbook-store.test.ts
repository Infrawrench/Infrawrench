import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Three behaviours here are the ones a reviewer should be able to see proved,
 * because each of them is a decision rather than an implementation detail:
 *
 * - a patch is validated **after** merging, so changing only the steps still
 *   has to leave a runbook that is valid as a whole;
 * - the name conflict comes from the unique index rather than a pre-check,
 *   because check-then-insert loses the race — and the race is two people
 *   writing up the same incident afterwards;
 * - starting a run **snapshots** every step, so rewriting the runbook next week
 *   cannot rewrite the history of what somebody was asked to do.
 */

/** Rows the fake db returns, keyed by the table a query selects from. */
const selectResults = new Map<string, unknown[]>();
const inserted: { table: string; values: unknown }[] = [];
const updated: { table: string; values: unknown }[] = [];
let insertError: Error | null = null;

function tableName(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    s.description?.includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "";
}

function selectBuilder(name = ""): unknown {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"]) {
    chain[method] = (arg: unknown) => (method === "from" ? selectBuilder(tableName(arg)) : chain);
  }
  chain["then"] = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve().then(() => resolve(selectResults.get(name) ?? []));
  return chain;
}

function fakeDb() {
  return {
    select: () => selectBuilder(),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (insertError) return Promise.reject(insertError);
        inserted.push({ table: tableName(table), values });
        return Promise.resolve([]);
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          updated.push({ table: tableName(table), values });
          return Promise.resolve([]);
        },
      }),
    }),
    delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: "r1" }]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb()),
  };
}

vi.mock("../db/client", () => ({ db: fakeDb() }));

const { RunbookInputError, createRunbook, updateRunbook } = await import("../runbooks/store");
const { startRunbookRun } = await import("../runbooks/runs");

const existingRunbook = {
  id: "rb1",
  name: "Failover",
  description: null,
  steps: [
    { id: "s1", kind: "manual", title: "Page the DBA", body: "" },
    { id: "s2", kind: "manual", title: "Promote the replica", body: "" },
  ],
  resourceTypeIds: "rds-instance",
  tagKey: "env",
  tagValue: "prod",
  enabled: true,
  createdByUserId: null,
  createdByName: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  runCount: 0,
  lastRunAt: null,
};

beforeEach(() => {
  selectResults.clear();
  inserted.length = 0;
  updated.length = 0;
  insertError = null;
  selectResults.set("runbooks", [existingRunbook]);
});

describe("createRunbook", () => {
  it("rejects an invalid runbook with the editor's own message", async () => {
    // Same function the form previews with, so the two cannot disagree.
    await expect(
      createRunbook("org", { name: "A", steps: [{ kind: "workflow", title: "Go" }] }, null),
    ).rejects.toThrow("Step 1 runs a workflow, so it needs one selected.");
  });

  it("assigns ids to new steps", async () => {
    selectResults.set("runbooks", []);
    // The follow-up read returns nothing, so creation throws after inserting —
    // the insert is what this asserts on.
    await createRunbook(
      "org",
      { name: "New", steps: [{ kind: "manual", title: "Tick me" }] },
      "user-1",
    ).catch(() => {});
    const values = inserted.find((row) => row.table === "runbooks")?.values as {
      steps: { id: string }[];
    };
    expect(values.steps[0]?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("turns the unique-index violation into a message about the name", async () => {
    selectResults.set("runbooks", []);
    insertError = new Error(
      'duplicate key value violates unique constraint "runbooks_org_name_unique"',
    );
    await expect(createRunbook("org", { name: "Failover" }, null)).rejects.toThrow(
      'A runbook called "Failover" already exists.',
    );
  });
});

describe("updateRunbook", () => {
  it("validates the merged result, not the patch", async () => {
    // The patch alone says nothing about tags; the merged runbook still has a
    // tag key, so clearing only the key must fail on the leftover value.
    await expect(updateRunbook("org", "rb1", { tagKey: null })).rejects.toThrow(
      "A tag value needs a tag key.",
    );
  });

  it("keeps fields the patch does not mention", async () => {
    await updateRunbook("org", "rb1", { enabled: false });
    const values = updated.find((row) => row.table === "runbooks")?.values as {
      name: string;
      enabled: boolean;
      resourceTypeIds: string;
    };
    expect(values.name).toBe("Failover");
    expect(values.enabled).toBe(false);
    expect(values.resourceTypeIds).toBe("rds-instance");
  });

  it("preserves a step's id, so a run in progress still matches it", async () => {
    await updateRunbook("org", "rb1", {
      steps: [{ id: "s1", kind: "manual", title: "Page the DBA (renamed)" }],
    });
    const values = updated.find((row) => row.table === "runbooks")?.values as {
      steps: { id: string }[];
    };
    expect(values.steps[0]?.id).toBe("s1");
  });

  it("404s on a runbook that is not there", async () => {
    selectResults.set("runbooks", []);
    await expect(updateRunbook("org", "missing", { name: "X" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("startRunbookRun", () => {
  it("copies each step's title into the run rather than pointing at it", async () => {
    // The whole reason the run's steps are a table: rewriting the runbook next
    // week must not rewrite what somebody was asked to do at 03:14.
    await startRunbookRun({ organizationId: "org", runbookId: "rb1", userId: "u1" }).catch(
      () => {},
    );
    const steps = inserted.find((row) => row.table === "runbook_run_steps")?.values as {
      title: string;
      stepId: string;
      position: number;
      status: string;
    }[];
    expect(steps.map((s) => s.title)).toEqual(["Page the DBA", "Promote the replica"]);
    expect(steps.map((s) => s.position)).toEqual([0, 1]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("copies the runbook's name onto the run", async () => {
    await startRunbookRun({ organizationId: "org", runbookId: "rb1", userId: "u1" }).catch(
      () => {},
    );
    const run = inserted.find((row) => row.table === "runbook_runs")?.values as {
      runbookName: string;
    };
    expect(run.runbookName).toBe("Failover");
  });

  it("refuses a runbook with no steps rather than starting an empty run", async () => {
    selectResults.set("runbooks", [{ ...existingRunbook, steps: [] }]);
    await expect(
      startRunbookRun({ organizationId: "org", runbookId: "rb1", userId: null }),
    ).rejects.toThrow("nothing to run");
  });

  it("404s on an unknown runbook", async () => {
    selectResults.set("runbooks", []);
    await expect(
      startRunbookRun({ organizationId: "org", runbookId: "nope", userId: null }),
    ).rejects.toBeInstanceOf(RunbookInputError);
  });
});
