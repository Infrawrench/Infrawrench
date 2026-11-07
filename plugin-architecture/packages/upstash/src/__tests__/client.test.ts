import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstashClient, statsPeriod } from "../client.js";
import { parseUpstashTime, redisConnectionString } from "../mappers.js";
import { mapComponent } from "../status-feed.js";
import { upstashTerraformExport } from "../terraform.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function mockFetch(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ method: string; url: URL; headers: Record<string, string>; body: unknown }> =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = (init.method ?? "GET").toUpperCase();
      let body: unknown = init.body;
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method, url, headers: init.headers as Record<string, string>, body });
      const handler = routes[`${method} ${url.host}${url.pathname}`];
      if (handler === undefined)
        return new Response(`no route ${url.host}${url.pathname}`, { status: 404 });
      const value = typeof handler === "function" ? (handler as Handler)(url, init) : handler;
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ACC = "acc";
const API = "api.upstash.com/v2";
const creds = { email: "me@example.com", apiKey: "key" };

describe("Developer API", () => {
  it("uses Basic auth with email and key and maps databases", async () => {
    const calls = mockFetch({
      [`GET ${API}/redis/databases`]: [
        {
          database_id: "db1",
          database_name: "cache",
          region: "global",
          primary_region: "eu-west-1",
          read_regions: ["us-east-1"],
          endpoint: "happy-cat-123",
          port: 6379,
          tls: true,
          type: "payg",
          db_disk_threshold: 107374182400,
          creation_time: 1752649602,
        },
      ],
    });
    const [db] = await hostClient(new UpstashClient(creds)).listResources("upstash-redis", ACC);
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("me@example.com:key")}`);
    expect(db!.fields).toMatchObject({
      region: "eu-west-1",
      platform: "aws",
      readRegions: "us-east-1",
      endpoint: "happy-cat-123.upstash.io",
      diskLimitGb: 100,
    });
    expect(db!.fields["createdAt"]).toBe("2025-07-16T07:06:42.000Z");
  });

  it("explains a 401 and carries the status", async () => {
    mockFetch({ [`GET ${API}/redis/databases`]: new Response("Unauthorized", { status: 401 }) });
    const err = await hostClient(new UpstashClient(creds))
      .listResources("upstash-redis", ACC)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(401);
    expect(String((err as Error).message)).toMatch(/Vercel/);
  });

  it("builds the Redis connection string and REST outputs", async () => {
    mockFetch({
      [`GET ${API}/redis/database/db1`]: {
        database_id: "db1",
        endpoint: "happy-cat-123.upstash.io",
        port: 6379,
        tls: true,
        password: "p@ss",
        rest_token: "rt",
      },
    });
    const c = hostClient(new UpstashClient(creds));
    const id = `${ACC}:upstash-redis:db1`;
    expect(await c.resolveOutput("upstash-redis", id, "connectionString", ACC)).toBe(
      "rediss://default:p%40ss@happy-cat-123.upstash.io:6379",
    );
    expect(await c.resolveOutput("upstash-redis", id, "restUrl", ACC)).toBe(
      "https://happy-cat-123.upstash.io",
    );
    expect(await c.resolveOutput("upstash-redis", id, "restToken", ACC)).toBe("rt");
  });

  it("refuses read regions on another cloud", async () => {
    mockFetch({
      [`GET ${API}/redis/database/db1`]: { database_id: "db1", primary_region: "us-east-1" },
    });
    await expect(
      hostClient(new UpstashClient(creds)).executeNoSqlCommand(
        "upstash-redis",
        `${ACC}:upstash-redis:db1`,
        ACC,
        "update-regions",
        [JSON.stringify({ readRegions: JSON.stringify(["eu-west-1", "us-central1"]) })],
      ),
    ).rejects.toThrow(/us-central1/);
  });

  it("turns daily billing into cost rows inside the range", async () => {
    mockFetch({
      [`GET ${API}/redis/databases`]: [
        { database_id: "db1", database_name: "cache", type: "payg", primary_region: "eu-west-1" },
      ],
      [`GET ${API}/qstash/users`]: [{ id: "q1", type: "free", region: "eu-central-1" }],
      [`GET ${API}/redis/stats/db1`]: {
        dailybilling: [
          { x: "2026-10-01 15:12:52.799480932 +0000 UTC", y: 0.5 },
          { x: "2026-10-02 15:12:52.799480932 +0000 UTC", y: 1.25 },
          { x: "2026-09-20 15:12:52.799480932 +0000 UTC", y: 9 },
        ],
      },
    });
    const rows = await hostClient(new UpstashClient(creds)).fetchCostData(ACC, {
      fromDate: "2026-10-01",
      toDate: "2026-10-05",
    });
    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-10-01",
        amount: 0.5,
        service: "Redis",
        resourceId: "db1",
        region: "eu-west-1",
      }),
      expect.objectContaining({ date: "2026-10-02", amount: 1.25 }),
    ]);
  });
});

describe("QStash", () => {
  const users = [
    {
      id: "q1",
      token: "qtok",
      region: "us-east-1",
      max_schedules: 10,
      max_queues: 5,
      max_topics: 0,
    },
  ];

  it("talks to the regional host with the account's token", async () => {
    const calls = mockFetch({
      [`GET ${API}/qstash/users`]: users,
      "GET qstash-us-east-1.upstash.io/v2/schedules": [
        {
          scheduleId: "s1",
          cron: "0 * * * *",
          destination: "https://x.dev/h",
          isPaused: true,
          createdAt: 1759000000000,
        },
      ],
    });
    const [s] = await hostClient(new UpstashClient(creds)).listResources(
      "upstash-qstash-schedule",
      ACC,
    );
    expect(s!.externalId).toBe("q1/s1");
    expect(s!.fields["paused"]).toBe(true);
    expect(s!.parentResourceId).toBe(`${ACC}:upstash-qstash:q1`);
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer qtok");
  });

  it("creates a schedule with Upstash headers and the raw URL in the path", async () => {
    const calls = mockFetch({
      [`GET ${API}/qstash/users`]: users,
      "POST qstash-us-east-1.upstash.io/v2/schedules/https://x.dev/h": { scheduleId: "s9" },
      "GET qstash-us-east-1.upstash.io/v2/schedules/s9": {
        scheduleId: "s9",
        cron: "*/5 * * * *",
        destination: "https://x.dev/h",
      },
    });
    const r = await hostClient(new UpstashClient(creds)).createResource(
      "upstash-qstash-schedule",
      ACC,
      {
        qstashId: "q1",
        destination: "https://x.dev/h",
        cron: "*/5 * * * *",
        retries: "2",
        body: '{"a":1}',
      },
    );
    expect(r.externalId).toBe("q1/s9");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers["Upstash-Cron"]).toBe("*/5 * * * *");
    expect(post.headers["Upstash-Retries"]).toBe("2");
    expect(post.body).toEqual({ a: 1 });
  });

  it("diffs URL group endpoints on edit", async () => {
    const calls = mockFetch({
      [`GET ${API}/qstash/users`]: users,
      "GET qstash-us-east-1.upstash.io/v2/topics/g": {
        name: "g",
        endpoints: [{ url: "https://a" }, { url: "https://b" }],
      },
      "POST qstash-us-east-1.upstash.io/v2/topics/g/endpoints": {},
      "DELETE qstash-us-east-1.upstash.io/v2/topics/g/endpoints": {},
    });
    await hostClient(new UpstashClient(creds)).updateResource(
      "upstash-qstash-url-group",
      `${ACC}:upstash-qstash-url-group:q1/g`,
      ACC,
      {
        endpoints: "https://b, https://c",
      },
    );
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      endpoints: [{ url: "https://c" }],
    });
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({
      endpoints: [{ url: "https://a" }],
    });
  });

  it("reports QStash limits as quotas, skipping unlimited ones", async () => {
    mockFetch({
      [`GET ${API}/qstash/users`]: users,
      [`GET ${API}/redis/databases`]: [],
      "GET qstash-us-east-1.upstash.io/v2/schedules": [{ scheduleId: "a" }, { scheduleId: "b" }],
      "GET qstash-us-east-1.upstash.io/v2/queues": [],
      "GET qstash-us-east-1.upstash.io/v2/topics": [],
    });
    const quotas = await hostClient(new UpstashClient(creds)).fetchQuotas(ACC);
    expect(quotas.map((q) => [q.name, q.used, q.limit])).toEqual([
      ["Schedules", 2, 10],
      ["Queues", 0, 5],
    ]);
  });
});

describe("Redis metrics", () => {
  const ID = `${ACC}:upstash-redis:db1`;
  const stats = `GET ${API}/redis/stats/db1`;
  const answer = { throughput: [{ x: "2026-10-01 15:12:52.799480932 +0000 UTC", y: 1 }] };
  const sent = (calls: ReturnType<typeof mockFetch>) =>
    calls.map((c) => c.url.searchParams.get("period"));

  it("asks for the period that covers the selected range", async () => {
    const calls = mockFetch({ [stats]: answer });
    const series = await hostClient(new UpstashClient(creds)).fetchMetricSeries(
      "upstash-redis",
      ID,
      ACC,
      { startMs: 0, endMs: 5 * 86_400_000 },
    );
    expect(sent(calls)).toEqual(["7d"]);
    expect(series.map((s) => s.label)).toEqual(["Throughput"]);
  });

  it("asks for an hour with no range selected", async () => {
    const calls = mockFetch({ [stats]: answer });
    await hostClient(new UpstashClient(creds)).fetchMetricSeries("upstash-redis", ID, ACC);
    expect(sent(calls)).toEqual(["1h"]);
  });

  it("falls back to 7d when the plan refuses 30d", async () => {
    const calls = mockFetch({
      [stats]: (url: URL) =>
        url.searchParams.get("period") === "30d"
          ? new Response("30d needs a Pro plan", { status: 400 })
          : answer,
    });
    const series = await hostClient(new UpstashClient(creds)).fetchMetricSeries(
      "upstash-redis",
      ID,
      ACC,
      { startMs: 0, endMs: 20 * 86_400_000 },
    );
    expect(sent(calls)).toEqual(["30d", "7d"]);
    expect(series).toHaveLength(1);
  });

  it("does not retry a refusal of a shorter period, or a server failure", async () => {
    const short = mockFetch({ [stats]: new Response("nope", { status: 403 }) });
    await expect(
      hostClient(new UpstashClient(creds)).fetchMetricSeries("upstash-redis", ID, ACC),
    ).rejects.toThrow(/403/);
    expect(sent(short)).toEqual(["1h"]);

    const failing = mockFetch({ [stats]: new Response("down", { status: 503 }) });
    await expect(
      hostClient(new UpstashClient(creds)).fetchMetricSeries("upstash-redis", ID, ACC, {
        startMs: 0,
        endMs: 20 * 86_400_000,
      }),
    ).rejects.toThrow(/503/);
    expect(sent(failing)).toEqual(["30d"]);
  });
});

describe("Redis owner", () => {
  const listed = async (db: object) => {
    mockFetch({ [`GET ${API}/redis/databases`]: [{ database_id: "db1", ...db }] });
    const [r] = await hostClient(new UpstashClient(creds)).listResources("upstash-redis", ACC);
    return r!.fields["owner"];
  };

  it("reads the documented user_email", async () => {
    expect(await listed({ user_email: "owner@example.com" })).toBe("owner@example.com");
  });

  it("prefers user_email and still reads an undocumented customer_id", async () => {
    expect(await listed({ user_email: "owner@example.com", customer_id: "old" })).toBe(
      "owner@example.com",
    );
    expect(await listed({ user_email: "", customer_id: "old" })).toBe("old");
  });
});

describe("QStash message log", () => {
  const LOGS = "GET qstash-us-east-1.upstash.io/v2/logs";
  const route = {
    [`GET ${API}/qstash/users`]: [{ id: "q1", token: "qtok", region: "us-east-1" }],
  };
  /** Newest first, as the plugin has always read it, 1000 entries behind a numeric cursor. */
  const pages = (url: URL) => {
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const count = Number(url.searchParams.get("count"));
    if (count > 100) return new Response("count is at most 100", { status: 400 });
    const logs = Array.from({ length: count }, (_, i) => ({
      time: 1_700_000_000_000 - (from + i) * 1000,
      messageId: `m${from + i}`,
      state: "DELIVERED",
    }));
    return { cursor: String(from + count), logs };
  };
  const logCalls = (calls: ReturnType<typeof mockFetch>) =>
    calls.filter((c) => c.url.pathname === "/v2/logs");
  const lines = (text: string) => text.trim().split("\n");

  it("never asks for more than 100, and pages to the lines asked for", async () => {
    const calls = mockFetch({ ...route, [LOGS]: pages });
    const res = await hostClient(new UpstashClient(creds)).getLogs(
      "upstash-qstash",
      `${ACC}:upstash-qstash:q1`,
      ACC,
      { tailLines: 250 },
    );
    expect(logCalls(calls).map((c) => c.url.searchParams.get("count"))).toEqual([
      "100",
      "100",
      "50",
    ]);
    expect(logCalls(calls).map((c) => c.url.searchParams.get("cursor"))).toEqual([
      null,
      "100",
      "200",
    ]);
    const out = lines(res.text);
    expect(out).toHaveLength(250);
    expect(out[0]).toContain("m249");
    expect(out[249]).toContain("m0");
  });

  it("makes one request for the default tail", async () => {
    const calls = mockFetch({ ...route, [LOGS]: pages });
    const res = await hostClient(new UpstashClient(creds)).getLogs(
      "upstash-qstash",
      `${ACC}:upstash-qstash:q1`,
      ACC,
      {},
    );
    expect(logCalls(calls)).toHaveLength(1);
    expect(lines(res.text)).toHaveLength(100);
  });

  it("stops where no cursor comes back, and on an empty page", async () => {
    const entry = { time: 1_700_000_000_000, messageId: "m", state: "ERROR" };
    const ended = mockFetch({ ...route, [LOGS]: { logs: [entry] } });
    const c = hostClient(new UpstashClient(creds));
    const id = `${ACC}:upstash-qstash:q1`;
    expect(
      lines((await c.getLogs("upstash-qstash", id, ACC, { tailLines: 500 })).text),
    ).toHaveLength(1);
    expect(logCalls(ended)).toHaveLength(1);

    const empty = mockFetch({ ...route, [LOGS]: { cursor: "again", logs: [] } });
    const res = await hostClient(new UpstashClient(creds)).getLogs("upstash-qstash", id, ACC, {
      tailLines: 500,
    });
    expect(res.text).toBe("No message logs.\n");
    expect(logCalls(empty)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parses Go timestamps", () => {
    expect(parseUpstashTime("2025-09-04 15:12:52.76649148 +0000 UTC")).toBe(
      Date.parse("2025-09-04T15:12:52.766Z"),
    );
  });

  it("picks a stats period that covers the range", () => {
    expect(statsPeriod(3_600_000)).toBe("1h");
    expect(statsPeriod(5 * 86_400_000)).toBe("7d");
  });

  it("uses redis:// when TLS is off", () => {
    expect(redisConnectionString({ endpoint: "x.upstash.io", port: 1, tls: false })).toBe(
      "redis://x.upstash.io:1",
    );
  });

  it("maps status components to products and regions", () => {
    expect(mapComponent("N. Virginia, USA (us-east-1)")).toMatchObject({
      regions: ["us-east-1"],
      resourceTypes: ["upstash-redis"],
    });
    expect(mapComponent("AWS - EU-WEST-1")).toMatchObject({
      regions: ["eu-west-1"],
      resourceTypes: ["upstash-vector"],
    });
    expect(mapComponent("GCP US-CENTRAL-1")).toMatchObject({ regions: ["us-central1"] });
    expect(mapComponent("EU-CENTRAL-1")?.resourceTypes).toContain("upstash-qstash");
    expect(mapComponent("Context7")).toBeNull();
    expect(mapComponent("Upstash Console")?.providerWide).toBe(true);
  });

  it("exports a Redis database for Terraform with its id as the import id", () => {
    const out = upstashTerraformExport.mapResource({
      id: "a:upstash-redis:db1",
      pluginId: "upstash",
      resourceTypeId: "upstash-redis",
      accountId: "a",
      displayName: "cache",
      fields: { name: "cache", region: "eu-west-1", readRegions: "eu-west-2", eviction: true },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "db1",
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.importId).toBe("db1");
    expect(out?.resource.attributes["region"]).toEqual({ kind: "string", value: "global" });
    expect(out?.resource.attributes["primary_region"]).toEqual({
      kind: "string",
      value: "eu-west-1",
    });
  });
});
