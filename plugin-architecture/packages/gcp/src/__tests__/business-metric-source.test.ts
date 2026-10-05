import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BIGQUERY_METRIC_MAX_BYTES_BILLED,
  bigQueryRowsToRecords,
  dryRunGcpBusinessMetricSource,
  gcpBusinessMetricSource,
  listGcpBusinessMetricOptions,
  runGcpBusinessMetricSource,
} from "../business-metric-source";
import { plugin } from "../plugin";

const ctx = { project: "acct-project", token: () => Promise.resolve("tok") };
const range = {
  from: "2026-09-01",
  to: "2026-09-02",
  timezone: "UTC",
  maxRows: 100,
  timeoutMs: 30_000,
};
const params = {
  project: "analytics",
  dataset: "prod",
  sql: "SELECT day, value FROM t WHERE day BETWEEN {{from}} AND {{to}}",
};

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(responses: Array<(call: Call) => unknown>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${call.url}`);
    const body = next(call);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const dryRunSelect = () => ({
  statistics: { query: { statementType: "SELECT", totalBytesProcessed: "2048" } },
});

afterEach(() => vi.unstubAllGlobals());

describe("gcp business metric source manifest", () => {
  it("is declared on the plugin with the expected fields", () => {
    expect(plugin.manifest.businessMetricSource).toBe(gcpBusinessMetricSource);
    expect(gcpBusinessMetricSource.fields.map((f) => f.key)).toEqual([
      "project",
      "dataset",
      "table",
      "sql",
    ]);
    expect(gcpBusinessMetricSource.readOnly).toBe("enforced");
    expect(gcpBusinessMetricSource.supportsDryRun).toBe(true);
  });
});

describe("runGcpBusinessMetricSource", () => {
  it("dry-runs, then queries with the caps and binds the window", async () => {
    const calls = mockFetch([
      dryRunSelect,
      () => ({
        jobComplete: true,
        jobReference: { projectId: "analytics", jobId: "j1", location: "US" },
        schema: {
          fields: [
            { name: "day", type: "DATE" },
            { name: "value", type: "INTEGER" },
          ],
        },
        rows: [
          { f: [{ v: "2026-09-01" }, { v: "12" }] },
          { f: [{ v: "2026-09-02" }, { v: "15" }] },
        ],
        totalRows: "2",
        totalBytesProcessed: "1048576",
      }),
    ]);
    const result = await runGcpBusinessMetricSource(ctx, params, range);
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 12 },
      { date: "2026-09-02", value: 15 },
    ]);
    expect(result.notes).toContain("Scanned 1.0 MB");

    expect(calls[0]!.url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/analytics/jobs",
    );
    const dry = JSON.parse(String(calls[0]!.init?.body));
    expect(dry.configuration.dryRun).toBe(true);
    expect(dry.configuration.query.query).toContain("BETWEEN '2026-09-01' AND '2026-09-02'");

    expect(calls[1]!.url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/analytics/queries",
    );
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body.useLegacySql).toBe(false);
    expect(body.defaultDataset).toEqual({ projectId: "analytics", datasetId: "prod" });
    expect(body.maximumBytesBilled).toBe(String(BIGQUERY_METRIC_MAX_BYTES_BILLED));
    expect(body.maxResults).toBe(101);
    expect(body.jobTimeoutMs).toBe("30000");
  });

  it("refuses when BigQuery reports a non-SELECT statement", async () => {
    const calls = mockFetch([() => ({ statistics: { query: { statementType: "SCRIPT" } } })]);
    await expect(runGcpBusinessMetricSource(ctx, params, range)).rejects.toThrow(/SCRIPT/);
    expect(calls).toHaveLength(1);
  });

  it("rejects writes before calling BigQuery at all", async () => {
    const calls = mockFetch([]);
    await expect(
      runGcpBusinessMetricSource(ctx, { ...params, sql: "DELETE FROM t WHERE true" }, range),
    ).rejects.toThrow(/SELECT or WITH/);
    expect(calls).toHaveLength(0);
  });

  it("polls getQueryResults until the job completes, then pages", async () => {
    const calls = mockFetch([
      dryRunSelect,
      () => ({
        jobComplete: false,
        jobReference: { projectId: "analytics", jobId: "j2", location: "EU" },
      }),
      () => ({
        jobComplete: true,
        schema: { fields: [{ name: "day" }, { name: "value" }, { name: "label" }] },
        rows: [{ f: [{ v: "2026-09-01" }, { v: "1.5" }, { v: "eu" }] }],
        totalRows: "2",
        pageToken: "p2",
      }),
      () => ({ rows: [{ f: [{ v: "2026-09-01" }, { v: "2" }, { v: null }] }] }),
    ]);
    const result = await runGcpBusinessMetricSource(ctx, params, range);
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 1.5, label: "eu" },
      { date: "2026-09-01", value: 2 },
    ]);
    const poll = new URL(calls[2]!.url);
    expect(poll.pathname).toBe("/bigquery/v2/projects/analytics/queries/j2");
    expect(poll.searchParams.get("location")).toBe("EU");
    expect(new URL(calls[3]!.url).searchParams.get("pageToken")).toBe("p2");
  });

  it("throws instead of truncating when totalRows exceeds maxRows", async () => {
    mockFetch([
      dryRunSelect,
      () => ({
        jobComplete: true,
        jobReference: { jobId: "j3" },
        schema: { fields: [{ name: "day" }, { name: "value" }] },
        rows: [{ f: [{ v: "2026-09-01" }, { v: "1" }] }],
        totalRows: "5000",
        pageToken: "more",
      }),
    ]);
    await expect(runGcpBusinessMetricSource(ctx, params, range)).rejects.toThrow(
      /more than 100 rows/,
    );
  });

  it("surfaces BigQuery's error message", async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ error: { message: "Unrecognized name: dayz" } }), {
          status: 400,
        }),
    ]);
    await expect(runGcpBusinessMetricSource(ctx, params, range)).rejects.toThrow(
      "BigQuery: Unrecognized name: dayz",
    );
  });
});

describe("dryRunGcpBusinessMetricSource", () => {
  it("reports bytes for a valid SELECT", async () => {
    mockFetch([dryRunSelect]);
    const result = await dryRunGcpBusinessMetricSource(ctx, params, range);
    expect(result).toMatchObject({ valid: true, bytesProcessed: 2048 });
  });

  it("returns valid:false with the provider message instead of throwing", async () => {
    mockFetch([
      () =>
        new Response(JSON.stringify({ error: { message: "Table not found: prod.t" } }), {
          status: 404,
        }),
    ]);
    const result = await dryRunGcpBusinessMetricSource(ctx, params, range);
    expect(result).toEqual({ valid: false, message: "BigQuery: Table not found: prod.t" });
  });

  it("flags a scan over the bytes-billed cap", async () => {
    mockFetch([
      () => ({
        statistics: {
          query: {
            statementType: "SELECT",
            totalBytesProcessed: String(BIGQUERY_METRIC_MAX_BYTES_BILLED + 1),
          },
        },
      }),
    ]);
    const result = await dryRunGcpBusinessMetricSource(ctx, params, range);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/100 GiB/);
  });
});

describe("listGcpBusinessMetricOptions", () => {
  it("falls back to the account project when listing fails", async () => {
    mockFetch([() => new Response("{}", { status: 403 })]);
    const options = await listGcpBusinessMetricOptions(ctx, "project", {});
    expect(options.map((o) => o.id)).toEqual(["acct-project"]);
  });

  it("lists datasets of the picked project, following page tokens", async () => {
    const calls = mockFetch([
      () => ({
        datasets: [{ datasetReference: { datasetId: "zeta" }, location: "US" }],
        nextPageToken: "n",
      }),
      () => ({ datasets: [{ datasetReference: { datasetId: "alpha" }, location: "EU" }] }),
    ]);
    const options = await listGcpBusinessMetricOptions(ctx, "dataset", { project: "analytics" });
    expect(options).toEqual([
      { id: "alpha", label: "alpha", description: "EU" },
      { id: "zeta", label: "zeta", description: "US" },
    ]);
    expect(new URL(calls[0]!.url).pathname).toBe("/bigquery/v2/projects/analytics/datasets");
  });

  it("lists tables of the picked dataset", async () => {
    mockFetch([() => ({ tables: [{ tableReference: { tableId: "orders" }, type: "TABLE" }] })]);
    const options = await listGcpBusinessMetricOptions(ctx, "table", {
      project: "analytics",
      dataset: "prod",
    });
    expect(options).toEqual([{ id: "orders", label: "orders", description: "table" }]);
  });
});

describe("bigQueryRowsToRecords", () => {
  it("converts float-second timestamps to ISO strings", () => {
    const [row] = bigQueryRowsToRecords(
      [{ name: "day", type: "TIMESTAMP" }],
      [{ f: [{ v: "1.7566848E9" }] }],
    );
    expect(row!["day"]).toBe("2025-09-01T00:00:00.000Z");
  });
});
