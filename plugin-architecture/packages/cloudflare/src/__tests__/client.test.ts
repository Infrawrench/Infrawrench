import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudflareClient } from "../client.js";
import { asyncIter } from "./_helpers.js";

/**
 * Build a CloudflareClient whose private `api` is replaced with a fake whose
 * `cf.*` namespaces are all stubbed. The dispatcher delegates to the per-feature
 * client modules (tested elsewhere); here we assert the dispatch wiring, the
 * id-parsing, and the pure renderers/config builders.
 */
function ok<T>(value: T) {
  return vi.fn(async () => value);
}
function iter<T>(items: T[]) {
  return vi.fn(() => asyncIter(items));
}

function makeClient(apiOver: Record<string, unknown> = {}) {
  const client = new CloudflareClient({ apiToken: "tok" }, [
    { id: "zone", name: "Zone", fields: [] },
  ] as never);
  const fakeApi = {
    apiToken: "tok",
    baseUrl: "https://api.cloudflare.com/client/v4",
    getAccountId: ok("acct-cf"),
    getZoneOptions: ok([{ id: "z1", label: "a.com" }]),
    getAccessAppOptions: ok([{ id: "app1", label: "App" }]),
    listZones: ok([{ id: "z1", name: "a.com" }]),
    fetch: ok([]),
    collect: async <T>(it: AsyncIterable<T>): Promise<T[]> => {
      const out: T[] = [];
      for await (const x of it) out.push(x);
      return out;
    },
    cf: {
      put: ok({}),
      zones: { list: iter([{ id: "z1", name: "a.com", account: { id: "acct-cf" } }]) },
      dns: { records: { list: iter([]) } },
      workers: { scripts: { list: iter([]) }, routes: { list: iter([]) } },
      pages: { projects: { list: iter([]) } },
      r2: { buckets: { list: ok({ buckets: [] }), get: ok({ name: "b1", location: "wnam" }) } },
      kv: { namespaces: { list: iter([]) } },
      d1: { database: { list: iter([]), query: iter([]) } },
      queues: { list: iter([]) },
      zeroTrust: {
        tunnels: { cloudflared: { list: iter([]) } },
        access: { applications: { list: iter([]) } },
      },
      customCertificates: { list: iter([]) },
      pageRules: { list: ok([]) },
      rulesets: { list: iter([]) },
      loadBalancers: { list: iter([]) },
      customHostnames: { list: iter([]) },
      hyperdrive: { configs: { list: iter([]) } },
      emailRouting: { rules: { list: iter([]) } },
      waitingRooms: { list: iter([]) },
      spectrum: { apps: { list: iter([]) } },
      logpush: { jobs: { list: iter([]) } },
      firewall: { accessRules: { list: iter([]) } },
      turnstile: { widgets: { list: iter([]) } },
      healthchecks: { list: iter([]) },
      alerting: { policies: { list: iter([]) } },
    },
    ...apiOver,
  };
  (client as unknown as { api: unknown }).api = fakeApi;
  return { client, fakeApi };
}

describe("CloudflareClient constructor", () => {
  it("throws without an apiToken", () => {
    expect(() => new CloudflareClient({})).toThrow(/missing apiToken/);
  });
});

describe("CloudflareClient.listResources dispatch", () => {
  const types = [
    "zone",
    "dns-record",
    "worker",
    "r2-bucket",
    "kv-namespace",
    "d1-database",
    "queue",
    "tunnel",
    "ssl-certificate",
    "page-rule",
    "firewall-rule",
    "access-application",
    "load-balancer",
    "worker-route",
    "custom-hostname",
    "hyperdrive",
    "email-routing-rule",
    "waiting-room",
    "access-policy",
    "spectrum-application",
    "logpush-job",
    "rate-limit-rule",
    "redirect-rule",
    "cache-rule",
    "ip-access-rule",
    "turnstile-widget",
    "healthcheck",
    "notification-policy",
  ];

  it("dispatches each known type without throwing", async () => {
    const { client } = makeClient();
    for (const t of types) {
      const out = await client.listResources(t, "acct");
      expect(Array.isArray(out)).toBe(true);
    }
  });

  it("throws on an unknown type", async () => {
    const { client } = makeClient();
    await expect(client.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
  });

  it("workers-ai-model lists via raw fetch", async () => {
    const { client, fakeApi } = makeClient();
    (fakeApi.fetch as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: "@cf/x" }]);
    const out = await client.listResources("workers-ai-model", "acct");
    expect(out[0]!.externalId).toBe("@cf/x");
  });
});

