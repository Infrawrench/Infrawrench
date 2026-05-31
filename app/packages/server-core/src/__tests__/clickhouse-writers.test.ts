import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricSeries } from "@infrawrench/plugin-base";

const insert = vi.fn(async (_opts?: unknown) => undefined);
const isConfigured = vi.fn(() => true);
vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => isConfigured(),
  getClickHouseClient: () => ({ insert }),
}));

let writers: typeof import("../clickhouse/writers");

beforeEach(async () => {
  vi.clearAllMocks();
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
    expect(insert).toHaveBeenCalledWith({
      table: "metric_points_raw",
      values: rows,
      format: "JSONEachRow",
    });
  });

  it("skips the insert when values are empty", async () => {
    await writers.insertMetricPoints([]);
    expect(insert).not.toHaveBeenCalled();
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
    expect(insert).not.toHaveBeenCalled();
  });

  it("swallows insert errors (logs them)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockRejectedValueOnce(new Error("CH down"));
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
    expect(insert).toHaveBeenCalledWith({
      table: "dashboard_stats",
      values: [
        {
          organization_id: "o",
          account_id: "a",
          resource_id: "r",
          ts: new Date(0).toISOString(),
          stats_json: JSON.stringify(stats),
        },
      ],
      format: "JSONEachRow",
    });
  });

  it("insertAccountResourceCounts serializes counts_json", async () => {
    await writers.insertAccountResourceCounts({
      organizationId: "o",
      accountId: "a",
      ts: new Date(0),
      counts: [{ typeLabel: "VMs", count: 3 }],
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ table: "account_resource_counts" }),
    );
    const arg = insert.mock.calls[0]![0] as { values: { counts_json: string }[] };
    expect(JSON.parse(arg.values[0]!.counts_json)).toEqual([{ typeLabel: "VMs", count: 3 }]);
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
    const arg = insert.mock.calls[0]![0] as { table: string; values: Record<string, unknown>[] };
    expect(arg.table).toBe("poll_outcomes");
    expect(arg.values[0]).toMatchObject({
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
