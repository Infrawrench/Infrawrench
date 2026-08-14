import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Validation and mapping for workflow-reported cost rows. The important
 * invariant is the reserved `infrawrench:workflow` tag: it is what keeps a
 * workflow's ReplacingMergeTree key disjoint from provider-collected rows, so
 * attributing spend to a real account can never overwrite the poller's data.
 */

const insertCostRows = vi.fn(async (_rows: Array<Record<string, unknown>>) => undefined);
const hashTags = vi.fn((tags: Record<string, string> | undefined) => JSON.stringify(tags ?? {}));
vi.mock("../clickhouse/cost-writers", () => ({ insertCostRows, hashTags }));

const isClickHouseConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({ isClickHouseConfigured }));

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — the
// org-membership check renders its actual SQL (and shadow-validates under
// test:postgres:shadow). `pg.setRows` feeds the account rows it finds.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

let mod: typeof import("../cost/workflow-costs");

const ROW = { date: "2026-07-01", currency: "USD", amount: 10 };

async function write(rows: unknown[], writtenSoFar = 0) {
  return mod.writeWorkflowCostRows({
    organizationId: "org1",
    workflowId: "wf1",
    rows: rows as never,
    writtenSoFar,
  });
}

/** The rows handed to ClickHouse by the first (and only) call. */
function inserted(): Array<Record<string, unknown>> {
  return insertCostRows.mock.calls[0]?.[0] ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  isClickHouseConfigured.mockReturnValue(true);
  mod = await import("../cost/workflow-costs");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeWorkflowCostRows", () => {
  it("maps a row onto cost_daily and stamps the reserved workflow tag", async () => {
    const result = await write([{ ...ROW, service: "Snowflake", tags: { team: "data" } }]);
    expect(result).toEqual({ written: 1 });
    expect(inserted()[0]).toMatchObject({
      organization_id: "org1",
      account_id: "workflow:wf1",
      plugin_id: "workflow",
      day: "2026-07-01",
      service: "Snowflake",
      currency: "USD",
      amount: 10,
      tags: { team: "data", "infrawrench:workflow": "wf1" },
    });
  });

  it("attributes a row to a connected account when asked", async () => {
    pg.setRows([{ id: "acc1" }]);
    await write([{ ...ROW, accountId: "acc1" }]);
    expect(inserted()[0]).toMatchObject({ account_id: "acc1", plugin_id: "workflow" });
    // The membership check ran against accounts, scoped to the org.
    expect(pg.lastQuery().sql).toContain('from "accounts"');
    expect(pg.lastQuery().params).toEqual(["org1", "acc1"]);
    // Still tagged — this is what keeps the key disjoint from AWS's own rows.
    expect(inserted()[0]?.["tags"]).toMatchObject({ "infrawrench:workflow": "wf1" });
  });

  it("rejects an accountId from outside the organization without writing anything", async () => {
    // default empty result: the membership check finds no account
    await expect(write([{ ...ROW, accountId: "someone-elses" }])).rejects.toThrow(
      /not an account in this organization/,
    );
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("uppercases the currency", async () => {
    await write([{ ...ROW, currency: "usd" }]);
    expect(inserted()[0]?.["currency"]).toBe("USD");
  });

  it("rejects reserved tag keys", async () => {
    await expect(write([{ ...ROW, tags: { "infrawrench:workflow": "spoofed" } }])).rejects.toThrow(
      /reserved tag key/,
    );
  });

  it.each([
    ["a malformed date", { ...ROW, date: "07/01/2026" }],
    ["an impossible date", { ...ROW, date: "2026-02-31" }],
    ["a bad currency", { ...ROW, currency: "dollars" }],
    ["a non-finite amount", { ...ROW, amount: Number.NaN }],
    ["a non-string service", { ...ROW, service: 5 }],
  ])("rejects %s", async (_label, row) => {
    await expect(write([row])).rejects.toThrow(/infra\.costs\.write: row 0/);
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("accepts negative amounts as credits", async () => {
    await write([{ ...ROW, amount: -25 }]);
    expect(inserted()[0]?.["amount"]).toBe(-25);
  });

  it("is a no-op for an empty batch", async () => {
    expect(await write([])).toEqual({ written: 0 });
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("caps rows per call", async () => {
    await expect(write(Array.from({ length: 1001 }, () => ROW))).rejects.toThrow(
      /at most 1000 rows per call/,
    );
  });

  it("caps rows per run across calls", async () => {
    await expect(write([ROW], 50_000)).rejects.toThrow(/50000 rows per run/);
  });

  it("fails clearly when cost storage isn't configured", async () => {
    isClickHouseConfigured.mockReturnValue(false);
    await expect(write([ROW])).rejects.toThrow(/Cost storage is not configured/);
  });
});

describe("workflow cost account ids", () => {
  it("round-trips a workflow id", async () => {
    const ids = await import("../cost/workflow-cost-ids");
    const id = ids.workflowCostAccountId("wf9");
    expect(id).toBe("workflow:wf9");
    expect(ids.workflowIdFromCostAccountId(id)).toBe("wf9");
  });

  it("returns null for a real account id", async () => {
    const ids = await import("../cost/workflow-cost-ids");
    expect(ids.workflowIdFromCostAccountId("acc1")).toBeNull();
  });
});
