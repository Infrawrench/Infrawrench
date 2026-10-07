import { describe, expect, it } from "vitest";
import { normalizeEndpoint, parseCloudHost, WeaviateApiError } from "../api.js";
import {
  backupBackends,
  checkCollectionName,
  parseProperties,
  vectorizerModules,
  WeaviateClient,
} from "../client.js";
import { collectionStats, normalizeActivity } from "../mappers.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { fakeHttp, respond } from "./helpers.js";

const HOST = "abc.c0.europe-west3.gcp.weaviate.cloud";
const ACCOUNT = "acct";

function client() {
  const http = fakeHttp();
  const c = new WeaviateClient(
    { endpoint: `${HOST}/v1/`, apiKey: "k" },
    RESOURCE_TYPES,
    http.services,
  );
  return { http, c };
}

const nodes = {
  nodes: [
    {
      name: "n0",
      status: "HEALTHY",
      version: "1.33.0",
      stats: { objectCount: 10, shardCount: 2 },
      shards: [
        { class: "Article", name: "s1", objectCount: 7, vectorQueueLength: 3 },
        { class: "Doc", name: "s2", objectCount: 3 },
      ],
    },
    {
      name: "n1",
      status: "UNHEALTHY",
      stats: { objectCount: 5, shardCount: 1 },
      shards: [{ class: "Article", name: "s3", objectCount: 5 }],
    },
  ],
};

describe("endpoint handling", () => {
  it("normalises pasted endpoints and reads WCD region", () => {
    expect(normalizeEndpoint(`${HOST}/v1/`)).toBe(`https://${HOST}`);
    expect(parseCloudHost(HOST)).toEqual({ region: "europe-west3", cloud: "gcp" });
    expect(parseCloudHost("http://localhost:8080")).toBeNull();
  });
});

