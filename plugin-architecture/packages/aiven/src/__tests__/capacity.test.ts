import { capacityDeclarations, resolveCapacityLimit } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { DISK_MAX_NODE_SERIES, chartsToSeries } from "../mappers.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";

describe("service disk capacity", () => {
  it("emits the fullest node's disk usage beside the averaged chart", () => {
    const series = chartsToSeries({
      disk_usage: {
        data: {
          cols: [{ label: "time" }, { label: "pg-1" }, { label: "pg-2" }],
          rows: [
            ["2026-11-23T10:05:00Z", 52.5, 71.25],
            ["2026-11-23T10:00:00Z", 52, 70],
          ],
        },
        hints: { title: "Disk space usage %" },
      },
    });
    expect(series.find((s) => s.label === "Disk space usage %")?.points.at(-1)?.value).toBe(61.875);
    expect(series.find((s) => s.label === DISK_MAX_NODE_SERIES)).toEqual({
      label: DISK_MAX_NODE_SERIES,
      unit: "%",
      points: [
        { timestamp: Date.parse("2026-11-23T10:00:00Z"), value: 70 },
        { timestamp: Date.parse("2026-11-23T10:05:00Z"), value: 71.25 },
      ],
    });
  });

  it("skips a node with no sample instead of reading it as zero", () => {
    const series = chartsToSeries({
      disk_usage: {
        data: {
          cols: [{ label: "time" }, { label: "pg-1" }, { label: "pg-2" }],
          rows: [
            ["2026-11-23T10:00:00Z", 64, null],
            ["2026-11-23T10:05:00Z", { v: null }, { v: null }],
          ],
        },
        hints: { title: "Disk space usage %" },
      },
    });
    expect(series.find((s) => s.label === "Disk space usage %")?.points).toEqual([
      { timestamp: Date.parse("2026-11-23T10:00:00Z"), value: 64 },
    ]);
    expect(series.find((s) => s.label === DISK_MAX_NODE_SERIES)?.points).toEqual([
      { timestamp: Date.parse("2026-11-23T10:00:00Z"), value: 64 },
    ]);
  });

  it("emits no max-node series without a disk chart", () => {
    const series = chartsToSeries({
      cpu_usage: {
        data: { cols: [{ label: "time" }, { label: "n1" }], rows: [["2026-11-23T10:00:00Z", 5]] },
        hints: { title: "CPU usage %" },
      },
    });
    expect(series.some((s) => s.label === DISK_MAX_NODE_SERIES)).toBe(false);
  });

  it("declares the series by its exact label against 100%", () => {
    const service = RESOURCE_TYPES.find((t) => t.id === T.service)!;
    const [decl] = capacityDeclarations(service);
    expect(decl?.valueKey).toBe(DISK_MAX_NODE_SERIES);
    expect(resolveCapacityLimit(decl!.declaration.limit, {})?.limit).toBe(100);
  });
});