describe("CloudflareClient.getResource", () => {
  it("getResource(zone) fetches a single zone", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.zones = {
      ...fakeApi.cf.zones,
      get: ok({ id: "z1", name: "a.com", status: "active", account: { id: "acct-cf" } }),
    } as never;
    const out = await client.getResource("zone", "acct:zone:z1", "acct");
    expect(out.externalId).toBe("z1");
  });

  it("getResource falls back to list-and-find", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.workers.scripts.list = iter([{ id: "w1" }]) as never;
    const out = await client.getResource("worker", "acct:worker:w1", "acct");
    expect(out.externalId).toBe("w1");
  });

  it("getResource throws when not found", async () => {
    const { client } = makeClient();
    await expect(client.getResource("worker", "acct:worker:missing", "acct")).rejects.toThrow(
      /not found/,
    );
  });

  it("getResource(queue) pre-bakes consumers into resolvedOutputs", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.queues = {
      ...fakeApi.cf.queues,
      get: ok({ queue_id: "q1", queue_name: "jobs", settings: {} }),
      consumers: { list: iter([{ consumer_id: "c1", type: "worker" }]) },
    } as never;
    const out = await client.getResource("queue", "acct:queue:q1", "acct");
    expect(out.resolvedOutputs?.["__consumers__"]).toContain("c1");
  });
});

describe("CloudflareClient.resolveOutput", () => {
  function withZone() {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.zones = {
      ...fakeApi.cf.zones,
      get: ok({
        id: "z1",
        name: "a.com",
        status: "active",
        name_servers: ["ns1.x", "ns2.x"],
        account: { id: "acct-cf" },
      }),
    } as never;
    return { client, fakeApi };
  }

  it("resolves zoneId", async () => {
    const { client } = withZone();
    expect(await client.resolveOutput("zone", "acct:zone:z1", "zoneId", "acct")).toBe("z1");
  });

  it("resolves r2 s3Endpoint", async () => {
    const { client } = makeClient();
    const out = await client.resolveOutput("r2-bucket", "acct:r2-bucket:b1", "s3Endpoint", "acct");
    expect(out).toBe("https://acct-cf.r2.cloudflarestorage.com");
  });

  it("throws for an unknown output key", async () => {
    const { client } = withZone();
    await expect(client.resolveOutput("zone", "acct:zone:z1", "bogus", "acct")).rejects.toThrow(
      /cannot resolve output/,
    );
  });
});

describe("CloudflareClient.renderDetail / renderSidebarItem", () => {
  function res(typeId: string, fields: Record<string, unknown> = {}) {
    return {
      id: `acct:${typeId}:x`,
      pluginId: "cloudflare",
      resourceTypeId: typeId,
      accountId: "acct",
      displayName: "X",
      fields,
      resolvedOutputs: {},
      secretStates: [],
      externalId: "x",
    } as never;
  }

  it("renderDetail dispatches each known type", () => {
    const { client } = makeClient();
    for (const t of [
      "zone",
      "dns-record",
      "worker",
      "r2-bucket",
      "kv-namespace",
      "d1-database",
      "queue",
      "tunnel",
      "ssl-certificate",
      "page-rule",
      "firewall-rule",
      "access-application",
      "load-balancer",
      "worker-route",
      "custom-hostname",
      "hyperdrive",
      "email-routing-rule",
      "waiting-room",
      "access-policy",
      "spectrum-application",
      "logpush-job",
      "workers-ai-model",
      "rate-limit-rule",
      "redirect-rule",
      "cache-rule",
      "ip-access-rule",
      "unknown-type",
    ]) {
      const schema = client.renderDetail(res(t, { proxied: true, status: "active" }));
      expect(schema).toBeTruthy();
    }
  });

  it("renderSidebarItem covers each status branch", () => {
    const { client } = makeClient();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["dns-record", { type: "A", name: "x", proxied: true }],
      ["zone", { status: "active" }],
      ["tunnel", { status: "healthy" }],
      ["ssl-certificate", { status: "active" }],
      ["load-balancer", { enabled: true }],
      ["firewall-rule", { enabled: false, description: "d" }],
      ["custom-hostname", { status: "active", hostname: "h" }],
      ["custom-hostname", { status: "pending", hostname: "h" }],
      ["waiting-room", { suspended: true }],
      ["access-policy", { decision: "allow" }],
      ["access-policy", { decision: "deny" }],
      ["logpush-job", { enabled: true, lastError: "err", dataset: "d" }],
      ["logpush-job", { enabled: false, dataset: "d" }],
      ["spectrum-application", { dns: "ssh.a.com", protocol: "tcp/22" }],
      ["other", {}],
    ];
    for (const [t, f] of cases) {
      const item = client.renderSidebarItem(res(t, f));
      expect(item.id).toBeTruthy();
    }
  });
});

