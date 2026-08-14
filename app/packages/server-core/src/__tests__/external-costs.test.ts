import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Validation and mapping for cost rows a server pushes over the API. The
 * important invariant is the reserved `infrawrench:source` tag: it is what
 * keeps a pushed batch's ReplacingMergeTree key disjoint from provider-collected
 * rows, so attributing spend to a real account can never overwrite the poller's
 * data — and what keeps two sources from overwriting each other.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const insertCostRows = vi.fn(async (_rows: Array<Record<string, unknown>>) => undefined);
const hashTags = vi.fn((tags: Record<string, string> | undefined) => JSON.stringify(tags ?? {}));
vi.mock("../clickhouse/cost-writers", () => ({ insertCostRows, hashTags }));

const isClickHouseConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({ isClickHouseConfigured }));

// Real Drizzle over a recording driver: the org-membership check renders its
// actual SQL (and shadow-validates under test:postgres:shadow).
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** Account rows the org-membership check finds. Keys in projection order. */
function knownAccounts(rows: Array<{ id: string }>) {
  pg.setRows(rows);
}

let mod: typeof import("../cost/external-costs");

const ROW = { date: "2026-07-01", currency: "USD", amount: 10 };

async function write(rows: unknown[], source = "snowflake-invoices") {
  return mod.writeExternalCostRows({
    organizationId: "org1",
    source,
    rows: rows as never,
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
  mod = await import("../cost/external-costs");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeExternalCostRows", () => {
  it("maps a row onto cost_daily and stamps the reserved source tag", async () => {
    const result = await write([{ ...ROW, service: "Snowflake", tags: { team: "data" } }]);
    expect(result).toEqual({ written: 1 });
    expect(inserted()[0]).toMatchObject({
      organization_id: "org1",
      account_id: "external:snowflake-invoices",
      plugin_id: "external",
      day: "2026-07-01",
      service: "Snowflake",
      currency: "USD",
      amount: 10,
      tags: { team: "data", "infrawrench:source": "snowflake-invoices" },
    });
  });

  it("attributes a row to a connected account when asked", async () => {
    knownAccounts([{ id: "acc1" }]);
    await write([{ ...ROW, accountId: "acc1" }]);
    expect(inserted()[0]).toMatchObject({ account_id: "acc1", plugin_id: "external" });
    // Still tagged — this is what keeps the key disjoint from AWS's own rows.
    expect(inserted()[0]?.["tags"]).toMatchObject({ "infrawrench:source": "snowflake-invoices" });
  });

  it("keeps two sources on disjoint keys for the same account and day", async () => {
    knownAccounts([{ id: "acc1" }]);
    await write([{ ...ROW, accountId: "acc1" }], "source-a");
    const first = inserted()[0];
    insertCostRows.mockClear();
    await write([{ ...ROW, accountId: "acc1" }], "source-b");
    const second = insertCostRows.mock.calls[0]?.[0]?.[0];
    expect(first?.["tags_hash"]).not.toEqual(second?.["tags_hash"]);
  });

  it("rejects an accountId from outside the organization without writing anything", async () => {
    knownAccounts([]);
    await expect(write([{ ...ROW, accountId: "someone-elses" }])).rejects.toThrow(
      /not an account in this organization/,
    );
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("rejects reserved tag keys", async () => {
    await expect(write([{ ...ROW, tags: { "infrawrench:source": "spoofed" } }])).rejects.toThrow(
      /reserved tag key/,
    );
  });

  it.each([
    ["a malformed date", { ...ROW, date: "07/01/2026" }],
    ["an impossible date", { ...ROW, date: "2026-02-31" }],
    ["a bad currency", { ...ROW, currency: "dollars" }],
    ["a non-finite amount", { ...ROW, amount: Number.NaN }],
    ["a non-string service", { ...ROW, service: 5 }],
  ])("rejects %s, naming the row", async (_label, row) => {
    await expect(write([ROW, row])).rejects.toThrow(/costs\/rows: row 1/);
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it.each(["", "has a space", "-leading-dash", "a".repeat(65)])(
    "rejects the source %j",
    async (source) => {
      await expect(write([ROW], source)).rejects.toThrow(/source must be/);
      expect(insertCostRows).not.toHaveBeenCalled();
    },
  );

  it("uppercases the currency", async () => {
    await write([{ ...ROW, currency: "usd" }]);
    expect(inserted()[0]?.["currency"]).toBe("USD");
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
    await expect(write(Array.from({ length: 5001 }, () => ROW))).rejects.toThrow(
      /at most 5000 rows per call/,
    );
  });

  it("fails clearly when cost storage isn't configured", async () => {
    isClickHouseConfigured.mockReturnValue(false);
    await expect(write([ROW])).rejects.toThrow(/Cost storage is not configured/);
  });
});

describe("external cost account ids", () => {
  it("round-trips a source name", async () => {
    const ids = await import("../cost/external-cost-ids");
    const id = ids.externalCostAccountId("colo");
    expect(id).toBe("external:colo");
    expect(ids.sourceFromCostAccountId(id)).toBe("colo");
  });

  it("returns null for a real account id", async () => {
    const ids = await import("../cost/external-cost-ids");
    expect(ids.sourceFromCostAccountId("acc1")).toBeNull();
  });
});
