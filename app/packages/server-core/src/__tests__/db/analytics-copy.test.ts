/**
 * The one-off ClickHouse → Postgres copy (`analytics/clickhouse-copy.ts`)
 * against a real Postgres, with ClickHouse played by a stub `fetch` that
 * answers the way its HTTP interface does with the copy's settings: 64-bit
 * integers quoted, NaN as a string, date-times as ISO 8601 in UTC, maps as
 * JSON objects.
 *
 * Same rules as postgres.test.ts: skipped unless DATABASE_URL is set,
 * migrations already applied, scratch databases only. Every row it writes
 * belongs to an organization id of its own, deleted afterwards.
 */
import { randomUUID } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../db/client";

const configured = !!process.env["DATABASE_URL"];
const org = `test-org-${randomUUID()}`;

const MAX_U64 = "18446744073709551615";

/** Source rows per table, as ClickHouse would send them (before aliasing). */
const SOURCE: Record<string, Array<Record<string, unknown>>> = {
  cost_daily: [0, 1, 2].map((i) => ({
    organization_id: org,
    account_id: "acc-1",
    plugin_id: "aws",
    day: `2026-08-0${i + 1}`,
    service: "EC2",
    region: "us-east-1",
    resource_id: `i-${i}`,
    tags: i === 0 ? { team: "core", env: "prod" } : {},
    tags_hash: i === 0 ? MAX_U64 : String(i),
    currency: "USD",
    amount: 1.25 + i,
    usage_amount: 24,
    usage_unit: "Hrs",
    ingested_at: "2026-08-04T10:11:12Z",
    charge_type: "usage",
    amortized_amount: 0,
    amortized_reported: 0,
    commitment_id: "",
    list_amount: 0,
    list_reported: 0,
    blended_amount: 0,
    blended_reported: 0,
  })),
  network_flow_daily: [
    {
      organization_id: org,
      account_id: "acc-1",
      plugin_id: "aws",
      day: "2026-08-01",
      scope: "vpc",
      direction: "egress",
      attribution: "pair",
      pair_hash: MAX_U64,
      src_ref: "i-1",
      src_label: "web",
      src_zone: "us-east-1a",
      src_region: "us-east-1",
      src_service: "EC2",
      src_resource_type_id: "ec2",
      dst_ref: "internet",
      dst_label: "Internet",
      dst_zone: "",
      dst_region: "",
      dst_service: "",
      dst_resource_type_id: "",
      bytes: "9007199254740993",
      packets: "12",
      currency: "USD",
      rate_per_gb: 0.09,
      estimated_cost: 1.5,
      method: "flow_log",
      src_network: "vpc-1",
      dst_network: "",
      ingested_at: "2026-08-02T00:00:00Z",
    },
  ],
  ai_request_daily: [
    {
      organization_id: org,
      source_id: "src-1",
      day: "2026-08-01",
      collected_at: "2026-08-02T01:02:03.456Z",
      provider: "anthropic",
      model: "claude",
      metadata: { team: "core" },
      requests: "10",
      input_tokens: "1000",
      output_tokens: "200",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      reasoning_tokens: "0",
      reported_cost: 0.5,
      reported_cost_known: 1,
      reported_currency: "USD",
    },
  ],
  ai_cost_attributed: [
    {
      organization_id: org,
      account_id: "acc-1",
      plugin_id: "anthropic",
      day: "2026-08-01",
      service: "Claude",
      region: "",
      resource_id: "",
      tags: { "caller:team": "core" },
      tags_hash: "42",
      currency: "USD",
      amount: 0.5,
      usage_amount: 0,
      usage_unit: "",
      ingested_at: "2026-08-02T00:00:00Z",
      charge_type: "usage",
      amortized_amount: 0,
      amortized_reported: 0,
      commitment_id: "",
      run_at: "2026-08-02T03:00:00.000Z",
    },
  ],
  poll_outcomes: [1, 2].map((i) => ({
    organization_id: org,
    account_id: "acc-1",
    plugin_id: "aws",
    ts: `2026-08-01T00:0${i}:00Z`,
    duration_ms: 1500,
    resource_count: 40,
    succeeded_type_count: 10,
    failed_type_count: 0,
    skipped_type_count: 1,
    first_error: "",
  })),
  dashboard_stats: [
    {
      organization_id: org,
      account_id: "acc-1",
      resource_id: "i-1",
      ts: "2026-08-01T00:00:00Z",
      stats_json: '[{"label":"CPU","value":"3%"}]',
    },
  ],
  account_resource_counts: [
    {
      organization_id: org,
      account_id: "acc-1",
      ts: "2026-08-01T00:00:00Z",
      counts_json: '{"ec2":3}',
    },
  ],
  metric_points_raw: [
    { ts: "2026-08-01T00:00:00.000Z", value: 1 },
    { ts: "2026-08-01T00:00:30.500Z", value: 4 },
    { ts: "2026-08-01T00:01:00.000Z", value: "nan" },
  ].map((p) => ({
    organization_id: org,
    account_id: "acc-1",
    resource_id: "i-1",
    plugin_id: "aws",
    resource_type_id: "ec2",
    series_label: "cpu",
    unit: "%",
    ...p,
  })),
  metric_points_1m: [
    {
      organization_id: org,
      resource_id: "i-1",
      series_label: "cpu",
      unit: "%",
      ts_minute: "2026-08-01T00:00:00Z",
      value_sum: 2.5,
      value_count: 1,
      value_min: 1,
      value_max: 4,
    },
  ],
  metric_points_1h: [
    {
      organization_id: org,
      resource_id: "i-1",
      series_label: "cpu",
      unit: "%",
      ts_hour: "2026-08-01T00:00:00Z",
      value_sum: 2.5,
      value_count: 1,
      value_min: 1,
      value_max: 4,
    },
  ],
};

