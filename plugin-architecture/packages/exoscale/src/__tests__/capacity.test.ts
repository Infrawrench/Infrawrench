import { describe, expect, it } from "vitest";
import { chartSeries } from "../metrics.js";
import { plugin } from "../plugin.js";

describe("dbaas capacity", () => {
  it("emits the disk share the dbaas type declares, skipping empty samples", () => {
    const series = chartSeries({
      disk_usage: {
        data: {
          cols: [{ label: "time" }, { label: "db-1 (master)" }],
          rows: [
            ["2026-11-23T00:00:00Z", null],
            ["2026-11-23T00:01:00Z", 63.2],
          ],
        },
      },
    });
    const type = plugin.resourceTypes.find((t) => t.id === "dbaas")!;
    expect((type.capacityMetrics ?? []).map((m) => m.seriesLabel)).toEqual(["Disk Used"]);
    expect(series).toEqual([
      {
        label: "Disk Used",
        unit: "%",
        points: [{ timestamp: Date.parse("2026-11-23T00:01:00Z"), value: 63.2 }],
      },
    ]);
  });
});
