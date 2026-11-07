import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AstraPluginClient } from "../client.js";
import { AstraApiError } from "../api.js";
import { parseStatusFeed, mapComponent } from "../status-feed.js";
import { astraTerraformExport } from "../terraform.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";
import { createMockResource } from "@infrawrench/plugin-base/test-harness";
import { mockFetch, trackUnread } from "./helpers.js";

// These tests read many pages or wait on timers, which runs far slower on CI than locally.
vi.setConfig({ testTimeout: 60_000 });

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

  it("reads every database's children, past what a poll would read", async () => {
    const dbs = dbsNamed("db", 450);
    const routes: Record<string, unknown> = { "GET /v2/databases": pagedDatabases(dbs) };
    for (const db of dbs) {
      routes[`GET /v2/databases/${db.id}/snapshots`] = { snapshots: [{ id: "s" }] };
    }
    mockFetch(routes);
    const rows = await hostClient(new AstraPluginClient({ token: "t" })).listResources(
      T.snapshot,
      "acc",
    );
    expect(rows).toHaveLength(450);
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

  it("with no host tracking, shows a refusal of some databases or of every one", async () => {
    const other = { ...DB, id: "other" };
    mockFetch({
      "GET /v2/databases": [DB, other],
      [`GET /v2/databases/${DB.id}/snapshots`]: refused,
      "GET /v2/databases/other/snapshots": { snapshots: [{ id: "s" }] },
    });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc"),
    ).rejects.toBeInstanceOf(AstraApiError);
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

describe("Data API errors in a 200 answer", () => {
  const endpoint = `${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1/default_keyspace`;
  const failing = (errorCode: string) => ({
    errors: [{ errorCode, message: `said ${errorCode}` }],
  });

  it("does not report a collection created", async () => {
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}`]: failing("TOO_MANY_COLLECTIONS"),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(
      client.createResource(T.collection, "acc", {
        keyspaceRef: `${DB.id}/default_keyspace`,
        name: "docs",
      }),
    ).rejects.toThrow("said TOO_MANY_COLLECTIONS");
  });

  it("does not report a collection deleted", async () => {
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}`]: failing("UNKNOWN_KEYSPACE"),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(
      client.deleteResource(
        T.collection,
        `acc:${T.collection}:${DB.id}/default_keyspace/docs`,
        "acc",
      ),
    ).rejects.toThrow("said UNKNOWN_KEYSPACE");
  });

  it("still creates on an answer with no errors", async () => {
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}`]: { status: { ok: 1 } },
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(
      client.createResource(T.collection, "acc", {
        keyspaceRef: `${DB.id}/default_keyspace`,
        name: "docs",
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ["UNAUTHENTICATED_REQUEST", 401],
    ["MISSING_AUTHENTICATION_TOKEN", 401],
    ["UNAUTHORIZED_ACCESS", 403],
  ])("carries %s as a %i", async (code, status) => {
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}`]: failing(code),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    const err = await client
      .deleteResource(T.collection, `acc:${T.collection}:${DB.id}/default_keyspace/docs`, "acc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstraApiError);
    expect((err as AstraApiError).status).toBe(status);
  });
});

