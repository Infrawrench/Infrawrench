import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { installFetch, route } from "./helpers.js";

beforeEach(() => installFetch());
afterEach(() => vi.unstubAllGlobals());

const GIB = 1024 ** 3;
const at = (h: number) => `2026-11-23T0${h}:00:00Z`;

describe("disk capacity", () => {
  it("derives the share of capacity from Render's usage and capacity series", async () => {
    route("GET", "/metrics/disk-usage", [
      {
        labels: [],
        unit: "bytes",
        values: [
          { timestamp: at(0), value: 2 * GIB },
          { timestamp: at(1), value: 3 * GIB },
        ],
      },
    ]);
    route("GET", "/metrics/disk-capacity", [
      {
        labels: [],
        unit: "bytes",
        values: [
          { timestamp: at(0), value: 10 * GIB },
          { timestamp: at(1), value: 10 * GIB },
        ],
      },
    ]);
    const c = hostClient(new RenderClient({ apiKey: "rnd_key" }, RESOURCE_TYPES));
    const series = await c.fetchMetricSeries("postgres", "acct:postgres:dpg-1", "acct");
    const pct = series.find((s) => s.label === "Disk Used %");
    expect(pct?.points.map((p) => p.value)).toEqual([20, 30]);
    for (const id of ["postgres", "disk"]) {
      const type = RESOURCE_TYPES.find((t) => t.id === id)!;
      for (const m of type.capacityMetrics ?? []) {
        expect(series.map((s) => s.label)).toContain(m.seriesLabel);
      }
    }
  });

  it("adds no percentage when capacity is missing", async () => {
    route("GET", "/metrics/disk-usage", [
      { labels: [], unit: "bytes", values: [{ timestamp: at(0), value: GIB }] },
    ]);
    const c = hostClient(new RenderClient({ apiKey: "rnd_key" }, RESOURCE_TYPES));
    const series = await c.fetchMetricSeries("postgres", "acct:postgres:dpg-1", "acct");
    expect(series.some((s) => s.label === "Disk Used %")).toBe(false);
  });
});