describe("CloudflareClient.createResource / updateResource / deleteResource", () => {
  function writeApi() {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.dns.records = {
      ...fakeApi.cf.dns.records,
      create: ok({ id: "r1", type: "A", name: "x" }),
      edit: ok({ id: "r1", type: "A", name: "x" }),
      delete: ok(undefined),
    } as never;
    return { client, fakeApi };
  }

  it("createResource(dns-record) delegates", async () => {
    const { client } = writeApi();
    const out = await client.createResource(
      "dns-record",
      "acct",
      { type: "A", name: "x", content: "1.1.1.1" },
      "acct:zone:z1",
    );
    expect(out.externalId).toContain("r1");
  });

  it("createResource throws for an unsupported type", async () => {
    const { client } = makeClient();
    await expect(client.createResource("durable-object-namespace", "acct", {})).rejects.toThrow(
      /not supported/,
    );
  });

  it("updateResource(dns-record) delegates", async () => {
    const { client } = writeApi();
    const out = await client.updateResource("dns-record", "acct:dns-record:z1/r1", "acct", {
      content: "2.2.2.2",
    });
    expect(out).toBeTruthy();
  });

  it("updateResource(tunnel) sets ingress then refetches", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.zeroTrust.tunnels.cloudflared = {
      ...fakeApi.cf.zeroTrust.tunnels.cloudflared,
      list: iter([{ id: "t1", name: "n", connections: [] }]),
    } as never;
    await client.updateResource("tunnel", "acct:tunnel:t1", "acct", {
      ingressHostname: "ssh.a.com",
      ingressService: "ssh://localhost:22",
    });
    expect(fakeApi.cf.put).toHaveBeenCalled();
  });

  it("updateResource throws for an unsupported type", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.workers.scripts.list = iter([{ id: "w1" }]) as never;
    await expect(client.updateResource("worker", "acct:worker:w1", "acct", {})).rejects.toThrow(
      /not supported/,
    );
  });

  it("deleteResource(dns-record) delegates", async () => {
    const { client } = writeApi();
    await expect(
      client.deleteResource("dns-record", "acct:dns-record:z1/r1", "acct"),
    ).resolves.toBeUndefined();
  });

  it("deleteResource throws for an unsupported type", async () => {
    const { client } = makeClient();
    await expect(client.deleteResource("nope", "acct:nope:x", "acct")).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("CloudflareClient KV / R2 / SQL / manifest / action passthrough", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  }

  it("listKvKeys / putKvValue / deleteKvKey delegate (raw fetch plane)", async () => {
    const { client } = makeClient();
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ success: true, result: [{ name: "k1" }], result_info: {} }),
    ) as never;
    const keys = await client.listKvKeys("kv-namespace", "acct:kv-namespace:ns1", "acct", {});
    expect(keys).toBeTruthy();
    await client.putKvValue("kv-namespace", "acct:kv-namespace:ns1", "acct", "k1", "v");
    await client.deleteKvKey("kv-namespace", "acct:kv-namespace:ns1", "acct", "k1");
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("listStorageObjects delegates to r2 (raw fetch plane)", async () => {
    const { client } = makeClient();
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ success: true, result: [], result_info: { delimited: [] } }),
    ) as never;
    const out = await client.listStorageObjects("b1", "");
    expect(Array.isArray(out)).toBe(true);
  });

  it("executeQuery / introspectResource delegate to d1", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.d1.database.query = iter([{ results: [{ a: 1 }], meta: { duration: 2 } }]) as never;
    const res = await client.executeQuery("acct:d1-database:db1", "acct", "SELECT 1");
    expect(res.rows).toEqual([{ a: 1 }]);
    const meta = await client.introspectResource("acct:d1-database:db1", "acct");
    expect(Array.isArray(meta)).toBe(true);
  });

  it("invokeAction(zone purge-cache-all) delegates", async () => {
    const { client, fakeApi } = makeClient();
    const cfWithCache = fakeApi.cf as unknown as Record<string, unknown> & {
      cache: { purge: ReturnType<typeof ok> };
    };
    cfWithCache.cache = { purge: ok({}) };
    await client.invokeAction("zone", "acct:zone:z1", "purge-cache-all", "acct");
    expect(cfWithCache.cache.purge).toHaveBeenCalled();
  });

  it("invokeAction throws for an unknown action", async () => {
    const { client } = makeClient();
    await expect(client.invokeAction("zone", "acct:zone:z1", "bogus", "acct")).rejects.toThrow(
      /unknown action/,
    );
  });

  it("getManifest / applyManifest support worker + zone, reject others", async () => {
    const { client } = makeClient();
    await expect(client.getManifest("acct:vault:x", "acct")).rejects.toThrow(/not supported/);
    await expect(client.applyManifest("acct:vault:x", "acct", "{}")).rejects.toThrow(
      /not supported/,
    );
  });

  it("exportCredential rejects unsupported type/format", async () => {
    const { client } = makeClient();
    await expect(client.exportCredential("worker", "acct:worker:w1", "acct", "x")).rejects.toThrow(
      /not supported/,
    );
  });

  it("publishMessage rejects non-queue types", async () => {
    const { client } = makeClient();
    await expect(
      client.publishMessage("worker", "acct:worker:w1", "acct", {
        body: "{}",
        extras: {},
      } as never),
    ).rejects.toThrow(/not supported/);
  });

  it("listDnsRecordsForZone delegates", async () => {
    const { client } = makeClient();
    const out = await client.listDnsRecordsForZone("z1", "acct");
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("CloudflareClient.getCreateConfig", () => {
  it("returns a config for each creatable type", async () => {
    const { client } = makeClient();
    const types = [
      "zone",
      "dns-record",
      "r2-bucket",
      "kv-namespace",
      "d1-database",
      "queue",
      "hyperdrive",
      "tunnel",
      "worker-route",
      "page-rule",
      "firewall-rule",
      "custom-hostname",
      "email-routing-rule",
      "waiting-room",
      "ssl-certificate",
      "logpush-job",
      "access-application",
      "access-policy",
      "load-balancer",
      "spectrum-application",
      "worker",
      "rate-limit-rule",
      "redirect-rule",
      "cache-rule",
      "ip-access-rule",
      "turnstile-widget",
      "healthcheck",
      "notification-policy",
    ];
    for (const t of types) {
      const cfg = await client.getCreateConfig(t, "acct:zone:z1");
      expect(cfg).toHaveProperty("fields");
      expect(Array.isArray(cfg.fields)).toBe(true);
    }
  });
});

describe("CloudflareClient.fetchDashboardStats", () => {
  it("zone returns status + plan", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.zones = {
      ...fakeApi.cf.zones,
      get: ok({
        id: "z1",
        name: "a.com",
        status: "active",
        plan: { name: "Pro" },
        account: { id: "acct-cf" },
      }),
    } as never;
    const stats = await client.fetchDashboardStats("zone", "acct:zone:z1", "acct");
    expect(stats[0]!.label).toBe("Status");
  });

  it("r2-bucket sums object sizes", async () => {
    const { client } = makeClient();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [{ key: "a", size: 2048 }],
        result_info: { delimited: [] },
      }),
      text: async () => "",
    })) as never;
    const stats = await client.fetchDashboardStats("r2-bucket", "acct:r2-bucket:b1", "acct");
    globalThis.fetch = realFetch;
    expect(stats.find((s) => s.label === "Objects")).toBeTruthy();
  });

  it("generic fallback derives a status variant", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.healthchecks = { list: iter([{ id: "h1", name: "n", status: "healthy" }]) } as never;
    const stats = await client.fetchDashboardStats("healthcheck", "acct:healthcheck:z1/h1", "acct");
    expect(Array.isArray(stats)).toBe(true);
  });
});