interface Call {
  url: URL;
  headers: Record<string, string>;
  query: string;
}

const calls: Call[] = [];

/** ClickHouse's HTTP interface, as far as the copy uses it. */
const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const query = String(init?.body ?? "");
  calls.push({
    url: new URL(String(input)),
    headers: init?.headers as Record<string, string>,
    query,
  });
  const table = /FROM `([a-z0-9_]+)`/.exec(query)?.[1] ?? "";
  const rows = SOURCE[table];
  if (!rows) return new Response(`Code: 60. Unknown table ${table}`, { status: 404 });
  if (query.startsWith("SELECT count() AS n")) {
    return new Response(JSON.stringify({ n: String(rows.length) }) + "\n");
  }
  const [, limit, offset] = /LIMIT (\d+) OFFSET (\d+)/.exec(query)!;
  const page = rows.slice(Number(offset), Number(offset) + Number(limit));
  const body = page
    .map((row) =>
      JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [`c_${k}`, v]))),
    )
    .join("\n");
  return new Response(body ? body + "\n" : "");
}) as typeof fetch;

const SOURCE_CONFIG = {
  url: "https://clickhouse.example.test",
  user: "infrawrench",
  password: "not-a-secret",
  database: "infrawrench",
  headers: { "CF-Access-Client-Id": "id.access" },
};

