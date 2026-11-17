import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const { ANALYTICS_RETENTION } = await import("../db/analytics-schema");
const { pruneAnalytics, RETENTION_BATCH_SIZE, MAX_RETENTION_BATCHES_PER_TABLE } =
  await import("../analytics/retention");

/** `n` rows, which the fake hands back from a DELETE as its affected rows. */
function deleted(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, () => ({}));
}

/** The statements that deleted from `table`. */
function deletesFrom(table: string) {
  return pg.queries.filter((q) => q.sql.includes(`DELETE FROM "${table}"`));
}

describe("pruneAnalytics", () => {
  beforeEach(() => {
    pg.reset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("prunes every table in ANALYTICS_RETENTION once when nothing has expired", async () => {
    const results = await pruneAnalytics();

    expect(results.map((r) => r.table)).toEqual([
      "metric_points_raw",
      "metric_points_1m",
      "metric_points_1h",
      "dashboard_stats",
      "account_resource_counts",
      "poll_outcomes",
      "cost_daily",
      "network_flow_daily",
      "ai_request_daily",
      "ai_cost_attributed",
    ]);
    expect(results.length).toBe(ANALYTICS_RETENTION.length);
    expect(results.every((r) => r.deleted === 0 && !r.truncated && !r.error)).toBe(true);
    // A short (empty) first batch drains a table: one statement each.
    expect(pg.queries).toHaveLength(ANALYTICS_RETENTION.length);
  });

  it("deletes in bounded, lock-skipping batches picked by ctid", async () => {
    await pruneAnalytics();

    const [statement] = deletesFrom("metric_points_raw");
    expect(statement!.sql).toContain(`WHERE ctid IN (`);
    expect(statement!.sql).toContain(`SELECT ctid FROM "metric_points_raw"`);
    expect(statement!.sql).toContain(`FOR UPDATE SKIP LOCKED`);
    expect(statement!.sql).toMatch(/"metric_points_raw"\."ts" < now\(\) - interval '7 days'/);
    expect(statement!.params).toContain(RETENTION_BATCH_SIZE);
  });

  it("compares day columns against a date cutoff so their indexes stay usable", async () => {
    await pruneAnalytics();

    expect(deletesFrom("cost_daily")[0]!.sql).toMatch(
      /"cost_daily"\."day" < \(now\(\) - interval '3 years'\)::date/,
    );
    expect(deletesFrom("network_flow_daily")[0]!.sql).toMatch(
      /"network_flow_daily"\."day" < \(now\(\) - interval '90 days'\)::date/,
    );
    // Instants are compared as instants, with no cast.
    expect(deletesFrom("poll_outcomes")[0]!.sql).not.toContain("::date");
  });

  it("keeps deleting while batches come back full, and stops on a short one", async () => {
    pg.queueRows(deleted(RETENTION_BATCH_SIZE));
    pg.queueRows(deleted(RETENTION_BATCH_SIZE));
    pg.queueRows(deleted(12));

    const results = await pruneAnalytics();

    expect(deletesFrom("metric_points_raw")).toHaveLength(3);
    expect(results[0]).toEqual({
      table: "metric_points_raw",
      deleted: 2 * RETENTION_BATCH_SIZE + 12,
      truncated: false,
    });
    // The next table starts fresh.
    expect(deletesFrom("metric_points_1m")).toHaveLength(1);
  });

  it("stops a table at the batch ceiling and says it has rows left", async () => {
    for (let i = 0; i < MAX_RETENTION_BATCHES_PER_TABLE; i++) {
      pg.queueRows(deleted(RETENTION_BATCH_SIZE));
    }

    const results = await pruneAnalytics();

    expect(deletesFrom("metric_points_raw")).toHaveLength(MAX_RETENTION_BATCHES_PER_TABLE);
    expect(results[0]).toMatchObject({
      deleted: MAX_RETENTION_BATCHES_PER_TABLE * RETENTION_BATCH_SIZE,
      truncated: true,
    });
    expect(deletesFrom("metric_points_1m")).toHaveLength(1);
  });

  it("logs a failing table and carries on with the rest", async () => {
    const execute = pg.db.execute.bind(pg.db);
    vi.spyOn(pg.db, "execute").mockImplementation(((query: Parameters<typeof execute>[0]) => {
      if (pg.queries.length === 0) {
        pg.queries.push({ sql: "failed", params: [], method: "execute" });
        return Promise.reject(new Error("canceling statement due to lock timeout"));
      }
      return execute(query);
    }) as typeof pg.db.execute);

    const results = await pruneAnalytics();

    expect(results[0]).toMatchObject({
      table: "metric_points_raw",
      error: "canceling statement due to lock timeout",
    });
    expect(results.slice(1).every((r) => r.error === undefined)).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });
});
