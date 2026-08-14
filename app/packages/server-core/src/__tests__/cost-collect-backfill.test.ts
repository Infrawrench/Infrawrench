import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `collectAccountCosts` decides when an account stops backfilling history and
 * settles into the short restatement window. Getting that wrong is invisible
 * in production — the account looks healthy and simply never fetches the days
 * it skipped — so the flag write is pinned here.
 *
 * Everything external is mocked or faked: the DB (real Drizzle over a
 * recording driver, so the flag UPDATE renders its actual SQL), the
 * account/plugin/client loader, and the ClickHouse writers.
 *
 * "Today" is frozen mid-month so a short history window stays inside one
 * calendar month. Without that, near the 1st the same windows span two months
 * and `monthChunks` yields two fetches — each mock returns a row, so
 * `rowCount` becomes 2 and these assertions flake.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The flag writes issued, as the rendered UPDATE statements against accounts. */
const updates = () => pg.queries.filter((q) => q.sql.startsWith('update "accounts"'));

const insertCostRows = vi.fn(async () => undefined);
vi.mock("../clickhouse/cost-writers", () => ({
  insertCostRows,
  toCostDailyRows: (_meta: unknown, rows: unknown[]) => rows,
}));

const fetchCostData = vi.fn();
const loadAccountClient = vi.fn();
vi.mock("../sync-resources", () => ({ loadAccountClient }));

const { collectAccountCosts } = await import("../cost/collect");

/** One cost row; the shape only matters to the mocked writers. */
const row = { date: "2026-07-10", currency: "USD", amount: 1 };

function setup(costBackfilledAt: Date | null) {
  loadAccountClient.mockResolvedValue({
    account: { pluginId: "gcp", costBackfilledAt },
    // A short history keeps the backfill to a single month chunk (with the
    // frozen mid-month "today" below).
    plugin: { manifest: { costs: { maxHistoryDays: 10, restatementDays: 5 } } },
    client: { fetchCostData },
  });
}

beforeEach(() => {
  pg.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Mid-month so maxHistoryDays=10 and restatementDays=5 never cross a month
  // boundary (see file header).
  vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("collectAccountCosts backfill flag", () => {
  it("marks the backfill done once rows are ingested", async () => {
    setup(null);
    fetchCostData.mockResolvedValue([row]);

    const result = await collectAccountCosts("acc-1", "org-1");

    expect(result).toMatchObject({ backfilled: true, rowCount: 1 });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.sql).toContain('"cost_backfilled_at"');
    // set cost_backfilled_at = $1, updated_at = $2 where id = $3
    expect(updates()[0]!.params[2]).toBe("acc-1");
  });

  it("leaves the flag unset when the first backfill returns nothing", async () => {
    setup(null);
    fetchCostData.mockResolvedValue([]);

    const result = await collectAccountCosts("acc-1", "org-1");

    // The account stays in backfill mode, so the history it is waiting on is
    // still fetched once the provider starts reporting it.
    expect(result).toMatchObject({ backfilled: false, rowCount: 0 });
    expect(updates()).toEqual([]);
    expect(insertCostRows).not.toHaveBeenCalled();
  });

  it("does not rewrite the flag for an account already backfilled", async () => {
    setup(new Date("2026-07-01T00:00:00.000Z"));
    fetchCostData.mockResolvedValue([row]);

    const result = await collectAccountCosts("acc-1", "org-1");

    expect(result).toMatchObject({ backfilled: false, rowCount: 1 });
    expect(updates()).toEqual([]);
  });
});
