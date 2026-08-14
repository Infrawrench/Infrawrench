/**
 * Integration tests against a real ClickHouse server. Skipped unless the four
 * CLICKHOUSE_METRICS_* env vars are set (`pnpm test:clickhouse`); point them at
 * a scratch server — docker-compose.dev.yml publishes one on
 * http://localhost:8124 — never at production. Rows are written under random
 * per-run ids and deleted best-effort afterwards (the tables' TTLs mop up the
 * rest), but DDL from migrateMetrics() is permanent.
 *
 * These cover what the unit tests' fake driver cannot: that the DDL actually
 * creates, that inserted rows survive the server's parsing of JSONEachRow
 * bodies (writers swallow errors, so a rejected insert is invisible in prod),
 * and that the materialized-view rollups feed the 1m readers.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClickHouseClient, isClickHouseConfigured } from "../../clickhouse/client";
import { migrateMetrics } from "../../clickhouse/migrate";
import {
  getLatestAccountCounts,
  getLatestMetrics,
  getLatestStats,
  getMetricMinuteSeriesBatch,
  getMetricRange,
} from "../../clickhouse/readers";
import {
  flattenMetricSeries,
  insertAccountResourceCounts,
  insertDashboardStats,
  insertMetricPoints,
} from "../../clickhouse/writers";

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-acct-${randomUUID()}`;
const resourceId = `test-res-${randomUUID()}`;

/** The client inserts with wait_for_async_insert=0, so force the queue down. */
async function flushAsyncInserts(): Promise<void> {
  await getClickHouseClient().command({ query: "SYSTEM FLUSH ASYNC INSERT QUEUE" });
}

/**
 * Re-read until the predicate holds or 15s pass, then hand the last value to
 * the caller's assertions so a timeout fails on the real shape, not on "timed
 * out". Needed because even a flushed async insert can lag a beat.
 */
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!isClickHouseConfigured())("clickhouse against a real server", () => {
  // Points a whole number of minutes apart land in distinct 1m buckets, and
  // all inside getLatestMetrics's 1-hour window.
  const now = Date.now();
  const pointTimes = [now - 3 * 60_000, now - 2 * 60_000, now - 60_000];

  beforeAll(async () => {
    await migrateMetrics();
  });

  afterAll(async () => {
    if (!isClickHouseConfigured()) return;
    const ch = getClickHouseClient();
    for (const table of [
      "metric_points_raw",
      "metric_points_1m",
      "metric_points_1h",
      "dashboard_stats",
      "account_resource_counts",
    ]) {
      try {
        await ch.command({
          query: `DELETE FROM ${table} WHERE organization_id = {org:String}`,
          query_params: { org: orgId },
        });
      } catch {
        // Best effort — the tables' TTLs expire test rows regardless.
      }
    }
    await ch.close();
  });

  it("applies the schema idempotently", async () => {
    // beforeAll already ran it once against a fresh (or existing) database;
    // the second run must no-op cleanly, as it does on every prod boot.
    await migrateMetrics();
  });

  it("round-trips metric points through the raw table", async () => {
    const rows = flattenMetricSeries(
      {
        organizationId: orgId,
        accountId,
        resourceId,
        pluginId: "postgres",
        resourceTypeId: "postgres-database",
      },
      [
        {
          label: "CPU",
          unit: "%",
          points: pointTimes.map((timestamp, i) => ({ timestamp, value: 10 * (i + 1) })),
        },
      ],
    );
    await insertMetricPoints(rows);
    await flushAsyncInserts();

    const series = await waitFor(
      () => getLatestMetrics(orgId, resourceId),
      (s) => (s?.[0]?.points.length ?? 0) === 3,
    );
    expect(series).not.toBeNull();
    expect(series).toHaveLength(1);
    expect(series![0]!.label).toBe("CPU");
    expect(series![0]!.unit).toBe("%");
    expect(series![0]!.points.map((p) => p.value)).toEqual([10, 20, 30]);
    // ts is DateTime64(3): timestamps must come back millisecond-exact.
    expect(series![0]!.points.map((p) => p.timestamp)).toEqual(pointTimes);
  });

  it("feeds the 1m rollup through the materialized view", async () => {
    const byResource = await waitFor(
      () => getMetricMinuteSeriesBatch(orgId, [resourceId], "CPU", now - 10 * 60_000, now),
      (m) => (m.get(resourceId)?.length ?? 0) === 3,
    );
    const samples = byResource.get(resourceId);
    expect(samples).toBeDefined();
    // One point per minute, so each minute's avgMerge is the point itself.
    expect(samples!.map((s) => s.value)).toEqual([10, 20, 30]);
  });

  it("serves the raw path of getMetricRange", async () => {
    const series = await getMetricRange(orgId, resourceId, now - 60 * 60_000, now);
    expect(series).toHaveLength(1);
    expect(series[0]!.points.map((p) => p.value)).toEqual([10, 20, 30]);
  });

  it("round-trips a dashboard stats snapshot", async () => {
    const stats = [{ label: "Size", value: "1.2 GB", variant: "status-healthy" as const }];
    await insertDashboardStats({
      organizationId: orgId,
      accountId,
      resourceId,
      ts: new Date(now),
      stats,
    });
    await flushAsyncInserts();

    const read = await waitFor(
      () => getLatestStats(orgId, resourceId),
      (s) => s !== null,
    );
    expect(read).toEqual(stats);
  });

  it("round-trips an account resource-count snapshot", async () => {
    const counts = [
      { typeLabel: "Database", count: 2 },
      { typeLabel: "Bucket", count: 5 },
    ];
    await insertAccountResourceCounts({
      organizationId: orgId,
      accountId,
      ts: new Date(now),
      counts,
    });
    await flushAsyncInserts();

    const read = await waitFor(
      () => getLatestAccountCounts(orgId, accountId),
      (c) => c !== null,
    );
    expect(read).toEqual(counts);
  });
});
