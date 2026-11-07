import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AstraPluginClient } from "../client.js";
import { AstraApiError } from "../api.js";
import { parseStatusFeed, mapComponent } from "../status-feed.js";
import { astraTerraformExport } from "../terraform.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";
import { createMockResource } from "@infrawrench/plugin-base/test-harness";
import { mockFetch, trackUnread } from "./helpers.js";

const DB = {
  id: "11111111-2222-3333-4444-555555555555",
  orgId: "org-1",
  status: "ACTIVE",
  creationTime: "2026-09-01T00:00:00Z",
  info: {
    name: "vectors",
    keyspace: "default_keyspace",
    additionalKeyspaces: ["analytics"],
    cloudProvider: "AWS",
    region: "us-east-2",
    tier: "serverless",
    dbType: "vector",
    datacenters: [
      {
        id: "11111111-2222-3333-4444-555555555555-1",
        region: "us-east-2",
        cloudProvider: "AWS",
        status: "ACTIVE",
        pcuGroupUUID: "pcu-1",
      },
    ],
  },
  storage: { nodeCount: 3, replicationFactor: 3, totalStorage: 5, usedStorage: 1 },
  dataEndpointUrl: "https://11111111-2222-3333-4444-555555555555-us-east-2.apps.astra.datastax.com",
};

afterEach(() => vi.unstubAllGlobals());