describe("client", () => {
  it("builds the cluster root from meta and nodes with Bearer auth", async () => {
    const { http, c } = client();
    http.route("GET", `${HOST}/v1/meta`, {
      version: "1.33.0",
      modules: { "backup-gcs": {}, "text2vec-openai": {} },
    });
    http.route("GET", `${HOST}/v1/nodes`, nodes);
    const [cluster] = await c.listResources("cluster", ACCOUNT);
    expect(cluster!.fields).toMatchObject({
      status: "DEGRADED",
      nodes: 2,
      healthyNodes: 1,
      objectCount: 15,
      region: "europe-west3",
      cloud: "gcp",
    });
    expect(cluster!.resolvedOutputs["grpcHost"]).toBe(`grpc-${HOST}`);
    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer k");
    expect(
      http.calls.find((x) => x.url.pathname === "/v1/nodes")!.url.searchParams.get("output"),
    ).toBe("verbose");
  });

  it("joins collection stats from node shards", async () => {
    const { http, c } = client();
    http.route("GET", `${HOST}/v1/schema`, {
      classes: [
        {
          class: "Article",
          vectorizer: "text2vec-openai",
          properties: [{ name: "title", dataType: ["text"] }],
        },
        {
          class: "Doc",
          vectorConfig: {
            body: { vectorizer: { "text2vec-cohere": {} }, vectorIndexType: "hnsw" },
          },
        },
      ],
    });
    http.route("GET", `${HOST}/v1/nodes`, nodes);
    const cols = await c.listResources("collection", ACCOUNT);
    expect(cols[0]!.fields).toMatchObject({
      objectCount: 12,
      shardCount: 2,
      vectorQueueLength: 3,
      properties: "title: text",
    });
    expect(cols[1]!.fields).toMatchObject({
      vectorizer: "text2vec-cohere",
      namedVectors: "body (text2vec-cohere, hnsw)",
    });
  });

  it("keeps the HTTP status and Weaviate's error message", async () => {
    const { http, c } = client();
    http.route(
      "GET",
      `${HOST}/v1/schema/Missing`,
      respond(404, { error: [{ message: "class not found" }] }),
    );
    const err = await c
      .getResource("collection", `${ACCOUNT}:collection:${HOST}/Missing`, ACCOUNT)
      .catch((e) => e);
    expect(err).toBeInstanceOf(WeaviateApiError);
    expect((err as WeaviateApiError).status).toBe(404);
    expect((err as Error).message).toContain("class not found");
  });

  it("treats a cluster without aliases or RBAC as empty", async () => {
    const { c } = client();
    expect(await c.listResources("alias", ACCOUNT)).toEqual([]);
    expect(await c.listResources("db-user", ACCOUNT)).toEqual([]);
  });

  it("creates a collection with typed properties", async () => {
    const { http, c } = client();
    http.route("POST", `${HOST}/v1/schema`, (call: { body: unknown }) => call.body);
    await c.createResource("collection", ACCOUNT, {
      name: "Article",
      vectorizer: "none",
      properties: JSON.stringify([
        { name: "title", dataType: "text" },
        { name: "year", dataType: "int" },
      ]),
      multiTenancy: "true",
      replicationFactor: "2",
    });
    expect(http.calls[0]!.body).toMatchObject({
      class: "Article",
      properties: [
        { name: "title", dataType: ["text"] },
        { name: "year", dataType: ["int"] },
      ],
      multiTenancyConfig: { enabled: true },
      replicationConfig: { factor: 2 },
    });
  });

  it("stores a new database user's key and diffs roles on edit", async () => {
    const { http, c } = client();
    http.route("POST", `${HOST}/v1/users/db/svc`, { apikey: "secret" });
    http.route("POST", `${HOST}/v1/authz/users/svc/assign`, {});
    http.route("POST", `${HOST}/v1/authz/users/svc/revoke`, {});
    http.route("GET", `${HOST}/v1/users/db/svc`, {
      userId: "svc",
      roles: ["viewer", "old"],
      active: true,
    });
    const created = await c.createResource("db-user", ACCOUNT, {
      userId: "svc",
      roles: '["viewer"]',
    });
    const id = "resource" in created ? created.resource.id : created.id;
    expect(await c.resolveOutput("db-user", id, "apiKey", ACCOUNT)).toBe("secret");
    await c.updateResource("db-user", id, ACCOUNT, { roles: "viewer, admin" });
    const assigns = http.calls.filter((x) => x.url.pathname.endsWith("/assign")).map((x) => x.body);
    const revokes = http.calls.filter((x) => x.url.pathname.endsWith("/revoke")).map((x) => x.body);
    expect(assigns.at(-1)).toEqual({ roles: ["admin"], userType: "db" });
    expect(revokes).toEqual([{ roles: ["old"], userType: "db" }]);
  });

  it("sets a tenant's activity", async () => {
    const { http, c } = client();
    http.route("PUT", `${HOST}/v1/schema/Article/tenants`, []);
    http.route("GET", `${HOST}/v1/schema/Article/tenants/acme`, {
      name: "acme",
      activityStatus: "COLD",
    });
    const t = await c.updateResource("tenant", `${ACCOUNT}:tenant:${HOST}/Article/acme`, ACCOUNT, {
      activityStatus: "INACTIVE",
    });
    expect(http.calls[0]!.body).toEqual([{ name: "acme", activityStatus: "INACTIVE" }]);
    expect(t.fields["activityStatus"]).toBe("INACTIVE");
  });

  it("returns node stats as current-value metrics", async () => {
    const { http, c } = client();
    http.route("GET", `${HOST}/v1/nodes`, nodes);
    const s = await c.fetchMetricSeries("collection", `${ACCOUNT}:collection:${HOST}/Article`);
    expect(s.map((x) => [x.label, x.points[0]!.value])).toEqual([
      ["Objects", 12],
      ["Shards", 2],
      ["Vector Queue", 3],
    ]);
  });
});

describe("helpers", () => {
  it("validates and parses", () => {
    expect(() => checkCollectionName("article")).toThrow();
    expect(() => parseProperties(JSON.stringify([{ name: "x", dataType: "bogus" }]))).toThrow(
      /Unknown/,
    );
    expect(normalizeActivity("FROZEN")).toBe("OFFLOADED");
    expect(backupBackends({ modules: { "backup-s3": {}, "text2vec-openai": {} } })).toEqual(["s3"]);
    expect(vectorizerModules({ modules: { "backup-s3": {}, "text2vec-openai": {} } })).toEqual([
      "text2vec-openai",
    ]);
    expect(collectionStats(nodes.nodes).get("Doc")).toEqual({ objects: 3, shards: 1, queue: 0 });
  });
});
