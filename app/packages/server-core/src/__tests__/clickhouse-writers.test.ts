import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricSeries } from "@infrawrench/plugin-base";
import { fakeClickHouse } from "./helpers/fake-clickhouse";

/**
 * The writers go through `db.insert(...)`, which sends a `JSONEachRow` body —
 * so what these assert on is what the driver was handed: a table name and the
 * decoded rows, after the dialect mapped each value to its row-format form.
 */
const ch = fakeClickHouse();
const isConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => isConfigured(),
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

let writers: typeof import("../clickhouse/writers");

beforeEach(async () => {
  vi.clearAllMocks();
  ch.reset();
  isConfigured.mockReturnValue(true);
  writers = await import("../clickhouse/writers");
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
});

describe("insert wrappers", () => {
  it("insertMetricPoints inserts into metric_points_raw with JSONEachRow", async () => {
    const rows = writers.flattenMetricSeries(
      { organizationId: "o", accountId: "a", resourceId: "r", pluginId: "p", resourceTypeId: "t" },
      [{ label: "x", points: [{ timestamp: 0, value: 1 }] }],
    );
    await writers.insertMetricPoints(rows);
    const [call] = ch.inserts;
    expect(call!.table).toBe("`metric_points_raw`");
    expect(call!.format).toBe("JSONEachRow");
    expect(await ch.insertedRows(0)).toEqual(rows);
  });

  it("skips the insert when values are empty", async () => {
    await writers.insertMetricPoints([]);
    expect(ch.inserts).toEqual([]);
  });

  it("skips the insert when ClickHouse is not configured", async () => {
    isConfigured.mockReturnValue(false);
    await writers.insertMetricPoints([
      {
        organization_id: "o",
        account_id: "a",
        resource_id: "r",
        plugin_id: "p",
        resource_type_id: "t",
        series_label: "x",
        unit: "",
        ts: new Date(0).toISOString(),
        value: 1,
      },
    ]);
    expect(ch.inserts).toEqual([]);
  });

  it("swallows insert errors (logs them)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ch.client, "insert").mockRejectedValueOnce(new Error("CH down"));
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

  it("insertDashboardStats serializes stats_json", async () => {
    const stats = [{ label: "L", value: "1" }] as never;
    await writers.insertDashboardStats({
      organizationId: "o",
      accountId: "a",
      resourceId: "r",
      ts: new Date(0),
      stats,
    });
    expect(ch.inserts[0]!.table).toBe("`dashboard_stats`");
    expect(await ch.insertedRows(0)).toEqual([
      {
        organization_id: "o",
        account_id: "a",
        resource_id: "r",
        ts: new Date(0).toISOString(),
        stats_json: JSON.stringify(stats),
      },
    ]);
  });

  it("insertAccountResourceCounts serializes counts_json", async () => {
    await writers.insertAccountResourceCounts({
      organizationId: "o",
      accountId: "a",
      ts: new Date(0),
      counts: [{ typeLabel: "VMs", count: 3 }],
    });
    expect(ch.inserts[0]!.table).toBe("`account_resource_counts`");
    const [row] = (await ch.insertedRows(0)) as { counts_json: string }[];
    expect(JSON.parse(row!.counts_json)).toEqual([{ typeLabel: "VMs", count: 3 }]);
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
    expect(ch.inserts[0]!.table).toBe("`poll_outcomes`");
    expect((await ch.insertedRows(0))[0]).toMatchObject({
      plugin_id: "aws",
      duration_ms: 42,
      resource_count: 7,
      succeeded_type_count: 2,
      failed_type_count: 1,
      skipped_type_count: 0,
      first_error: "",
    });
  });
});
