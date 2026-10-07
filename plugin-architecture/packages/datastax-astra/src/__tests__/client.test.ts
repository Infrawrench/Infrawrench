import { afterEach, describe, expect, it, vi } from "vitest";
import { AstraPluginClient } from "../client.js";
import { AstraApiError } from "../api.js";
import { parseStatusFeed, mapComponent } from "../status-feed.js";
import { astraTerraformExport } from "../terraform.js";
import { RESOURCE_TYPES, T } from "../resource-types.js";
import { createMockResource } from "@infrawrench/plugin-base/test-harness";
import { mockFetch } from "./helpers.js";

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
    const client = new AstraPluginClient({ token: "AstraCS:a:b" });
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
    const client = new AstraPluginClient({ token: "AstraCS:a:b" });
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
    const client = new AstraPluginClient({ token: "t" });
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
    const client = new AstraPluginClient({ token: "t" });
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
    const client = new AstraPluginClient({ token: "t" });
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
    const client = new AstraPluginClient({ token: "t" });
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
    const client = new AstraPluginClient({ token: "t" });
    await client.invokeAction(T.database, `acc:${T.database}:${DB.id}`, "resume", "acc");
    expect(calls.at(-1)!.url.host).toContain("apps.astra.datastax.com");
  });

  it("maps a 401 to a status-carrying error", async () => {
    mockFetch({
      "GET /v2/databases": new Response('{"errors":[{"message":"bad token"}]}', { status: 401 }),
    });
    const client = new AstraPluginClient({ token: "t" });
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
    const client = new AstraPluginClient({ token: "tok" });
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