describe("reading collections", () => {
  const endpoint = `${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1`;
  const keyspaceId = (ks: string) => `acc:${T.keyspace}:${DB.id}/${ks}`;
  const answering = (answer: () => unknown) => ({
    "GET /v2/databases": [DB],
    [`POST ${endpoint}/default_keyspace`]: answer,
    [`POST ${endpoint}/analytics`]: { status: { collections: [{ name: "kept" }] } },
  });

  it.each([429, 500, 503])("fails the type on a %i, so stored rows stay", async (status) => {
    mockFetch(answering(() => new Response("{}", { status })));
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    const err = await client.listResources(T.collection, "acc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstraApiError);
    expect((err as AstraApiError).status).toBe(status);
  });

  it("fails the type when the endpoint cannot be reached", async () => {
    const { fn } = mockFetch(answering(() => null));
    const answer = fn.getMockImplementation()!;
    fn.mockImplementation(async (input, init) => {
      if (String(input).includes("default_keyspace")) throw new TypeError("fetch failed");
      return answer(input, init);
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.listResources(T.collection, "acc")).rejects.toThrow("fetch failed");
  });

  it.each([400, 404, 501])("keeps the rows of a keyspace answered with a %i", async (status) => {
    mockFetch(answering(() => new Response("{}", { status })));
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      const rows = await client.listResources(T.collection, "acc");
      expect(rows.map((r) => r.displayName)).toEqual(["kept"]);
      expect(unread.parts).toEqual([{ parentResourceIds: [keyspaceId("default_keyspace")] }]);
    } finally {
      unread.stop();
    }
  });

  it("keeps the rows of a keyspace the Data API reports an error for", async () => {
    mockFetch(answering(() => ({ errors: [{ errorCode: "UNKNOWN_KEYSPACE", message: "no" }] })));
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.collection, "acc")).resolves.toHaveLength(1);
      expect(unread.parts).toEqual([{ parentResourceIds: [keyspaceId("default_keyspace")] }]);
    } finally {
      unread.stop();
    }
  });

  it("keeps the rows of a keyspace refused with a 403", async () => {
    mockFetch(answering(() => new Response("{}", { status: 403 })));
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.collection, "acc")).resolves.toHaveLength(1);
      expect(unread.parts).toEqual([{ parentResourceIds: [keyspaceId("default_keyspace")] }]);
    } finally {
      unread.stop();
    }
  });

  it("does not raise an error on a database with no Data API, where no host tracks rows", async () => {
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}/default_keyspace`]: () => new Response("{}", { status: 404 }),
      [`POST ${endpoint}/analytics`]: () => new Response("{}", { status: 404 }),
    });
    const client = hostClient(new AstraPluginClient({ token: "t" }));
    await expect(client.listResources(T.collection, "acc")).resolves.toEqual([]);
  });

  it("makes no request for a database with no endpoint, and keeps its rows", async () => {
    const { dataEndpointUrl: _none, ...rest } = DB;
    const bare = { ...rest, id: "bare", info: { keyspace: "ks" } };
    const { calls } = mockFetch({ "GET /v2/databases": [bare] });
    const unread = trackUnread();
    try {
      const client = hostClient(new AstraPluginClient({ token: "t" }));
      await expect(client.listResources(T.collection, "acc")).resolves.toEqual([]);
      expect(calls).toHaveLength(1);
      expect(unread.parts).toEqual([{ parentResourceIds: [`acc:${T.keyspace}:bare/ks`] }]);
    } finally {
      unread.stop();
    }
  });
});

describe("collections of a database that is not running", () => {
  it.each(["HIBERNATED", "HIBERNATING", "PARKED", "MAINTENANCE"])(
    "keeps the rows of a %s database without waking it",
    async (status) => {
      const { calls } = mockFetch({ "GET /v2/databases": [{ ...DB, status }] });
      const unread = trackUnread();
      try {
        const client = hostClient(new AstraPluginClient({ token: "t" }));
        await expect(client.listResources(T.collection, "acc")).resolves.toEqual([]);
        expect(calls).toHaveLength(1);
        expect(unread.parts).toEqual([
          {
            parentResourceIds: [
              `acc:${T.keyspace}:${DB.id}/default_keyspace`,
              `acc:${T.keyspace}:${DB.id}/analytics`,
            ],
          },
        ]);
      } finally {
        unread.stop();
      }
    },
  );

  it("says nothing went unread when every database is running", async () => {
    const endpoint = `${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1`;
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}/default_keyspace`]: { status: { collections: [] } },
      [`POST ${endpoint}/analytics`]: { status: { collections: [] } },
    });
    const unread = trackUnread();
    try {
      await hostClient(new AstraPluginClient({ token: "t" })).listResources(T.collection, "acc");
      expect(unread.parts).toEqual([]);
    } finally {
      unread.stop();
    }
  });
});

