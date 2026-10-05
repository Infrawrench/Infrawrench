import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the @clickhouse/client-web SDK -----------------------------------
interface QueryCall {
  query: string;
  clickhouse_settings?: Record<string, unknown>;
  abort_signal?: AbortSignal;
}

const sdk: {
  createArgs: Array<Record<string, unknown>>;
  queries: QueryCall[];
  respond: (q: QueryCall) => { rows: unknown[]; headers?: Record<string, string> };
  closed: number;
} = {
  createArgs: [],
  queries: [],
  respond: () => ({ rows: [] }),
  closed: 0,
};

vi.mock("@clickhouse/client-web", () => ({
  createClient: (args: Record<string, unknown>) => {
    sdk.createArgs.push(args);
    return {
      query: async (q: QueryCall) => {
        sdk.queries.push(q);
        const { rows, headers } = sdk.respond(q);
        return { json: async () => rows, response_headers: headers ?? {} };
      },
      close: async () => {
        sdk.closed++;
      },
    };
  },
}));

import {
  clickhouseBusinessMetricSource,
  listClickHouseBusinessMetricOptions,
  runClickHouseBusinessMetricSource,
} from "../business-metric-source.js";
import { ClickHouseClient } from "../client.js";
import { plugin } from "../plugin.js";

const BASE_CREDS = {
  apiKeyId: "kid",
  apiKeySecret: "ksecret",
  organizationId: "org-1",
  chUser: "reporter",
  chPassword: "pw",
};
const CREDS = { ...BASE_CREDS, chHost: "abc.us-east-1.aws.clickhouse.cloud" };

const range = {
  from: "2026-09-01",
  to: "2026-09-02",
  timezone: "Europe/Berlin",
  maxRows: 2,
  timeoutMs: 20_000,
};
const params = {
  database: "analytics",
  sql: "SELECT toDate(ts) AS day, count() AS value FROM events WHERE toDate(ts) BETWEEN {{from}} AND {{to}} GROUP BY day",
};

function readonlyError(message: string) {
  return Object.assign(new Error(message), { code: "164", type: "READONLY" });
}

