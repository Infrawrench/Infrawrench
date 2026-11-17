/**
 * The metric writers and readers against a real Postgres. Skipped unless
 * DATABASE_URL is set (`pnpm test:db`); migrations already applied, scratch
 * databases only. Rows are written under random per-run ids and deleted
 * afterwards.
 *
 * These cover what the unit tests' recording driver cannot: that the rows
 * survive the server's parsing, that the readers' SQL runs against the
 * migrated schema, and above all the rollup arithmetic in
 * `insertMetricPoints`: a window sent twice must count once, and the minute and
 * hour averages must be exactly the average of the raw points under them.
 *
 * Every import is dynamic: `db/client` throws on first use without
 * DATABASE_URL, and static imports would run even for a skipped suite.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const configured = !!process.env["DATABASE_URL"];

const orgId = `test-org-${randomUUID()}`;
const accountId = `test-acct-${randomUUID()}`;
const resourceId = `test-res-${randomUUID()}`;
const rollupResourceId = `test-res-${randomUUID()}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.skipIf(!configured)("analytics tables against a real server", () => {
  let db: typeof import("../../db/client").db;
  let schema: typeof import("../../analytics/schema");
  let readers: typeof import("../../analytics/readers");
  let sloReaders: typeof import("../../analytics/slo-readers");
  let writers: typeof import("../../analytics/writers");
  let k8s: typeof import("../../analytics/k8s-efficiency-readers");

  beforeAll(async () => {
    ({ db } = await import("../../db/client"));
    schema = await import("../../analytics/schema");
    readers = await import("../../analytics/readers");
    sloReaders = await import("../../analytics/slo-readers");
    writers = await import("../../analytics/writers");
    k8s = await import("../../analytics/k8s-efficiency-readers");
  });

  afterAll(async () => {
    if (!configured) return;
    const { eq } = await import("drizzle-orm");
    for (const table of [
      schema.metricPointsRaw,
      schema.metricPoints1m,
      schema.metricPoints1h,
      schema.dashboardStats,
      schema.accountResourceCounts,
      schema.costDaily,
    ]) {
      await db.delete(table).where(eq(table.organization_id, orgId));
    }
    await db.$client.end();
  });

  function points(resource: string, label: string, at: Array<[number, number]>) {
    return writers.flattenMetricSeries(
      {
        organizationId: orgId,
        accountId,
        resourceId: resource,
        pluginId: "postgres",
        resourceTypeId: "postgres-database",
      },
      [{ label, unit: "%", points: at.map(([timestamp, value]) => ({ timestamp, value })) }],
    );
  }

  it("round-trips metric points through the raw table, millisecond-exact", async () => {
    // Inside getLatestMetrics's one-hour window, a whole number of minutes apart.
    const now = Date.now();
    const times = [now - 3 * MINUTE, now - 2 * MINUTE, now - MINUTE];
    await writers.insertMetricPoints(
      points(
        resourceId,
        "CPU",
        times.map((t, i) => [t, 10 * (i + 1)]),
      ),
    );

    const series = await readers.getLatestMetrics(orgId, resourceId);
    expect(series).toHaveLength(1);
    expect(series![0]!.label).toBe("CPU");
    expect(series![0]!.unit).toBe("%");
    expect(series![0]!.points.map((p) => p.value)).toEqual([10, 20, 30]);
    expect(series![0]!.points.map((p) => p.timestamp)).toEqual(times);

    const batch = await readers.getLatestMetricsBatch(orgId, [resourceId]);
    expect(batch.get(resourceId)![0]!.points).toHaveLength(3);

    const raw = await readers.getMetricRange(orgId, resourceId, now - HOUR, now);
    expect(raw[0]!.points.map((p) => p.value)).toEqual([10, 20, 30]);
  });

  describe("the minute and hour rollups", () => {
    // Two whole hours back, so every point is inside the 1m reader's window
    // and the hour buckets are complete.
    const h0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
    const h1 = h0 + HOUR;

    // Window A: two points in h0's first minute, one in its second, and one
    // in h1. Window B overlaps it (three of A's points again, byte for byte)
    // and adds a point to h0's second minute and one to h1.
    const windowA: Array<[number, number]> = [
      [h0 + 5_000, 10],
      [h0 + 35_000, 20],
      [h0 + MINUTE + 1_000, 7],
      [h1 + 10_000, 100],
    ];
    const windowB: Array<[number, number]> = [
      [h0 + 35_000, 20],
      [h0 + MINUTE + 1_000, 7],
      [h1 + 10_000, 100],
      [h0 + MINUTE + 50_000, 1.5],
      [h1 + 40_000, 50],
    ];
    const unique = new Map<number, number>([...windowA, ...windowB]);

    function rawAverage(from: number, to: number): number {
      const values = [...unique].filter(([t]) => t >= from && t < to).map(([, v]) => v);
      return values.reduce((a, b) => a + b, 0) / values.length;
    }

    beforeAll(async () => {
      // A once, B twice (the second B entirely a repeat), A again.
      await writers.insertMetricPoints(points(rollupResourceId, "CPU", windowA));
      await writers.insertMetricPoints(points(rollupResourceId, "CPU", windowB));
      await writers.insertMetricPoints(points(rollupResourceId, "CPU", windowB));
      await writers.insertMetricPoints(points(rollupResourceId, "CPU", windowA));
    });

    it("stores each raw point once however often it was sent", async () => {
      const { and, eq, sql } = await import("drizzle-orm");
      const [raw] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.metricPointsRaw)
        .where(
          and(
            eq(schema.metricPointsRaw.organization_id, orgId),
            eq(schema.metricPointsRaw.resource_id, rollupResourceId),
          ),
        );
      expect(raw!.n).toBe(unique.size);

      for (const table of [schema.metricPoints1m, schema.metricPoints1h]) {
        const [rollup] = await db
          .select({ n: sql<number>`sum(${table.value_count})::int` })
          .from(table)
          .where(and(eq(table.organization_id, orgId), eq(table.resource_id, rollupResourceId)));
        expect(rollup!.n).toBe(unique.size);
      }
    });

    it("averages each minute to exactly the raw points in it", async () => {
      const byResource = await readers.getMetricMinuteSeriesBatch(
        orgId,
        [rollupResourceId],
        "CPU",
        h0,
        h1 + HOUR,
      );
      const minutes = [h0, h0 + MINUTE, h1];
      expect(byResource.get(rollupResourceId)).toEqual(
        minutes.map((m) => ({ tsMs: m, value: rawAverage(m, m + MINUTE) })),
      );

      const range = await readers.getMetricRange(orgId, rollupResourceId, h0, h0 + 3 * DAY);
      expect(range[0]!.points).toEqual(
        minutes.map((m) => ({ timestamp: m, value: rawAverage(m, m + MINUTE) })),
      );
    });

    it("averages each hour to exactly the raw points in it", async () => {
      // A span over seven days routes getMetricRange to the hour rollup.
      const range = await readers.getMetricRange(orgId, rollupResourceId, h0 - 8 * DAY, h1 + HOUR);
      expect(range).toHaveLength(1);
      expect(range[0]!.points).toEqual([
        { timestamp: h0, value: rawAverage(h0, h1) },
        { timestamp: h1, value: rawAverage(h1, h1 + HOUR) },
      ]);
    });

    it("keeps the running min and max", async () => {
      const { and, eq } = await import("drizzle-orm");
      const rows = await db
        .select({ min: schema.metricPoints1h.value_min, max: schema.metricPoints1h.value_max })
        .from(schema.metricPoints1h)
        .where(
          and(
            eq(schema.metricPoints1h.organization_id, orgId),
            eq(schema.metricPoints1h.resource_id, rollupResourceId),
            eq(schema.metricPoints1h.ts_hour, new Date(h0).toISOString()),
          ),
        );
      expect(rows).toEqual([{ min: 1.5, max: 20 }]);
    });

    it("weights minutes, not points, in the per-resource and SLO reads", async () => {
      const minuteAverages = [
        rawAverage(h0, h0 + MINUTE),
        rawAverage(h0 + MINUTE, h0 + 2 * MINUTE),
        rawAverage(h1, h1 + MINUTE),
      ];
      const avg = await readers.getMetricSeriesAverageBatch(
        orgId,
        [rollupResourceId],
        "CPU",
        h0,
        h1 + HOUR,
      );
      expect(avg.get(rollupResourceId)).toBeCloseTo(
        minuteAverages.reduce((a, b) => a + b, 0) / minuteAverages.length,
        10,
      );

      const buckets = await sloReaders.getSloHourlyBuckets(
        orgId,
        rollupResourceId,
        "CPU",
        { kind: "threshold", comparator: "<", threshold: 50 },
        h0,
        h1 + HOUR,
      );
      // h0's minutes average 15 and 4.25 (both good); h1's averages 75 (bad).
      expect(buckets).toEqual([
        { startMs: h0, good: 2, total: 2 },
        { startMs: h1, good: 0, total: 1 },
      ]);

      const quantiles = await readers.getMetricQuantilesBatch(
        orgId,
        [rollupResourceId],
        h0,
        h1 + HOUR,
      );
      const [q] = quantiles.get(rollupResourceId)!;
      expect(q).toMatchObject({ label: "CPU", unit: "%", samples: 3, max: 75 });
      expect(q!.q05).toBeLessThanOrEqual(q!.q95);

      const daily = await readers.getMetricDailyAverageBatch(
        orgId,
        [rollupResourceId],
        "CPU",
        h0,
        h1 + HOUR,
      );
      expect(daily.length).toBeGreaterThanOrEqual(1);
      expect(daily[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("offers the series to the metric pickers", async () => {
      const keys = await readers.listMetricSeriesKeys(orgId, { pluginId: "postgres" });
      expect(keys).toEqual([{ label: "CPU", unit: "%", resourceCount: 2 }]);
      const pairs = await sloReaders.listResourceMetricSeries(orgId);
      expect(pairs.map((p) => p.resourceId).sort()).toEqual([resourceId, rollupResourceId].sort());
      expect(pairs[0]).toMatchObject({
        pluginId: "postgres",
        resourceTypeId: "postgres-database",
        label: "CPU",
        unit: "%",
      });
    });
  });

  it("reads back the newest dashboard stats snapshot, alone and in a batch", async () => {
    const older = [{ label: "Size", value: "1.0 GB" }];
    const newer = [{ label: "Size", value: "1.2 GB", variant: "status-healthy" as const }];
    const now = Date.now();
    await writers.insertDashboardStats({
      organizationId: orgId,
      accountId,
      resourceId,
      ts: new Date(now - MINUTE),
      stats: older,
    });
    await writers.insertDashboardStats({
      organizationId: orgId,
      accountId,
      resourceId,
      ts: new Date(now),
      stats: newer,
    });
    expect(await readers.getLatestStats(orgId, resourceId)).toEqual(newer);
    const batch = await readers.getLatestStatsBatch(orgId, [resourceId, rollupResourceId]);
    expect([...batch]).toEqual([[resourceId, newer]]);
  });

  it("reads back the newest account resource-count snapshot, alone and in a batch", async () => {
    const counts = [
      { typeLabel: "Database", count: 2 },
      { typeLabel: "Bucket", count: 5 },
    ];
    const now = Date.now();
    await writers.insertAccountResourceCounts({
      organizationId: orgId,
      accountId,
      ts: new Date(now - MINUTE),
      counts: [],
    });
    await writers.insertAccountResourceCounts({
      organizationId: orgId,
      accountId,
      ts: new Date(now),
      counts,
    });
    expect(await readers.getLatestAccountCounts(orgId, accountId)).toEqual(counts);
    const batch = await readers.getLatestAccountCountsBatch(orgId, [accountId]);
    expect(batch.get(accountId)).toEqual(counts);
  });

  it("scans Kubernetes cost rows into Monday weeks, with '' for a missing tag", async () => {
    const { KUBERNETES_COST_PLUGIN_ID } = await import("@infrawrench/client-core");
    const row = (day: string, tags: Record<string, string>, amount: number) => ({
      organization_id: orgId,
      account_id: accountId,
      plugin_id: KUBERNETES_COST_PLUGIN_ID,
      day,
      service: "kubernetes-workload",
      region: "",
      resource_id: "",
      tags,
      tags_hash: String(amount),
      currency: "USD",
      amount,
      usage_amount: 0,
      usage_unit: "",
    });
    // 2026-09-02 is a Wednesday and 2026-09-06 the Sunday of the same ISO week.
    await db
      .insert(schema.costDaily)
      .values([
        row("2026-09-02", { namespace: "payments", k8s_resource: "cpu", k8s_usage: "used" }, 2),
        row("2026-09-06", { namespace: "payments", k8s_resource: "cpu", k8s_usage: "used" }, 3),
        row("2026-09-06", { k8s_resource: "cpu", k8s_usage: "idle" }, 4),
      ]);

    const scanned = await k8s.scanKubernetesEfficiency(orgId, {
      from: "2026-09-01",
      to: "2026-09-30",
      granularity: "week",
      filters: [],
      groupBy: "namespace",
    });
    scanned.sort((a, b) => a.group.localeCompare(b.group));
    expect(scanned).toEqual([
      expect.objectContaining({ bucket: "2026-08-31", group: "", usage: "idle", amount: 4 }),
      expect.objectContaining({
        bucket: "2026-08-31",
        group: "payments",
        resource: "cpu",
        usage: "used",
        amount: 5,
      }),
    ]);

    expect(await k8s.getKubernetesTagKeys(orgId)).toEqual([
      "k8s_resource",
      "k8s_usage",
      "namespace",
    ]);
    expect(
      await k8s.getKubernetesDimensionValues(orgId, { dimension: "tag", tagKey: "namespace" }),
    ).toEqual(["payments"]);
  });

  it("splits amortized consumption into covered and uncovered for the commitment readers", async () => {
    const commitments = await import("../../analytics/commitment-readers");
    const cloudAccount = `test-acct-${randomUUID()}`;
    let n = 0;
    const row = (
      day: string,
      chargeType: string,
      commitmentId: string,
      amount: number,
      amortized?: number,
    ) => ({
      organization_id: orgId,
      account_id: cloudAccount,
      plugin_id: "aws",
      day,
      service: "AmazonEC2",
      region: "us-east-1",
      resource_id: "",
      tags: {},
      tags_hash: String(++n),
      currency: "USD",
      amount,
      usage_amount: 0,
      usage_unit: "",
      charge_type: chargeType,
      commitment_id: commitmentId,
      amortized_amount: amortized ?? 0,
      amortized_reported: amortized === undefined ? 0 : 1,
    });
    await db.insert(schema.costDaily).values([
      // Covered usage costs nothing in cash; its amortized value is the money.
      row("2026-10-01", "commitment_covered_usage", "", 0, 6),
      // Both signals at once: still counted once, as covered.
      row("2026-10-01", "commitment_covered_usage", "ri-1", 0, 4),
      row("2026-10-02", "usage", "", 10),
      // Not consumption: excluded from every ratio, but still a day with data.
      row("2026-10-03", "tax", "", 1),
    ]);

    const cells = await commitments.getCommitmentCoverageCells(orgId, "2026-10-01", "2026-10-31", [
      cloudAccount,
    ]);
    expect(cells).toEqual([
      {
        account_id: cloudAccount,
        plugin_id: "aws",
        service: "AmazonEC2",
        region: "us-east-1",
        currency: "USD",
        covered_amount: 10,
        uncovered_amount: 10,
      },
    ]);

    const days = await commitments.getAccountDataDays(orgId, "2026-10-01", "2026-10-31", [
      cloudAccount,
    ]);
    expect([...days.get(cloudAccount)!].sort()).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);

    expect(
      await commitments.getCommitmentDeliveredTotals(orgId, "2026-10-01", "2026-10-31", [
        cloudAccount,
      ]),
    ).toEqual([{ account_id: cloudAccount, commitment_id: "ri-1", currency: "USD", amount: 4 }]);

    expect(
      await commitments.getUncoveredDailySpend(orgId, "2026-10-01", "2026-10-31", [cloudAccount]),
    ).toEqual([
      {
        plugin_id: "aws",
        service: "AmazonEC2",
        region: "us-east-1",
        currency: "USD",
        day: "2026-10-02",
        amount: 10,
      },
    ]);
  });
});
