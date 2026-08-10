import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fourth reconciliation guard, and the only one that cannot live in
 * `clickhouse/cost-reconcile.ts`: whether a pass ran *degraded* is something
 * only the plugin knows.
 *
 * Both large collectors fall back to an unattributed query when the provider
 * refuses the attributed shape — AWS on `ValidationException`, Azure on a
 * rejected `BenefitId` grouping — and that fires for a transient flap as
 * readily as for an account that can never attribute. The fallback's rows are
 * correct in total but written at a *coarser* key space, so reconciling
 * against them zeroes every attribution row for the chunk. Since a backfilled
 * account only re-fetches `restatementDays` of history, a flap that ages past
 * that window is never repaired: the attribution is destroyed for good, and
 * nothing about the account looks unhealthy afterwards.
 *
 * Mocks mirror `cost-collect-backfill.test.ts` — DB, loader and writers — plus
 * the reconciler, which is what these assertions watch.
 */

const db = {
  update: vi.fn(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  })),
};
vi.mock("../db/client", () => ({ db }));
vi.mock("../db/schema", () => ({ accounts: { id: "id" } }));
vi.mock("drizzle-orm", () => ({ eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));

const insertCostRows = vi.fn(async () => undefined);
vi.mock("../clickhouse/cost-writers", () => ({
  insertCostRows,
  toCostDailyRows: (_meta: unknown, rows: unknown[]) => rows,
}));

const reconcileCollectedChunk = vi.fn(async () => [{ tombstone: true }]);
vi.mock("../clickhouse/cost-reconcile", () => ({ reconcileCollectedChunk }));

const fetchCostData = vi.fn();
const loadAccountClient = vi.fn();
vi.mock("../sync-resources", () => ({ loadAccountClient }));

const { collectAccountCosts } = await import("../cost/collect");

const row = { date: "2026-07-10", currency: "USD", amount: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Mid-month, so the short history window stays inside one calendar month and
  // `monthChunks` yields exactly one fetch.
  vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
  loadAccountClient.mockResolvedValue({
    account: { pluginId: "aws", costBackfilledAt: new Date("2026-07-01") },
    plugin: { manifest: { costs: { maxHistoryDays: 10, restatementDays: 5 } } },
    client: { fetchCostData },
  });
});

afterEach(() => vi.useRealTimers());

describe("collectAccountCosts and degraded passes", () => {
  it("skips reconciliation for a pass the plugin flagged degraded", async () => {
    fetchCostData.mockResolvedValue({ rows: [row], degraded: true });

    const result = await collectAccountCosts("acc-1", "org-1");

    expect(reconcileCollectedChunk).not.toHaveBeenCalled();
    // The spend itself is still ingested — the fallback's rows are correct in
    // total, they are just coarser. Only the *destructive* half is suppressed.
    expect(insertCostRows).toHaveBeenCalledWith([row]);
    expect(result.rowCount).toBe(1);
  });

  it("reconciles normally for a pass that did not flag itself", async () => {
    fetchCostData.mockResolvedValue({ rows: [row] });

    await collectAccountCosts("acc-1", "org-1");

    // Absent means "not degraded". Suppressing reconciliation by default would
    // leave stale keys standing forever, which is the bug it was built for.
    expect(reconcileCollectedChunk).toHaveBeenCalledTimes(1);
    expect(insertCostRows).toHaveBeenCalledWith([row, { tombstone: true }]);
  });

  it("accepts a bare array from every plugin that never opted in", async () => {
    // The contract change has to be additive: 30-odd plugins return an array
    // and must keep behaving exactly as they did.
    fetchCostData.mockResolvedValue([row]);

    const result = await collectAccountCosts("acc-1", "org-1");

    expect(reconcileCollectedChunk).toHaveBeenCalledTimes(1);
    expect(result.rowCount).toBe(1);
  });

  it("writes nothing at all when a degraded pass also came back empty", async () => {
    fetchCostData.mockResolvedValue({ rows: [], degraded: true });

    const result = await collectAccountCosts("acc-1", "org-1");

    expect(insertCostRows).not.toHaveBeenCalled();
    expect(reconcileCollectedChunk).not.toHaveBeenCalled();
    expect(result.rowCount).toBe(0);
  });
});

describe("collectAccountCosts tells the reconciler what shape the rows are", () => {
  it("passes periodNative through, because it changes what a restated day means", async () => {
    // A monthly-native plugin files a whole month on one day. Without the flag
    // the reconciler applies the day rule, and anything stored in the month's
    // interior — the rows a collector that once dated its in-progress total to
    // a moving day left behind — stands forever.
    loadAccountClient.mockResolvedValue({
      account: { pluginId: "mistral", costBackfilledAt: new Date("2026-07-01") },
      plugin: {
        manifest: { costs: { maxHistoryDays: 10, restatementDays: 5, periodNative: true } },
      },
      client: { fetchCostData },
    });
    fetchCostData.mockResolvedValue([{ date: "2026-07-01", currency: "USD", amount: 61 }]);

    await collectAccountCosts("acc-1", "org-1");

    expect(reconcileCollectedChunk).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { periodNative: true },
    );
  });

  it("says nothing about it for a plugin that reports real daily spend", async () => {
    fetchCostData.mockResolvedValue([row]);

    await collectAccountCosts("acc-1", "org-1");

    expect(reconcileCollectedChunk).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { periodNative: undefined },
    );
  });
});