describe.skipIf(!configured)("copying ClickHouse analytics into a real Postgres", () => {
  let db: Db;
  let close: () => Promise<void>;
  let copy: typeof import("../../analytics/clickhouse-copy");

  beforeAll(async () => {
    const client = await import("../../db/client");
    ({ db, close } = client.createDb(process.env["DATABASE_URL"]!, { max: 2 }));
    copy = await import("../../analytics/clickhouse-copy");
  });

  afterAll(async () => {
    if (!configured) return;
    for (const table of Object.keys(SOURCE)) {
      await db.$client.unsafe(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
    }
    await close();
  });

  async function rowsFor(table: string): Promise<Array<Record<string, unknown>>> {
    return db.$client.unsafe(`SELECT * FROM ${table} WHERE organization_id = $1`, [org]);
  }

  it("counts both sides and writes nothing on a dry run", async () => {
    const results = await copy.copyClickHouseToPostgres({
      db,
      source: SOURCE_CONFIG,
      dryRun: true,
      fetch: stubFetch,
    });

    expect(results.map((r) => r.table)).toEqual(copy.COPY_TABLES.map((s) => getTableName(s.table)));
    for (const r of results) {
      expect(r.source).toBe(SOURCE[r.table]!.length);
      expect(r.inserted).toBe(0);
    }
    for (const table of Object.keys(SOURCE)) expect(await rowsFor(table)).toEqual([]);
    expect(calls.every((c) => c.query.startsWith("SELECT count()"))).toBe(true);
  });

  it("asks ClickHouse for lossless output, with its own User-Agent and the extra headers", () => {
    const call = calls[0]!;
    expect(call.url.searchParams.get("database")).toBe("infrawrench");
    expect(call.url.searchParams.get("output_format_json_quote_64bit_integers")).toBe("1");
    expect(call.url.searchParams.get("date_time_output_format")).toBe("iso");
    expect(call.headers["User-Agent"]).toBe("infrawrench-copy/1");
    expect(call.headers["X-ClickHouse-User"]).toBe("infrawrench");
    expect(call.headers["CF-Access-Client-Id"]).toBe("id.access");
  });

  it("copies every table, a page at a time", async () => {
    calls.length = 0;
    const results = await copy.copyClickHouseToPostgres({
      db,
      source: SOURCE_CONFIG,
      pageSize: 2,
      fetch: stubFetch,
    });

    for (const r of results) {
      expect(r.inserted, r.table).toBe(SOURCE[r.table]!.length);
      expect(r.destination, r.table).toBeGreaterThanOrEqual(r.source);
    }
    // Three cost rows at two a page: two pages.
    expect(calls.filter((c) => c.query.includes("FROM `cost_daily` FINAL ORDER BY"))).toHaveLength(
      2,
    );

    const cost = await rowsFor("cost_daily");
    const tagged = cost.find((r) => r["resource_id"] === "i-0")!;
    expect(tagged["tags_hash"]).toBe(MAX_U64);
    expect(tagged["tags"]).toEqual({ team: "core", env: "prod" });
    const days = await db.$client.unsafe(
      `SELECT day::text AS day FROM cost_daily WHERE organization_id = $1 ORDER BY day`,
      [org],
    );
    expect(days.map((r) => r["day"])).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(new Date(tagged["ingested_at"] as string).toISOString()).toBe(
      "2026-08-04T10:11:12.000Z",
    );

    const [flow] = await rowsFor("network_flow_daily");
    expect(flow!["pair_hash"]).toBe(MAX_U64);
    expect(String(flow!["bytes"])).toBe("9007199254740993");

    const raw = await rowsFor("metric_points_raw");
    expect(raw.map((r) => Number(r["value"])).sort()).toEqual([1, 4, NaN]);

    const [minute] = await rowsFor("metric_points_1m");
    expect(Number(minute!["value_sum"]) / Number(minute!["value_count"])).toBe(2.5);
    expect([minute!["value_min"], minute!["value_max"]]).toEqual([1, 4]);

    const [request] = await rowsFor("ai_request_daily");
    expect(new Date(request!["collected_at"] as string).toISOString()).toBe(
      "2026-08-02T01:02:03.456Z",
    );
    expect(request!["metadata"]).toEqual({ team: "core" });
  });

  it("inserts nothing on a rerun, and keeps a row the app wrote since", async () => {
    await db.$client.unsafe(
      `UPDATE cost_daily SET amount = 99 WHERE organization_id = $1 AND resource_id = 'i-1'`,
      [org],
    );

    const results = await copy.copyClickHouseToPostgres({
      db,
      source: SOURCE_CONFIG,
      fetch: stubFetch,
    });

    expect(results.map((r) => [r.table, r.inserted])).toEqual(results.map((r) => [r.table, 0]));
    for (const table of Object.keys(SOURCE)) {
      expect(await rowsFor(table), table).toHaveLength(SOURCE[table]!.length);
    }
    const kept = (await rowsFor("cost_daily")).find((r) => r["resource_id"] === "i-1")!;
    expect(kept["amount"]).toBe(99);
  });

  it("reports a table that holds fewer rows than its source", () => {
    const report = copy.formatCopyReport(
      [
        { table: "cost_daily", source: 3, inserted: 3, destination: 3 },
        { table: "poll_outcomes", source: 5, inserted: 2, destination: 2 },
      ],
      false,
    );
    expect(report).toContain("Fewer rows than the source: poll_outcomes.");
  });
});