beforeEach(() => {
  sdk.createArgs = [];
  sdk.queries = [];
  sdk.closed = 0;
  sdk.respond = () => ({ rows: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("clickhouse business metric source manifest", () => {
  it("is declared on the plugin with the expected fields", () => {
    expect(plugin.manifest.businessMetricSource).toBe(clickhouseBusinessMetricSource);
    expect(clickhouseBusinessMetricSource.fields.map((f) => f.key)).toEqual(["database", "sql"]);
    expect(clickhouseBusinessMetricSource.readOnly).toBe("enforced");
  });
});

describe("runBusinessMetricSource", () => {
  it("runs the bound query read-only and bounded on the configured service", async () => {
    sdk.respond = () => ({
      rows: [
        { day: "2026-09-01", value: "10" },
        { day: "2026-09-02", value: "11" },
      ],
      headers: { "x-clickhouse-summary": '{"read_rows":"1500","read_bytes":"2048"}' },
    });
    const client = new ClickHouseClient(CREDS);
    const result = await client.runBusinessMetricSource("acct", params, range);
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 10 },
      { date: "2026-09-02", value: 11 },
    ]);
    expect(result.notes).toEqual(["2 rows", "Read 1.5K rows, 2.0 KB"]);

    expect(sdk.createArgs[0]).toMatchObject({
      url: "https://abc.us-east-1.aws.clickhouse.cloud:8443",
      username: "reporter",
      password: "pw",
      database: "analytics",
      request_timeout: 25_000,
    });
    const q = sdk.queries[0]!;
    expect(q.query).toContain("BETWEEN '2026-09-01' AND '2026-09-02'");
    expect(q.clickhouse_settings).toEqual({
      readonly: "1",
      max_result_rows: "2",
      result_overflow_mode: "throw",
      max_execution_time: 20,
      timeout_overflow_mode: "throw",
      session_timezone: "Europe/Berlin",
    });
    expect(sdk.closed).toBe(1);
  });

  it("rejects writes before contacting ClickHouse", async () => {
    const client = new ClickHouseClient(CREDS);
    await expect(
      client.runBusinessMetricSource("acct", { sql: "INSERT INTO t VALUES (1)" }, range),
    ).rejects.toThrow(/SELECT or WITH/);
    expect(sdk.queries).toHaveLength(0);
  });

  it("explains a missing SQL connection", async () => {
    const client = new ClickHouseClient(BASE_CREDS);
    await expect(client.runBusinessMetricSource("acct", params, range)).rejects.toThrow(
      /no SQL connection/,
    );
  });

  it("turns ClickHouse's result limit into a row-cap error", async () => {
    sdk.respond = () => {
      throw Object.assign(new Error("Limit for result exceeded, max rows: 2.00"), {
        code: "396",
        type: "TOO_MANY_ROWS_OR_BYTES",
      });
    };
    const client = new ClickHouseClient(CREDS);
    await expect(client.runBusinessMetricSource("acct", params, range)).rejects.toThrow(
      /more than 2 rows/,
    );
  });

  it("still throws on overflow when the server returns too many rows", async () => {
    sdk.respond = () => ({
      rows: [
        { day: "2026-09-01", value: 1 },
        { day: "2026-09-02", value: 1 },
        { day: "2026-09-03", value: 1 },
      ],
    });
    const client = new ClickHouseClient(CREDS);
    await expect(client.runBusinessMetricSource("acct", params, range)).rejects.toThrow(
      /more than 2 rows/,
    );
  });

  it("falls back to the bounds alone when the profile is readonly=2", async () => {
    sdk.respond = (q) => {
      if (q.query.includes("getSetting('readonly')")) return { rows: [{ ro: "2" }] };
      if (q.clickhouse_settings?.["readonly"]) {
        throw readonlyError("Cannot modify 'readonly' setting in readonly mode");
      }
      return { rows: [{ day: "2026-09-01", value: 3 }] };
    };
    const client = new ClickHouseClient(CREDS);
    const result = await client.runBusinessMetricSource("acct", params, range);
    expect(result.points).toEqual([{ date: "2026-09-01", value: 3 }]);
    expect(result.notes).toContain("Read-only through the SQL user's profile");
    const last = sdk.queries.at(-1)!;
    expect(last.clickhouse_settings).toMatchObject({ max_result_rows: "2" });
    expect(last.clickhouse_settings?.["readonly"]).toBeUndefined();
  });

  it("falls back to no settings when the profile is readonly=1", async () => {
    sdk.respond = (q) => {
      if (q.query.includes("getSetting('readonly')")) return { rows: [{ ro: "1" }] };
      if (q.clickhouse_settings && Object.keys(q.clickhouse_settings).length > 0) {
        throw readonlyError("Cannot modify 'max_result_rows' setting in readonly mode");
      }
      return { rows: [{ day: "2026-09-01", value: 3 }] };
    };
    const client = new ClickHouseClient(CREDS);
    await client.runBusinessMetricSource("acct", params, range);
    expect(sdk.queries.at(-1)!.clickhouse_settings).toEqual({});
  });

  it("never drops readonly when the refusal came from the query itself", async () => {
    sdk.respond = (q) => {
      if (q.query.includes("getSetting('readonly')")) return { rows: [{ ro: "0" }] };
      throw readonlyError("Cannot modify 'max_threads' setting in readonly mode");
    };
    const client = new ClickHouseClient(CREDS);
    await expect(
      client.runBusinessMetricSource(
        "acct",
        { ...params, sql: `${params.sql} SETTINGS max_threads = 64` },
        range,
      ),
    ).rejects.toThrow(/ClickHouse query failed: Cannot modify 'max_threads'/);
    const dataQueries = sdk.queries.filter((q) => !q.query.includes("getSetting"));
    expect(dataQueries).toHaveLength(1);
    expect(dataQueries[0]!.clickhouse_settings?.["readonly"]).toBe("1");
  });
});

describe("listBusinessMetricSourceOptions", () => {
  it("lists databases on the configured service, without system ones", async () => {
    sdk.respond = () => ({
      rows: [
        { name: "INFORMATION_SCHEMA", engine: "Memory" },
        { name: "analytics", engine: "Replicated", comment: "Product events" },
        { name: "default", engine: "Replicated" },
        { name: "system", engine: "Atomic" },
      ],
    });
    const options = await new ClickHouseClient(CREDS).listBusinessMetricSourceOptions(
      "acct",
      "database",
      {},
    );
    expect(options).toEqual([
      { id: "analytics", label: "analytics", description: "Product events" },
      { id: "default", label: "default", description: "Replicated" },
    ]);
  });

  it("explains a missing SQL connection", async () => {
    await expect(
      listClickHouseBusinessMetricOptions({ makeClient: () => null }, "database", {}),
    ).rejects.toThrow(/no SQL connection/);
  });

  it("returns nothing for fields without choices", async () => {
    const client = new ClickHouseClient(CREDS);
    expect(await client.listBusinessMetricSourceOptions("acct", "sql", {})).toEqual([]);
  });
});