describe("an answer that is not a list", () => {
  const renamed = { items: [] };
  const emptyBody = () => null;
  const notAList = "is not a list";

  it("throws on a databases page with its shape changed, first or later", async () => {
    mockFetch({ "GET /v2/databases": renamed });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.keyspace, "acc"),
    ).rejects.toThrow(notAList);

    const full = Array.from({ length: 100 }, (_, i) => ({ ...DB, id: `db-${i}` }));
    mockFetch({
      "GET /v2/databases": (url: URL) => (url.searchParams.get("starting_after") ? renamed : full),
    });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.keyspace, "acc"),
    ).rejects.toThrow(notAList);
  });

  it.each([
    ["databases", T.keyspace, "GET /v2/databases"],
    ["access lists", T.accessEntry, "GET /v2/access-lists"],
    ["PCU groups", T.pcuGroup, "POST /v2/pcus/actions/get"],
    ["tenants", T.tenant, "GET /v2/streaming/tenants"],
    ["roles", T.role, "GET /v2/organizations/roles"],
    ["users", T.user, "GET /v2/organizations/users"],
    ["tokens", T.token, "GET /v2/clientIdSecrets"],
    ["private links", T.privateEndpoint, "GET /v2/organizations/private-link"],
  ])("throws on %s with no answer or a renamed one", async (_name, type, route) => {
    const dbs = route === "GET /v2/databases" ? {} : { "GET /v2/databases": [] };
    for (const answer of [renamed, emptyBody]) {
      mockFetch({ ...dbs, [route]: answer });
      await expect(
        hostClient(new AstraPluginClient({ token: "t" })).listResources(type, "acc"),
      ).rejects.toThrow(notAList);
    }
  });

  // The streaming document names its Go package, and Go writes a nil slice as null.
  it.each([
    ["databases", T.keyspace, "GET /v2/databases"],
    ["access lists", T.accessEntry, "GET /v2/access-lists"],
    ["PCU groups", T.pcuGroup, "POST /v2/pcus/actions/get"],
    ["tenants", T.tenant, "GET /v2/streaming/tenants"],
  ])("reads %s answered with a literal null as none", async (_name, type, route) => {
    const dbs = route === "GET /v2/databases" ? {} : { "GET /v2/databases": [] };
    mockFetch({ ...dbs, [route]: "null" });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(type, "acc"),
    ).resolves.toEqual([]);
  });

  it.each([
    ["users", T.user, "GET /v2/organizations/users", { users: null }],
    ["tokens", T.token, "GET /v2/clientIdSecrets", { clients: null }],
    ["tokens", T.token, "GET /v2/clientIdSecrets", {}],
    ["private links", T.privateEndpoint, "GET /v2/organizations/private-link", { clusters: null }],
    ["private links", T.privateEndpoint, "GET /v2/organizations/private-link", {}],
    ["tenants", T.tenant, "GET /v2/streaming/tenants", { Body: null }],
  ])(
    "reads %s with an empty list the document allows as none",
    async (_name, type, route, body) => {
      mockFetch({ "GET /v2/databases": [], "GET /v2/organizations/roles": [], [route]: body });
      await expect(
        hostClient(new AstraPluginClient({ token: "t" })).listResources(type, "acc"),
      ).resolves.toEqual([]);
    },
  );

  it("requires the users key, which the document marks required", async () => {
    mockFetch({ "GET /v2/organizations/users": {} });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.user, "acc"),
    ).rejects.toThrow(notAList);
  });

  it("reads tenants wrapped in Body, and bare", async () => {
    const tenant = { tenantName: "t1", clusterName: "c1" };
    for (const answer of [{ Body: [tenant] }, [tenant]]) {
      mockFetch({ "GET /v2/streaming/tenants": answer });
      await expect(
        hostClient(new AstraPluginClient({ token: "t" })).listResources(T.tenant, "acc"),
      ).resolves.toHaveLength(1);
    }
  });

  it("throws on snapshots under another key, and reads an empty object as none", async () => {
    const snapshots = `GET /v2/databases/${DB.id}/snapshots`;
    mockFetch({ "GET /v2/databases": [DB], [snapshots]: renamed });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc"),
    ).rejects.toThrow(notAList);
    mockFetch({ "GET /v2/databases": [DB], [snapshots]: {} });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc"),
    ).resolves.toEqual([]);
  });

  it("still reads no snapshots from a 404", async () => {
    mockFetch({
      "GET /v2/databases": [DB],
      [`GET /v2/databases/${DB.id}/snapshots`]: () => new Response("{}", { status: 404 }),
    });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.snapshot, "acc"),
    ).resolves.toEqual([]);
  });

  it("throws on CDC with no tables, and reads a 404 and an empty list as none", async () => {
    const cdc = `GET /v3/databases/${DB.id}/cdc`;
    mockFetch({ "GET /v2/databases": [DB], [cdc]: { orgID: "o", regions: [] } });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.cdc, "acc"),
    ).rejects.toThrow(notAList);
    mockFetch({ "GET /v2/databases": [DB], [cdc]: emptyBody });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.cdc, "acc"),
    ).rejects.toThrow(notAList);
    mockFetch({ "GET /v2/databases": [DB], [cdc]: { tables: [], regions: [] } });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.cdc, "acc"),
    ).resolves.toEqual([]);
    mockFetch({ "GET /v2/databases": [DB], [cdc]: () => new Response("{}", { status: 404 }) });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.cdc, "acc"),
    ).resolves.toEqual([]);
  });

  it("throws on a findCollections answer with no list and no errors", async () => {
    const endpoint = `${DB.id}-us-east-2.apps.astra.datastax.com/api/json/v1`;
    mockFetch({
      "GET /v2/databases": [DB],
      [`POST ${endpoint}/default_keyspace`]: { status: {} },
      [`POST ${endpoint}/analytics`]: { status: { collections: [] } },
    });
    await expect(
      hostClient(new AstraPluginClient({ token: "t" })).listResources(T.collection, "acc"),
    ).rejects.toThrow(notAList);
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