describe("AstraPluginClient", () => {
  it("pages databases with starting_after and sends the bearer token", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      ...DB,
      id: `db-${i}`,
      info: { ...DB.info, name: `db-${i}` },
    }));
    const { calls } = mockFetch({
      "GET /v2/databases": (url: URL) =>
        url.searchParams.get("starting_after") === "db-99" ? [DB] : page1,
      "GET /v2/access-lists": [
        {
          databaseId: DB.id,
          addresses: [{ address: "1.2.3.4/32", enabled: true }],
          configurations: { accessListEnabled: true },
        },
      ],
    });
    const client = hostClient(new AstraPluginClient({ token: "AstraCS:a:b" }));
    const dbs = await client.listResources(T.database, "acc");
    expect(dbs).toHaveLength(101);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer AstraCS:a:b");
    expect(calls.find((c) => c.url.searchParams.get("starting_after") === "db-99")).toBeDefined();
    const vec = dbs.find((d) => d.externalId === DB.id)!;
    expect(vec.fields).toMatchObject({
      dbType: "vector",
      region: "us-east-2",
      keyspaces: "default_keyspace, analytics",
      accessListEnabled: true,
      accessListEntries: 1,
      pcuGroupIds: "pcu-1",
    });
  });

  it("lists collections through the Data API with the Token header, skipping inactive databases", async () => {
    const { calls } = mockFetch({
      "GET /v2/databases": [DB, { ...DB, id: "sleepy", status: "HIBERNATED" }],
      [`POST ${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1/default_keyspace`]: {
        status: {
          collections: [
            {
              name: "docs",
              options: {
                vector: {
                  dimension: 1024,
                  metric: "cosine",
                  service: { provider: "nvidia", modelName: "NV-Embed-QA" },
                },
              },
            },
          ],
        },
      },
      [`POST ${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1/analytics`]: {
        status: { collections: [] },
      },
    });
    const client = hostClient(new AstraPluginClient({ token: "AstraCS:a:b" }));
    const cols = await client.listResources(T.collection, "acc");
    expect(cols.map((c) => c.externalId)).toEqual([`${DB.id}/default_keyspace/docs`]);
    expect(cols[0]!.fields).toMatchObject({
      vectorDimension: 1024,
      vectorize: "nvidia NV-Embed-QA",
    });
    const dataCall = calls.find((c) => c.url.host.endsWith("apps.astra.datastax.com"))!;
    expect(dataCall.headers["Token"]).toBe("AstraCS:a:b");
    expect(dataCall.headers["Authorization"]).toBeUndefined();
    expect(dataCall.body).toEqual({ findCollections: { options: { explain: true } } });
    expect(calls.some((c) => c.url.host.startsWith("sleepy"))).toBe(false);
  });

  it("refuses to enforce an empty access list and rewrites the whole list when enforcing", async () => {
    let list: unknown = { addresses: [], configurations: { accessListEnabled: false } };
    const { calls } = mockFetch({
      [`GET /v2/databases/${DB.id}/access-list`]: () => list,
      [`PUT /v2/databases/${DB.id}/access-list`]: null,
      [`GET /v2/databases/${DB.id}`]: DB,
      "GET /v2/access-lists": [],
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(
      client.updateResource(T.database, `acc:${T.database}:${DB.id}`, "acc", {
        accessListEnabled: "true",
      }),
    ).rejects.toThrow(/locked out/);
    list = {
      addresses: [{ address: "1.2.3.4/32", enabled: true, description: "office" }],
      configurations: { accessListEnabled: false },
    };
    await client.updateResource(T.database, `acc:${T.database}:${DB.id}`, "acc", {
      accessListEnabled: "true",
    });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      addresses: [{ address: "1.2.3.4/32", enabled: true, description: "office" }],
      configurations: { accessListEnabled: true },
    });
  });

  it("deletes one access list entry by address", async () => {
    const { calls } = mockFetch({ [`DELETE /v2/databases/${DB.id}/access-list`]: null });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await client.deleteResource(T.accessEntry, `acc:${T.accessEntry}:${DB.id}/10.0.0.0/8`, "acc");
    expect(calls[0]!.url.searchParams.get("addresses")).toBe("10.0.0.0/8");
  });

  it("creates a database and finds it by name", async () => {
    let created = false;
    const { calls } = mockFetch({
      "POST /v2/databases": () => {
        created = true;
        return null;
      },
      "GET /v2/databases": () => (created ? [DB] : []),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    const r = await client.createResource(T.database, "acc", {
      name: "vectors",
      dbType: "vector",
      region: "AWS:us-east-2",
      keyspace: "",
    });
    expect(calls[0]!.body).toEqual({
      name: "vectors",
      cloudProvider: "AWS",
      tier: "serverless",
      capacityUnits: 1,
      region: "us-east-2",
      dbType: "vector",
    });
    expect("resource" in r ? r.resource.externalId : r.externalId).toBe(DB.id);
  });

  it("returns a new token in the resource's outputs with a warning", async () => {
    mockFetch({
      "POST /v2/clientIdSecrets": {
        clientId: "cid",
        secret: "s",
        token: "AstraCS:cid:x",
        roles: ["r1"],
      },
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    const res = await client.createResource(T.token, "acc", { roles: '["r1"]' });
    expect("resource" in res && res.resource.resolvedOutputs["token"]).toBe("AstraCS:cid:x");
  });

  it("resumes a hibernated database through the Data API and treats 503 as success", async () => {
    const { calls } = mockFetch({
      [`GET /v2/databases/${DB.id}`]: { ...DB, status: "HIBERNATED" },
      [`GET ${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1/resume`]: new Response(
        "resuming",
        { status: 503 },
      ),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await client.invokeAction(T.database, `acc:${T.database}:${DB.id}`, "resume", "acc");
    expect(calls.at(-1)!.url.host).toContain("apps.astra.datastax.com");
  });

  it("maps a 401 to a status-carrying error", async () => {
    mockFetch({
      "GET /v2/databases": new Response('{"errors":[{"message":"bad token"}]}', { status: 401 }),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    const err = await client.listResources(T.database, "acc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstraApiError);
    expect((err as AstraApiError).status).toBe(401);
  });

  it("scrapes database metrics with the Astra-Token scheme and empties on 403", async () => {
    const body = [
      "# TYPE x gauge",
      'astra_db_read_latency_seconds_P99:rate1m{region="us-east-2"} 0.012',
      'astra_db_read_latency_seconds_P99:rate1m{region="eu-west-1"} 0.020',
      'astra_billing_report_tenant_requests_total:rate1m{region="us-east-2"} 10',
      'astra_billing_report_tenant_requests_total:rate1m{region="eu-west-1"} 5',
    ].join("\n");
    const { calls } = mockFetch({
      [`GET metrics.astra.datastax.com/v1/databases/${DB.id}/metrics`]: body,
    });
    const client = hostClient(new AstraPluginClient({ token: "tok" }));
    const series = await client.fetchMetricSeries(T.database, `acc:${T.database}:${DB.id}`, "acc");
    expect(calls[0]!.headers["Authorization"]).toBe("Astra-Token tok");
    expect(series.find((s) => s.label === "Read latency p99")!.points[0]!.value).toBe(20);
    expect(series.find((s) => s.label === "Requests")!.points[0]!.value).toBe(15);
    mockFetch({
      [`GET metrics.astra.datastax.com/v1/pcugroup/p/metrics`]: new Response("", { status: 403 }),
    });
    expect(await client.fetchMetricSeries(T.pcuGroup, `acc:${T.pcuGroup}:p`, "acc")).toEqual([]);
  });
});

describe("lists that stop early", () => {
  const dbsNamed = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...DB, id: `${prefix}-${i}` }));

  /** Serve `dbs` a page at a time, as `starting_after` asks. */
  const pagedDatabases = (dbs: Array<{ id: string }>) => (url: URL) => {
    const after = url.searchParams.get("starting_after");
    const start = after ? dbs.findIndex((d) => d.id === after) + 1 : 0;
    return dbs.slice(start, start + 100);
  };

  it("throws when the databases never end, instead of returning what it read", async () => {
    let page = 0;
    const { calls } = mockFetch({ "GET /v2/databases": () => dbsNamed(`p${page++}`, 100) });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.listResources(T.keyspace, "acc")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(100);
  });

  it("reads past the old 5,000 databases", async () => {
    mockFetch({ "GET /v2/databases": pagedDatabases(dbsNamed("db", 9_999)) });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.listResources(T.database, "acc")).resolves.toHaveLength(9_999);
  });

  it("lists every snapshot of a database, not the newest 30", async () => {
    const snapshots = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}` }));
    mockFetch({
      "GET /v2/databases": [DB],
      [`GET /v2/databases/${DB.id}/snapshots`]: { snapshots },
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.listResources(T.snapshot, "acc")).resolves.toHaveLength(45);
  });

  it("throws past 10,000 snapshots on one database", async () => {
    const snapshots = Array.from({ length: 10_001 }, (_, i) => ({ id: `s${i}` }));
    mockFetch({
      "GET /v2/databases": [DB],
      [`GET /v2/databases/${DB.id}/snapshots`]: { snapshots },
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.listResources(T.snapshot, "acc")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("past what a poll can read, reads the budget, names the rest and moves on later", async () => {
    const dbs = dbsNamed("db", 450);
    const routes: Record<string, unknown> = { "GET /v2/databases": pagedDatabases(dbs) };
    for (const db of dbs) {
      routes[`GET /v2/databases/${db.id}/snapshots`] = { snapshots: [{ id: "s" }] };
    }
    const unread = trackUnread();
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    try {
      const first = mockFetch(routes);
      const rows = await hostClient(new AstraPluginClient({ token: "t" })).listResources(
        T.snapshot,
        "acc",
      );
      expect(rows).toHaveLength(400);
      expect(first.calls.filter((c) => c.url.pathname.endsWith("/snapshots"))).toHaveLength(400);
      expect(unread.parts).toEqual([
        { parentResourceIds: dbs.slice(400).map((d) => `acc:${T.database}:${d.id}`) },
      ]);

      unread.parts.length = 0;
      vi.setSystemTime(60 * 60 * 1000);
      await hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc");
      const named = unread.parts[0]!.parentResourceIds!;
      expect(named).toHaveLength(50);
      expect(named).not.toContain(`acc:${T.database}:db-449`);
    } finally {
      vi.useRealTimers();
      unread.stop();
    }
  });
});

describe("a token refused a list", () => {
  const refused = () => new Response('{"errors":[{"message":"forbidden"}]}', { status: 403 });
  const OWN_ROUTES: Array<[string, string]> = [
    [T.accessEntry, "GET /v2/access-lists"],
    [T.privateEndpoint, "GET /v2/organizations/private-link"],
    [T.pcuGroup, "POST /v2/pcus/actions/get"],
    [T.tenant, "GET /v2/streaming/tenants"],
    [T.role, "GET /v2/organizations/roles"],
    [T.user, "GET /v2/organizations/users"],
    [T.token, "GET /v2/clientIdSecrets"],
  ];

  it.each(OWN_ROUTES)("keeps every stored %s row, without an error", async (type, route) => {
    mockFetch({ "GET /v2/databases": [], [route]: refused });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(type, "acc")).resolves.toEqual([]);
      expect(unread.parts).toEqual([{ idPrefixes: [""] }]);
    } finally {
      unread.stop();
    }
  });

  it.each(OWN_ROUTES)(
    "shows the refusal of %s where a host keeps no track",
    async (type, route) => {
      mockFetch({ "GET /v2/databases": [], [route]: refused });
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      const err = await client.listResources(type, "acc").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AstraApiError);
      expect((err as AstraApiError).status).toBe(403);
    },
  );

  it("still fails the type on a throttle", async () => {
    mockFetch({ "GET /v2/organizations/users": new Response("slow down", { status: 429 }) });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.user, "acc")).rejects.toBeInstanceOf(AstraApiError);
      expect(unread.parts).toEqual([]);
    } finally {
      unread.stop();
    }
  });

  it("reads a feature that is off as none, and says nothing went unread", async () => {
    mockFetch({
      "POST /v2/pcus/actions/get": new Response("{}", { status: 404 }),
      "GET /v2/databases": [],
    });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.pcuGroup, "acc")).resolves.toEqual([]);
      expect(unread.parts).toEqual([]);
    } finally {
      unread.stop();
    }
  });

  it("does not hold back a type that only looks things up in the refused list", async () => {
    mockFetch({
      "GET /v2/databases": [DB],
      "GET /v2/access-lists": refused,
      "GET /v2/organizations/private-link": refused,
      "GET /v2/organizations/roles": refused,
      "GET /v2/clientIdSecrets": { clients: [{ clientId: "c1", roles: ["r1"] }] },
    });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.database, "acc")).resolves.toHaveLength(1);
      await expect(client.listResources(T.region, "acc")).resolves.toHaveLength(1);
      await expect(client.listResources(T.token, "acc")).resolves.toHaveLength(1);
      expect(unread.parts).toEqual([]);
    } finally {
      unread.stop();
    }
  });

  it("names just the database it was refused, and lists the rest", async () => {
    const other = { ...DB, id: "other" };
    mockFetch({
      "GET /v2/databases": [DB, other],
      [`GET /v2/databases/${DB.id}/snapshots`]: refused,
      "GET /v2/databases/other/snapshots": { snapshots: [{ id: "s" }] },
    });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      const rows = await client.listResources(T.snapshot, "acc");
      expect(rows.map((r) => r.externalId)).toEqual(["other/s"]);
      expect(unread.parts).toEqual([{ parentResourceIds: [`acc:${T.database}:${DB.id}`] }]);
    } finally {
      unread.stop();
    }
  });

  it("keeps the CDC rows of a database it was refused", async () => {
    mockFetch({ "GET /v2/databases": [DB], [`GET /v3/databases/${DB.id}/cdc`]: refused });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.cdc, "acc")).resolves.toEqual([]);
      expect(unread.parts).toEqual([{ parentResourceIds: [`acc:${T.database}:${DB.id}`] }]);
    } finally {
      unread.stop();
    }
  });

  it("with no host tracking, shows a refusal of every database but not of some", async () => {
    const other = { ...DB, id: "other" };
    mockFetch({
      "GET /v2/databases": [DB, other],
      [`GET /v2/databases/${DB.id}/snapshots`]: refused,
      "GET /v2/databases/other/snapshots": { snapshots: [{ id: "s" }] },
    });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc"),
    ).resolves.toHaveLength(1);
    mockFetch({
      "GET /v2/databases": [DB, other],
      [`GET /v2/databases/${DB.id}/snapshots`]: refused,
      "GET /v2/databases/other/snapshots": refused,
    });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc"),
    ).rejects.toBeInstanceOf(AstraApiError);
  });

  it("still offers the create forms when the roles are refused", async () => {
    mockFetch({ "GET /v2/organizations/roles": refused });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.getCreateConfig(T.user)).resolves.toBeDefined();
    await expect(client.getCreateConfig(T.token)).resolves.toBeDefined();
  });
});

describe("status feed", () => {
  it("maps AWS and Azure components onto regions and Astra products onto types", () => {
    expect(mapComponent("AWS us-east-1")).toMatchObject({ regions: ["us-east-1"] });
    expect(mapComponent("westus2")).toMatchObject({ regions: ["westus2"] });
    expect(mapComponent("Astra Portal")).toMatchObject({ providerWide: true });
    expect(mapComponent("Astra Streaming")!.resourceTypes).toContain(T.tenant);
    expect(mapComponent("Astra Classic DB")).toBeNull();
  });

  it("keeps open incidents and drops old resolved ones", () => {
    const now = new Date().toISOString();
    const body = JSON.stringify({
      incidents: [
        {
          id: "a",
          name: "Open",
          status: "investigating",
          impact: "major",
          created_at: now,
          components: [{ name: "AWS us-east-1" }],
        },
        {
          id: "b",
          name: "Old",
          status: "resolved",
          impact: "minor",
          created_at: "2025-01-01T00:00:00Z",
          resolved_at: "2025-01-02T00:00:00Z",
          components: [],
        },
      ],
    });
    const out = parseStatusFeed(body);
    expect(out.map((i) => i.externalId)).toEqual(["a"]);
    expect(out[0]!.regions).toEqual(["us-east-1"]);
  });
});

describe("terraform", () => {
  it("maps a database and a keyspace with their import ids", () => {
    const db = createMockResource(
      "datastax-astra",
      RESOURCE_TYPES.find((t) => t.id === T.database)!,
    );
    db.fields = {
      name: "vectors",
      databaseId: DB.id,
      cloud: "AWS",
      regions: "us-east-2, eu-west-1",
      keyspace: "ks",
      dbType: "vector",
    };
    const out = astraTerraformExport.mapResource(db)!;
    expect(out.resource.type).toBe("astra_database");
    expect(out.resource.attributes["cloud_provider"]).toEqual({ kind: "string", value: "aws" });
    expect(out.resource.importId).toBe(DB.id);
    const ks = createMockResource(
      "datastax-astra",
      RESOURCE_TYPES.find((t) => t.id === T.keyspace)!,
    );
    ks.fields = { name: "analytics", databaseId: DB.id, isDefault: false };
    expect(astraTerraformExport.mapResource(ks)!.resource.importId).toBe(
      `${DB.id}/keyspace/analytics`,
    );
  });
});
