import { describe, expect, it } from "vitest";
import { CAPACITY_RATIOS, fetchBranchMetrics, highestShare } from "../metrics.js";
import { plugin } from "../plugin.js";

const T0 = 1_795_000_000;

describe("branch capacity series", () => {
  it("derives the highest volume share across pods from used and capacity bytes", async () => {
    const series = await fetchBranchMetrics(
      async <T>() =>
        ({
          series: [
            {
              metric: "planetscale_volume_disk_usage_bytes",
              labels: { pod: "a" },
              points: [
                [T0, 50],
                [T0 + 60, 60],
              ],
            },
            {
              metric: "planetscale_volume_capacity_bytes",
              labels: { pod: "a" },
              points: [
                [T0, 100],
                [T0 + 60, 100],
              ],
            },
            {
              metric: "planetscale_volume_disk_usage_bytes",
              labels: { pod: "b" },
              points: [[T0, 90]],
            },
            {
              metric: "planetscale_volume_capacity_bytes",
              labels: { pod: "b" },
              points: [[T0, 100]],
            },
          ],
        }) as T,
      "/organizations/o/databases/d/branches/main",
    );
    const disk = series.find((s) => s.label === "Volume Used (highest)");
    expect(disk?.points).toEqual([
      { timestamp: T0 * 1000, value: 90 },
      { timestamp: (T0 + 60) * 1000, value: 60 },
    ]);
  });

  it("pairs a usage with a ceiling reported once, and ignores an unlimited one", () => {
    const pgb = highestShare(
      [
        {
          metric: "planetscale_pgbouncer_current_client_connections",
          labels: { pod: "p" },
          points: [[T0, 25]],
        },
        { metric: "planetscale_pgbouncer_settings_max_client_conn", points: [[T0, 100]] },
      ],
      "planetscale_pgbouncer_current_client_connections",
      "planetscale_pgbouncer_settings_max_client_conn",
      "x",
    );
    expect(pgb?.points).toEqual([{ timestamp: T0 * 1000, value: 25 }]);
    expect(
      highestShare(
        [
          { metric: "planetscale_replication_slot_max_wal_retained_bytes", points: [[T0, 5]] },
          { metric: "planetscale_settings_max_slot_wal_keep_size_bytes", points: [[T0, -1]] },
        ],
        "planetscale_replication_slot_max_wal_retained_bytes",
        "planetscale_settings_max_slot_wal_keep_size_bytes",
        "x",
      ),
    ).toBeNull();
  });

  it("declares exactly the derived series", () => {
    const branch = plugin.resourceTypes.find((t) => t.id === "ps-branch")!;
    expect(branch.capacityMetrics?.map((m) => m.seriesLabel)).toEqual(
      CAPACITY_RATIOS.map((r) => r.label),
    );
  });
});
