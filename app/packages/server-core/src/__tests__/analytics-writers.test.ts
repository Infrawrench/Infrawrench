import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricSeries } from "@infrawrench/plugin-base";
import { fakePostgres } from "./helpers/fake-postgres";

/**
 * The writers run against a real Drizzle database over a recording driver, so
 * what these assert on is the statement and parameters Postgres would get.
 * `db/analytics.test.ts` proves the rollup arithmetic against a real server.
 */
const pg = fakePostgres();
vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const writers = await import("../analytics/writers");

beforeEach(() => {
  vi.restoreAllMocks();
  pg.reset();
});

describe("flattenMetricSeries", () => {
  it("flattens multiple series into per-point rows", () => {
    const series: MetricSeries[] = [
      {
        label: "cpu",
        unit: "%",
        points: [
          { timestamp: 0, value: 1 },
          { timestamp: 60000, value: 2 },
        ],
      },
      { label: "mem", points: [{ timestamp: 0, value: 5 }] },
    ];
    const rows = writers.flattenMetricSeries(
      {
        organizationId: "org",
        accountId: "acct",
        resourceId: "res",
        pluginId: "aws",
        resourceTypeId: "ec2",
      },
      series,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      organization_id: "org",
      account_id: "acct",
      resource_id: "res",
      plugin_id: "aws",
      resource_type_id: "ec2",
      series_label: "cpu",
      unit: "%",
      value: 1,
    });
    expect(rows[0]!.ts).toBe(new Date(0).toISOString());
    // missing unit defaults to ""
    expect(rows[2]!.unit).toBe("");
  });

  it("returns an empty array for empty series", () => {
    expect(
      writers.flattenMetricSeries(
        {
          organizationId: "o",
          accountId: "a",
          resourceId: "r",
          pluginId: "p",
          resourceTypeId: "t",
        },
        [],
      ),
    ).toEqual([]);
  });

  it("drops non-finite values, which would fail the whole batch as JSON null", () => {
    const rows = writers.flattenMetricSeries(
      { organizationId: "o", accountId: "a", resourceId: "r", pluginId: "p", resourceTypeId: "t" },
      [
        {
          label: "CPU",
          points: [
            { timestamp: 1, value: Number.NaN },
            { timestamp: 2, value: Number.POSITIVE_INFINITY },
            { timestamp: 3, value: 0.5 },
          ],
        },
      ],
    );
    expect(rows.map((r) => r.value)).toEqual([0.5]);
  });
});

describe("insert wrappers", () => {
  it("insertMetricPoints sends the points as one jsonb parameter and folds them into the rollups", async () => {
    const rows = writers.flattenMetricSeries(
      { organizationId: "o", accountId: "a", resourceId: "r", pluginId: "p", resourceTypeId: "t" },
      [{ label: "x", points: [{ timestamp: 0, value: 1 }] }],
    );
    await writers.insertMetricPoints(rows);
    expect(pg.queries).toHaveLength(1);
    const { sql, params } = pg.lastQuery();
    expect(params).toHaveLength(1);
    expect(JSON.parse(params[0] as string)).toEqual(rows);
    expect(sql).toContain("jsonb_to_recordset(");
    // Points already stored are skipped, and only the newly inserted ones
    // reach the rollups: that is what keeps a re-sent window from counting twice.
    expect(sql).toContain("INSERT INTO metric_points_raw");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("FROM inserted");
    expect(sql).toContain("INSERT INTO metric_points_1m");
    expect(sql).toContain("INSERT INTO metric_points_1h");
    expect(sql).toContain("value_count = m.value_count + excluded.value_count");
  });

  it("skips the insert when values are empty", async () => {
    await writers.insertMetricPoints([]);
    expect(pg.queries).toEqual([]);
  });

  it("swallows insert errors (logs them)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(pg.db, "insert").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(
      writers.insertDashboardStats({
        organizationId: "o",
        accountId: "a",
        resourceId: "r",
        ts: new Date(0),
        stats: [],
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("swallows metric point errors (logs them)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(pg.db, "execute").mockRejectedValueOnce(new Error("db down"));
    await expect(
      writers.insertMetricPoints(
        writers.flattenMetricSeries(
          {
            organizationId: "o",
            accountId: "a",
            resourceId: "r",
            pluginId: "p",
            resourceTypeId: "t",
          },
          [{ label: "x", points: [{ timestamp: 0, value: 1 }] }],
        ),
      ),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("insertDashboardStats serializes stats_json", async () => {
    const stats = [{ label: "L", value: "1" }] as never;
    await writers.insertDashboardStats({
      organizationId: "o",
      accountId: "a",
      resourceId: "r",
      ts: new Date(0),
      stats,
    });
    const { sql, params } = pg.lastQuery();
    expect(sql).toContain('insert into "dashboard_stats"');
    expect(params).toEqual(["o", "a", "r", new Date(0).toISOString(), JSON.stringify(stats)]);
  });

  it("insertAccountResourceCounts serializes counts_json", async () => {
    await writers.insertAccountResourceCounts({
      organizationId: "o",
      accountId: "a",
      ts: new Date(0),
      counts: [{ typeLabel: "VMs", count: 3 }],
    });
    const { sql, params } = pg.lastQuery();
    expect(sql).toContain('insert into "account_resource_counts"');
    expect(JSON.parse(params[3] as string)).toEqual([{ typeLabel: "VMs", count: 3 }]);
  });

  it("insertPollOutcome maps fields and defaults first_error to ''", async () => {
    await writers.insertPollOutcome({
      organizationId: "o",
      accountId: "a",
      pluginId: "aws",
      ts: new Date(0),
      durationMs: 42,
      resourceCount: 7,
      succeededTypeCount: 2,
      failedTypeCount: 1,
      skippedTypeCount: 0,
    });
    const { sql, params } = pg.lastQuery();
    expect(sql).toContain('insert into "poll_outcomes"');
    expect(params).toEqual(["o", "a", "aws", new Date(0).toISOString(), 42, 7, 2, 1, 0, ""]);
  });
});
