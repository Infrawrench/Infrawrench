import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsClient } from "../client.js";
import { usageQueryBody, usageSeriesFor } from "../usage-metrics.js";

const ACCOUNT = "acct-1";
const DAY = Date.UTC(2026, 8, 1);

const TABLE = {
  columns: ["time", "voice_id", "credits", "fiat_units_spent", "label"],
  column_types: ["DateTime", "String", "Float", "Float", "String"],
  column_units: [null, null, "credits", "usd", null],
  rows: [
    ["2026-09-01 00:00:00", "voice_a", 100, 0.5, "x"],
    ["2026-09-01 00:00:00", "voice_b", 999, 9, "x"],
    ["2026-09-02T00:00:00Z", "voice_a", 50, 0, "x"],
    ["2026-09-02T00:00:00Z", "voice_a", 25, 0, "x"],
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usageSeriesFor", () => {
  it("keeps one key's rows and turns every numeric column into a series", () => {
    const series = usageSeriesFor(TABLE, "voice_id", "voice_a");
    expect(series).toEqual([
      {
        label: "Credits",
        unit: "credits",
        points: [
          { timestamp: DAY, value: 100 },
          { timestamp: DAY + 86_400_000, value: 75 },
        ],
      },
      {
        label: "Fiat units spent",
        unit: "USD",
        points: [
          { timestamp: DAY, value: 0.5 },
          { timestamp: DAY + 86_400_000, value: 0 },
        ],
      },
    ]);
  });

  it("returns nothing when the grouping column is missing", () => {
    expect(
      usageSeriesFor({ ...TABLE, columns: ["time", "x", "credits"] }, "voice_id", "voice_a"),
    ).toEqual([]);
  });

  it("builds a daily UTC query grouped by the one dimension", () => {
    expect(usageQueryBody("model", { startMs: DAY + 3_600_000, endMs: DAY + 5 })).toEqual({
      start_time: DAY,
      end_time: DAY + 5,
      interval_seconds: 86_400,
      group_by: ["model"],
      time_zone: "UTC",
    });
  });
});

describe("voice and model metrics", () => {
  it("POSTs the grouped usage query and charts the viewed voice", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(TABLE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    const client = new ElevenLabsClient({ apiKey: "k" });
    const series = await client.fetchMetricSeries("voice", `${ACCOUNT}:voice:voice_a`, ACCOUNT, {
      startMs: DAY,
      endMs: DAY + 2 * 86_400_000 - 1,
    });
    expect(calls[0]!.url).toBe(
      "https://api.elevenlabs.io/v1/workspace/analytics/query/usage-by-product-over-time",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body)).group_by).toEqual(["voice_id"]);
    expect(series.map((s) => s.label)).toEqual(["Credits", "Fiat units spent"]);
  });
});

describe("agent dashboard stats", () => {
  it("adds the live conversation count", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      const body = String(url).includes("/live-count?agent_id=agent_1")
        ? { count: 3 }
        : String(url).includes("/conversations")
          ? { conversations: [], has_more: false }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    const stats = await new ElevenLabsClient({ apiKey: "k" }).fetchDashboardStats(
      "agent",
      `${ACCOUNT}:agent:agent_1`,
      ACCOUNT,
    );
    expect(stats).toContainEqual({ label: "Live Conversations", value: "3" });
  });
});
