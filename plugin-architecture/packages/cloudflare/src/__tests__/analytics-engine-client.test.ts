import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listDatasets,
  executeAnalyticsEngineQuery,
  introspectAnalyticsEngine,
  fetchAnalyticsEngineMetrics,
  datasetIdent,
  ANALYTICS_ENGINE_COLUMNS,
} from "../clients/analytics-engine-client.js";
import { makeApi } from "./_helpers.js";

function respond(body: string, status = 200) {
  return vi.fn(async () => ({ ok: status < 400, status, text: async () => body }));
}

describe("analytics engine", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists datasets from SHOW TABLES as raw-SQL POSTs", async () => {
    const fetchMock = respond(
      JSON.stringify({
        meta: [{ name: "dataset", type: "String" }],
        data: [{ dataset: "temps" }, { dataset: "clicks" }, { dataset: "temps" }],
        rows: 3,
      }),
    );
    globalThis.fetch = fetchMock as never;
    const out = await listDatasets(makeApi(), "acct");
    expect(out.map((d) => d.id)).toEqual([
      "acct:analytics-engine-dataset:clicks",
      "acct:analytics-engine-dataset:temps",
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-cf/analytics_engine/sql");
    expect(init.body).toBe("SHOW TABLES FORMAT JSON");
  });

  it("turns a 403 into an Account Analytics permission hint", async () => {
    globalThis.fetch = respond("Authentication error", 403) as never;
    await expect(listDatasets(makeApi(), "acct")).rejects.toThrow(/Account Analytics:Read/);
  });

  it("orders query rows by meta and falls back to text lines", async () => {
    globalThis.fetch = respond(
      JSON.stringify({ meta: [{ name: "b" }, { name: "a" }], data: [{ a: 1, b: 2 }], rows: 1 }),
    ) as never;
    const json = await executeAnalyticsEngineQuery(makeApi(), "SELECT a, b FROM t");
    expect(Object.keys(json.rows[0]!)).toEqual(["b", "a"]);

    globalThis.fetch = respond("1\t2\n3\t4\n") as never;
    const tsv = await executeAnalyticsEngineQuery(makeApi(), "SELECT 1 FORMAT TabSeparated");
    expect(tsv.rows).toEqual([{ result: "1\t2" }, { result: "3\t4" }]);
  });

  it("surfaces SQL errors from the response body", async () => {
    globalThis.fetch = respond("unknown column foo", 422) as never;
    await expect(executeAnalyticsEngineQuery(makeApi(), "SELECT foo")).rejects.toThrow(
      "unknown column foo",
    );
  });

  it("introspects every dataset with the fixed column set", async () => {
    globalThis.fetch = respond(JSON.stringify({ data: [{ dataset: "other" }] })) as never;
    const tables = await introspectAnalyticsEngine(makeApi(), "temps");
    expect(tables.map((t) => t.name)).toEqual(["temps", "other"]);
    expect(tables[0]!.columns).toBe(ANALYTICS_ENGINE_COLUMNS);
    expect(ANALYTICS_ENGINE_COLUMNS).toHaveLength(44);
  });

  it("charts sample-weighted points per bucket", async () => {
    const fetchMock = respond(
      JSON.stringify({
        data: [
          { t: "2026-10-01 00:00:00", points: "40", stored: "4" },
          { t: "2026-10-01 01:00:00", points: 10, stored: 10 },
        ],
      }),
    );
    globalThis.fetch = fetchMock as never;
    const series = await fetchAnalyticsEngineMetrics(makeApi(), "my-ds", {
      startMs: Date.parse("2026-10-01T00:00:00Z"),
      endMs: Date.parse("2026-10-02T00:00:00Z"),
    });
    expect(series.map((s) => s.label)).toEqual(["Data Points Written", "Rows Stored (Sampled)"]);
    expect(series[0]!.points[0]).toEqual({
      timestamp: Date.parse("2026-10-01T00:00:00Z"),
      value: 40,
    });
    const sql = String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(sql).toContain("INTERVAL '1' HOUR");
    expect(sql).toContain('FROM "my-ds"');
    expect(sql).toContain("toDateTime('2026-10-01 00:00:00')");
  });

  it("returns no series when the query fails", async () => {
    globalThis.fetch = respond("nope", 500) as never;
    expect(await fetchAnalyticsEngineMetrics(makeApi(), "temps")).toEqual([]);
    expect(datasetIdent("plain_name")).toBe("plain_name");
  });
});
