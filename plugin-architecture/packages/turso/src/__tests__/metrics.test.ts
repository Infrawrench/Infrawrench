import { describe, it, expect, vi } from "vitest";
import { dayBuckets, fetchDatabaseUsageSeries } from "../metrics.js";
import { TursoDatabaseResourceType } from "../resources/turso-database.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

describe("dayBuckets", () => {
  it("aligns to UTC midnight and covers a partial last day", () => {
    expect(dayBuckets(T0 + 3_600_000, T0 + 2 * DAY + 60_000)).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
  });

  it("keeps only the newest 31 days", () => {
    const days = dayBuckets(T0, T0 + 90 * DAY);
    expect(days).toHaveLength(31);
    expect(days.at(-1)).toBe(T0 + 89 * DAY);
  });
});

describe("fetchDatabaseUsageSeries", () => {
  it("asks for one window per day and charts each total", async () => {
    const fetchApi = vi.fn(async (path: string) => {
      const from = new URL(path, "https://x").searchParams.get("from") ?? "";
      const day = (Date.parse(from) - T0) / DAY;
      return {
        database: {
          total: {
            rows_read: 100 * (day + 1),
            rows_written: day,
            storage_bytes: 4096,
            bytes_synced: 0,
          },
        },
      } as never;
    });

    const series = await fetchDatabaseUsageSeries(fetchApi, "/v1/organizations/o/databases/db", {
      startMs: T0,
      endMs: T0 + 2 * DAY,
    });

    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(fetchApi.mock.calls[0]![0]).toBe(
      "/v1/organizations/o/databases/db/usage?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-02T00%3A00%3A00.000Z",
    );
    expect(series.map((s) => [s.label, s.unit])).toEqual([
      ["Rows Read", "rows"],
      ["Rows Written", "rows"],
      ["Storage", "bytes"],
      ["Bytes Synced", "bytes"],
    ]);
    expect(series[0]!.points).toEqual([
      { timestamp: T0, value: 100 },
      { timestamp: T0 + DAY, value: 200 },
    ]);
  });

  it("leaves a gap for a day that fails instead of failing the chart", async () => {
    let call = 0;
    const fetchApi = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return { database: { total: { rows_read: 7 } } } as never;
    });
    const series = await fetchDatabaseUsageSeries(fetchApi, "/db", {
      startMs: T0,
      endMs: T0 + 2 * DAY,
    });
    expect(series).toEqual([
      { label: "Rows Read", unit: "rows", points: [{ timestamp: T0 + DAY, value: 7 }] },
    ]);
  });
});

describe("turso-database metrics contract", () => {
  it("declares a Metrics tab", () => {
    expect(TursoDatabaseResourceType.supportsMetrics).toBe(true);
  });
});