describe("CloudflareClient.fetchMetricSeries", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("non-zone types with empty ids return []", async () => {
    const { client } = makeClient();
    for (const t of [
      "worker",
      "r2-bucket",
      "spectrum-application",
      "d1-database",
      "kv-namespace",
      "queue",
      "hyperdrive",
      "load-balancer",
      "waiting-room",
    ]) {
      const out = await client.fetchMetricSeries(t, "acct:" + t + ":", "acct");
      expect(out).toEqual([]);
    }
  });

  it("unsupported resource type returns []", async () => {
    const { client } = makeClient();
    expect(await client.fetchMetricSeries("dns-record", "acct:dns-record:z1/r1", "acct")).toEqual(
      [],
    );
  });

  it("zone parses GraphQL groups into series", async () => {
    const { client } = makeClient();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            zones: [
              {
                httpRequests1hGroups: [
                  {
                    dimensions: { datetime: "2020-01-01T00:00:00Z" },
                    sum: { requests: 100, bytes: 2000, cachedRequests: 50, threats: 1 },
                    uniq: { uniques: 10 },
                  },
                ],
              },
            ],
          },
        },
      }),
    })) as never;
    const out = await client.fetchMetricSeries("zone", "acct:zone:z1", "acct", {
      startMs: Date.now() - 24 * 3_600_000,
      endMs: Date.now(),
    });
    expect(out.find((s) => s.label === "Requests")).toBeTruthy();
  });

  it("zone returns [] on a non-ok GraphQL response", async () => {
    const { client } = makeClient();
    globalThis.fetch = vi.fn(async () => ({ ok: false })) as never;
    expect(await client.fetchMetricSeries("zone", "acct:zone:z1", "acct")).toEqual([]);
  });

  // Wide window → hourly dims for the types that branch on it.
  const range = { startMs: Date.now() - 48 * 3_600_000, endMs: Date.now() };
  const dt = "2020-01-01T00:00:00Z";

  function graph(body: unknown) {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => body })) as never;
  }

  it("worker metrics parse invocation groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptiveGroups: [
                {
                  dimensions: { datetime: dt },
                  sum: { requests: 10, subrequests: 2, errors: 1 },
                  quantiles: { cpuTimeP50: 5, cpuTimeP99: 9 },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries("worker", "acct:worker:w1", "acct", range);
    expect(out.find((s) => s.label === "Requests")).toBeTruthy();
  });

  it("r2 metrics parse ops + storage groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  dimensions: { datetime: dt, actionType: "PutObject" },
                  sum: { requests: 4, responseObjectSize: 100 },
                },
              ],
              r2StorageAdaptiveGroups: [
                { dimensions: { datetime: dt }, max: { objectCount: 2, payloadSize: 200 } },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries("r2-bucket", "acct:r2-bucket:b1", "acct", range);
    expect(Array.isArray(out)).toBe(true);
  });

  it("spectrum metrics parse network-analytics groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          zones: [
            {
              spectrumNetworkAnalyticsAdaptiveGroups: [
                {
                  dimensions: { datetime: dt },
                  sum: { events: 3, bytesIngress: 10, bytesEgress: 20, connections: 1 },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries(
      "spectrum-application",
      "acct:spectrum-application:z1/s1",
      "acct",
      range,
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("d1 metrics parse analytics groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              d1AnalyticsAdaptiveGroups: [
                {
                  dimensions: { date: "2020-01-01" },
                  sum: {
                    readQueries: 5,
                    writeQueries: 2,
                    rowsRead: 50,
                    rowsWritten: 5,
                    queryBatchResponseBytes: 500,
                  },
                  quantiles: { queryBatchTimeMsP90: 12 },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries(
      "d1-database",
      "acct:d1-database:db1",
      "acct",
      range,
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("kv metrics parse ops + storage groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              kvOperationsAdaptiveGroups: [
                { dimensions: { date: "2020-01-01", actionType: "read" }, sum: { requests: 7 } },
              ],
              kvStorageAdaptiveGroups: [
                { dimensions: { date: "2020-01-01" }, max: { keyCount: 3, byteCount: 30 } },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries(
      "kv-namespace",
      "acct:kv-namespace:ns1",
      "acct",
      range,
    );
    expect(Array.isArray(out)).toBe(true);
  });

  it("queue metrics parse message-op + backlog groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              queueMessageOperationsAdaptiveGroups: [
                {
                  dimensions: { datetimeHour: dt, actionType: "WriteMessage" },
                  count: 5,
                  sum: { bytes: 100 },
                },
                {
                  dimensions: { datetimeHour: dt, actionType: "ReadMessage" },
                  count: 3,
                  sum: { bytes: 60 },
                },
              ],
              queuesBacklogAdaptiveGroups: [
                { dimensions: { datetimeHour: dt }, avg: { messages: 2, bytes: 40 } },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries("queue", "acct:queue:q1", "acct", range);
    expect(out.length).toBeGreaterThan(0);
  });

  it("hyperdrive metrics parse query groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              hyperdriveQueriesAdaptiveGroups: [
                {
                  count: 10,
                  sum: { queryBytes: 100, resultBytes: 200 },
                  avg: { queryLatency: 5, connectionLatency: 2 },
                  dimensions: { datetimeHour: dt, cacheStatus: "hit", eventStatus: "ok" },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries("hyperdrive", "acct:hyperdrive:hd1", "acct", range);
    expect(out.length).toBeGreaterThan(0);
  });

  it("load-balancer metrics resolve the LB name then parse groups", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.loadBalancers = { get: ok({ name: "web-lb" }) } as never;
    graph({
      data: {
        viewer: {
          zones: [
            {
              loadBalancingRequestsAdaptiveGroups: [
                {
                  count: 8,
                  dimensions: { datetimeFifteenMinutes: dt, selectedPoolName: "pool-a" },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries(
      "load-balancer",
      "acct:load-balancer:z1/lb1",
      "acct",
      range,
    );
    expect(out.find((s) => s.label === "Requests")).toBeTruthy();
  });

  it("load-balancer returns [] when LB name lookup fails", async () => {
    const { client, fakeApi } = makeClient();
    fakeApi.cf.loadBalancers = {
      get: vi.fn(async () => {
        throw new Error("nope");
      }),
    } as never;
    expect(
      await client.fetchMetricSeries("load-balancer", "acct:load-balancer:z1/lb1", "acct", range),
    ).toEqual([]);
  });

  it("waiting-room metrics parse analytics groups", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          zones: [
            {
              waitingRoomAnalyticsAdaptiveGroups: [
                {
                  avg: { totalActiveUsers: 100, totalQueuedUsers: 10, newUsersPerMinute: 5 },
                  avgWeighted: { timeOnOriginP50: 2, totalTimeWaitedP90: 30 },
                  dimensions: { datetimeHour: dt },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries(
      "waiting-room",
      "acct:waiting-room:z1/wr1",
      "acct",
      range,
    );
    expect(out.length).toBeGreaterThan(0);
  });

  it("spectrum/load-balancer/waiting-room return [] for ids without a slash", async () => {
    const { client } = makeClient();
    for (const t of ["spectrum-application", "load-balancer", "waiting-room"]) {
      expect(await client.fetchMetricSeries(t, "acct:" + t + ":noSlash", "acct", range)).toEqual(
        [],
      );
    }
  });

  it("ai-gateway metrics parse requests/tokens/cost/errors", async () => {
    const { client } = makeClient();
    graph({
      data: {
        viewer: {
          accounts: [
            {
              aiGatewayRequestsAdaptiveGroups: [
                {
                  count: 12,
                  sum: {
                    cost: 0.5,
                    cachedRequests: 4,
                    erroredRequests: 1,
                    uncachedTokensIn: 100,
                    uncachedTokensOut: 200,
                    cachedTokensIn: 10,
                    cachedTokensOut: 20,
                  },
                  dimensions: { datetimeHour: dt },
                },
              ],
            },
          ],
        },
      },
    });
    const out = await client.fetchMetricSeries(
      "ai-gateway",
      "acct:ai-gateway:my-gw",
      "acct",
      range,
    );
    const req = out.find((s) => s.label === "Requests");
    const tin = out.find((s) => s.label === "Tokens In");
    const cost = out.find((s) => s.label === "Cost");
    expect(req?.points[0]?.value).toBe(12);
    expect(tin?.points[0]?.value).toBe(110); // uncached + cached in
    expect(cost?.points[0]?.value).toBe(0.5);
  });
});

describe("CloudflareClient.streamChatMessage", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function collect(gen: AsyncGenerator<unknown>) {
    const out: unknown[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("errors for an unsupported type", async () => {
    const { client } = makeClient();
    const events = await collect(client.streamChatMessage("worker", "acct:worker:w1", "acct", []));
    expect(events[0]).toMatchObject({ kind: "error" });
  });

  it("streams deltas then a done event", async () => {
    const { client } = makeClient();
    const sse =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
      "data: [DONE]\n\n";
    const encoder = new TextEncoder();
    let sent = false;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { value: undefined, done: true };
              sent = true;
              return { value: encoder.encode(sse), done: false };
            },
          };
        },
      },
    })) as never;
    const events = (await collect(
      client.streamChatMessage("workers-ai-model", "acct:workers-ai-model:@cf/x", "acct", [
        { role: "user", content: "hi" },
      ]),
    )) as Array<{ kind: string; text?: string; message?: { content: string } }>;
    expect(events.filter((e) => e.kind === "delta").length).toBe(2);
    const done = events.find((e) => e.kind === "done");
    expect(done?.message?.content).toBe("Hi!");
  });

  it("errors on a non-ok chat response", async () => {
    const { client } = makeClient();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "boom",
      body: null,
      text: async () => "fail",
    })) as never;
    const events = (await collect(
      client.streamChatMessage("workers-ai-model", "acct:workers-ai-model:@cf/x", "acct", []),
    )) as Array<{ kind: string }>;
    expect(events[0]!.kind).toBe("error");
  });

  it("ai-gateway routes through the gateway workers-ai endpoint with the picked model", async () => {
    const { client } = makeClient();
    const fetchMock = vi.fn(
      async (_url: string, _init: { body: string; headers: Record<string, string> }) => ({
        ok: true,
        body: {
          getReader() {
            let sent = false;
            const encoder = new TextEncoder();
            return {
              async read() {
                if (sent) return { value: undefined, done: true };
                sent = true;
                return {
                  value: encoder.encode(
                    'data: {"choices":[{"delta":{"content":"yo"}}]}\n\ndata: [DONE]\n\n',
                  ),
                  done: false,
                };
              },
            };
          },
        },
      }),
    );
    globalThis.fetch = fetchMock as never;
    const events = (await collect(
      client.streamChatMessage(
        "ai-gateway",
        "acct:ai-gateway:my-gw",
        "acct",
        [{ role: "user", content: "hi" }],
        { model: "@cf/meta/llama-3.1-8b-instruct" },
      ),
    )) as Array<{ kind: string; message?: { content: string } }>;
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-cf/ai/v1/chat/completions",
    );
    const init = fetchMock.mock.calls[0]![1] as {
      body: string;
      headers: Record<string, string>;
    };
    // Routed through the gateway via the cf-aig-gateway-id header.
    expect(init.headers["cf-aig-gateway-id"]).toBe("my-gw");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(events.find((e) => e.kind === "done")?.message?.content).toBe("yo");
  });

  it("ai-gateway errors when no model is selected", async () => {
    const { client } = makeClient();
    const events = (await collect(
      client.streamChatMessage("ai-gateway", "acct:ai-gateway:my-gw", "acct", []),
    )) as Array<{ kind: string; message?: string }>;
    expect(events[0]!.kind).toBe("error");
    expect(events[0]!.message).toMatch(/model/i);
  });

  it("surfaces a Workers AI permission hint on an auth error (code 10000)", async () => {
    const { client } = makeClient();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: null,
      text: async () =>
        '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
    })) as never;
    const events = (await collect(
      client.streamChatMessage("workers-ai-model", "acct:workers-ai-model:@cf/x", "acct", [
        { role: "user", content: "hi" },
      ]),
    )) as Array<{ kind: string; message?: string }>;
    expect(events[0]!.kind).toBe("error");
    expect(events[0]!.message).toMatch(/Workers AI:Read/);
  });
});
