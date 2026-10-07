import { describe, expect, it } from "vitest";
import { PineconeApiError } from "../api.js";
import { buildConfigurePatch, parseMetadata, parseRoles, PineconeClient } from "../client.js";
import { indexShape, mapIndex, parseTags, tagPatch } from "../mappers.js";
import { parsePrometheusText, prometheusSeries } from "../metrics.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { pineconeTerraformExport } from "../terraform.js";
import type { PcIndex } from "../types.js";
import { fakeHttp, respond } from "./helpers.js";

const ACCOUNT = "acct";

function client(extra: Record<string, string> = {}) {
  const http = fakeHttp();
  const c = new PineconeClient({ apiKey: "pcsk_k", ...extra }, RESOURCE_TYPES, http.services);
  return { http, c };
}

const serverless: PcIndex = {
  name: "products",
  host: "products-abc.svc.aped-4627.pinecone.io",
  status: { ready: true, state: "Ready" },
  deployment: { deployment_type: "managed", cloud: "aws", region: "us-east-1" },
  read_capacity: { mode: "OnDemand", status: { state: "Ready" } },
  schema: {
    fields: {
      _values: { type: "dense_vector", dimension: 1536, metric: "cosine" },
      _sparse_values: { type: "sparse_vector" },
    },
  },
  tags: { env: "prod" },
  deletion_protection: "disabled",
};

const pod: PcIndex = {
  name: "legacy",
  host: "legacy-abc.svc.us-east1-gcp.pinecone.io",
  status: { ready: true, state: "Ready" },
  deployment: {
    deployment_type: "pod",
    environment: "us-east1-gcp",
    pod_type: "p1.x1",
    replicas: 2,
    shards: 3,
  },
  schema: { fields: { _values: { type: "dense_vector", dimension: 768, metric: "dotproduct" } } },
  deletion_protection: "enabled",
};

describe("transport", () => {
  it("sends the API key and version header and maps indexes", async () => {
    const { http, c } = client();
    http.route("GET", "api.pinecone.io/indexes", { indexes: [serverless, pod] });
    const list = await c.listResources("index", ACCOUNT);
    expect(list.map((r) => r.externalId)).toEqual(["products", "legacy"]);
    const call = http.calls[0]!;
    expect(call.headers["Api-Key"]).toBe("pcsk_k");
    expect(call.headers["X-Pinecone-Api-Version"]).toBe("2026-07");
    const p = list[1]!;
    expect(p.fields["pods"]).toBe(6);
    expect(p.fields["region"]).toBe("us-east1-gcp");
    expect(list[0]!.resolvedOutputs["host"]).toBe("https://products-abc.svc.aped-4627.pinecone.io");
  });

  it("attaches the HTTP status to errors and summarises Pinecone's error body", async () => {
    const { http, c } = client();
    http.route(
      "GET",
      "api.pinecone.io/indexes/missing",
      respond(404, {
        status: 404,
        error: { code: "NOT_FOUND", message: "Index missing not found" },
      }),
    );
    const err = await c.getResource("index", `${ACCOUNT}:index:missing`, ACCOUNT).catch((e) => e);
    expect(err).toBeInstanceOf(PineconeApiError);
    expect((err as PineconeApiError).status).toBe(404);
    expect((err as Error).message).toContain("NOT_FOUND: Index missing not found");
  });

  it("follows paginationToken across backup pages", async () => {
    const { http, c } = client();
    http.route("GET", "api.pinecone.io/backups", (call: { url: URL }) =>
      call.url.searchParams.get("paginationToken") === "p2"
        ? { data: [{ backup_id: "b2", source_index_name: "products", status: "Ready" }] }
        : {
            data: [{ backup_id: "b1", source_index_name: "products", status: "Ready" }],
            pagination: { next: "p2" },
          },
    );
    const list = await c.listResources("backup", ACCOUNT);
    expect(list.map((b) => b.externalId)).toEqual(["b1", "b2"]);
  });

  it("exchanges service-account credentials once and uses the Bearer token for Admin calls", async () => {
    const { http, c } = client({ clientId: "cid", clientSecret: "secret" });
    let tokens = 0;
    http.route("POST", "login.pinecone.io/oauth/token", (call: { body: unknown }) => {
      tokens++;
      expect(call.body).toMatchObject({
        grant_type: "client_credentials",
        client_id: "cid",
        audience: "https://api.pinecone.io/",
      });
      return { access_token: "tok", expires_in: 1800, token_type: "Bearer" };
    });
    http.route("GET", "api.pinecone.io/admin/projects", {
      data: [{ id: "p1", name: "Prod", max_pods: 0, force_encryption_with_cmek: false }],
    });
    http.route("GET", "api.pinecone.io/admin/projects/p1/api-keys", {
      data: [{ id: "k1", name: "ci", project_id: "p1", roles: ["ProjectEditor"] }],
    });
    const projects = await c.listResources("project", ACCOUNT);
    const keys = await c.listResources("api-key", ACCOUNT);
    expect(projects[0]!.displayName).toBe("Prod");
    expect(keys[0]!.fields["projectName"]).toBe("Prod");
    expect(keys[0]!.parentResourceId).toBe(`${ACCOUNT}:project:p1`);
    expect(tokens).toBe(1);
    const admin = http.calls.find((x) => x.url.pathname === "/admin/projects")!;
    expect(admin.headers["Authorization"]).toBe("Bearer tok");
  });

  it("lists nothing from the Admin API without a service account", async () => {
    const { http, c } = client();
    expect(await c.listResources("project", ACCOUNT)).toEqual([]);
    expect(http.calls).toHaveLength(0);
  });
});

describe("create and edit", () => {
  it("creates a dense serverless index with the reserved _values schema", async () => {
    const { http, c } = client();
    http.route("POST", "api.pinecone.io/indexes", (call: { body: unknown }) => ({
      ...serverless,
      name: (call.body as { name: string }).name,
    }));
    await c.createResource("index", ACCOUNT, {
      name: "docs",
      kind: "dense",
      dimension: "768",
      metric: "dotproduct",
      region: "gcp/europe-west4",
      tags: "team=search",
      readCapacityMode: "Dedicated",
      nodeType: "t1",
      replicas: "2",
      shards: "1",
    });
    expect(http.calls[0]!.body).toEqual({
      name: "docs",
      deployment: { deployment_type: "managed", cloud: "gcp", region: "europe-west4" },
      schema: {
        fields: { _values: { type: "dense_vector", dimension: 768, metric: "dotproduct" } },
      },
      tags: { team: "search" },
      deletion_protection: "disabled",
      read_capacity: {
        mode: "Dedicated",
        dedicated: { node_type: "t1", scaling: "Manual", manual: { replicas: 2, shards: 1 } },
      },
    });
  });

  it("creates an integrated index through create-for-model", async () => {
    const { http, c } = client();
    http.route("POST", "api.pinecone.io/indexes/create-for-model", serverless);
    await c.createResource("index", ACCOUNT, {
      name: "semantic",
      kind: "integrated",
      model: "llama-text-embed-v2",
      textField: "chunk",
      region: "aws/us-east-1",
    });
    expect(http.calls[0]!.body).toMatchObject({
      name: "semantic",
      cloud: "aws",
      region: "us-east-1",
      embed: { model: "llama-text-embed-v2", field_map: { text: "chunk" } },
    });
  });

  it("rejects an invalid index name before calling Pinecone", async () => {
    const { http, c } = client();
    await expect(
      c.createResource("index", ACCOUNT, { name: "Bad_Name", kind: "dense" }),
    ).rejects.toThrow(/lowercase/);
    expect(http.calls).toHaveLength(0);
  });

  it("stores a new API key's value so the output can resolve it", async () => {
    const { http, c } = client({ clientId: "cid", clientSecret: "s" });
    http.route("POST", "login.pinecone.io/oauth/token", { access_token: "t", expires_in: 1800 });
    http.route("GET", "api.pinecone.io/admin/projects", { data: [{ id: "p1", name: "Prod" }] });
    http.route("POST", "api.pinecone.io/admin/projects/p1/api-keys", {
      key: { id: "k9", name: "ci", project_id: "p1", roles: ["DataPlaneViewer"] },
      value: "pckey_abc_123",
    });
    const created = await c.createResource("api-key", ACCOUNT, {
      projectId: "p1",
      name: "ci",
      roles: '["DataPlaneViewer"]',
    });
    const id = "resource" in created ? created.resource.id : created.id;
    expect(await c.resolveOutput("api-key", id, "apiKey", ACCOUNT)).toBe("pckey_abc_123");
  });

  it("builds a configure patch for a pod index", () => {
    expect(buildConfigurePatch(pod, { replicas: "4", podType: "p1.x2" })).toEqual({
      deployment: { replicas: 4, pod_type: "p1.x2" },
    });
    expect(() => buildConfigurePatch(pod, { shards: "5" })).toThrow(/fixed/);
  });

  it("builds a configure patch for read capacity and tags", () => {
    expect(
      buildConfigurePatch(serverless, {
        readCapacityMode: "Dedicated",
        replicas: "3",
        tags: "team=a",
        deletionProtection: "enabled",
      }),
    ).toEqual({
      deletion_protection: "enabled",
      tags: { team: "a", env: "" },
      read_capacity: {
        mode: "Dedicated",
        dedicated: { node_type: "b1", scaling: "Manual", manual: { replicas: 3, shards: 1 } },
      },
    });
    expect(buildConfigurePatch(serverless, { readCapacityMode: "OnDemand" })).toEqual({});
  });
});

describe("mappers", () => {
  it("summarises 2026-07 schemas", () => {
    expect(indexShape(serverless.schema?.fields).kind).toBe("dense");
    expect(indexShape({ _sparse_values: { type: "sparse_vector" } })).toMatchObject({
      kind: "sparse",
      metric: "dotproduct",
    });
    expect(
      indexShape({
        text: { type: "semantic_text", model: "multilingual-e5-large", dimension: 1024 },
      }),
    ).toMatchObject({ kind: "integrated", embedModel: "multilingual-e5-large", dimension: 1024 });
    expect(
      indexShape({
        embedding: { type: "dense_vector", dimension: 3, metric: "cosine" },
        body: { type: "string", full_text_search: { language: "en" } },
      }),
    ).toMatchObject({ kind: "documents", fullTextFields: ["body"] });
  });

  it("parses and diffs tags", () => {
    expect(parseTags("a=1, b = two")).toEqual({ a: "1", b: "two" });
    expect(() => parseTags("novalue")).toThrow();
    expect(tagPatch({ a: "1", gone: "x" }, { a: "2" })).toEqual({ a: "2", gone: "" });
  });

  it("validates roles and metadata", () => {
    expect(parseRoles("ProjectViewer, DataPlaneEditor")).toEqual([
      "ProjectViewer",
      "DataPlaneEditor",
    ]);
    expect(() => parseRoles("Admin")).toThrow(/Unknown role/);
    expect(parseMetadata("")).toBeNull();
    expect(() => parseMetadata("[1]")).toThrow();
  });
});

describe("metrics", () => {
  it("parses Prometheus text and folds one index's samples", () => {
    const text = [
      "# HELP pinecone_db_record_total records",
      "# TYPE pinecone_db_record_total gauge",
      'pinecone_db_record_total{index_name="products",shard_id="0"} 10',
      'pinecone_db_record_total{index_name="products",shard_id="1"} 5',
      'pinecone_db_record_total{index_name="other"} 99',
      'pinecone_db_index_fullness{index_name="products",shard_id="0"} 0.2',
      'pinecone_db_index_fullness{index_name="products",shard_id="1"} 0.4',
    ].join("\n");
    const samples = parsePrometheusText(text);
    expect(samples).toHaveLength(5);
    const series = prometheusSeries(samples, "products", 1);
    expect(series.find((s) => s.label === "Records (Prometheus)")!.points[0]!.value).toBe(15);
    expect(series.find((s) => s.label === "Index Fullness")!.points[0]!.value).toBeCloseTo(30);
  });

  it("returns index stats as current-value series", async () => {
    const { http, c } = client();
    http.route("GET", "api.pinecone.io/indexes/products", serverless);
    http.route("POST", "products-abc.svc.aped-4627.pinecone.io/describe_index_stats", {
      namespaces: { "": { vectorCount: 3 }, a: { vectorCount: 4 } },
      totalVectorCount: 7,
      indexFullness: 0,
    });
    const series = await c.fetchMetricSeries("index", `${ACCOUNT}:index:products`, ACCOUNT);
    expect(series.map((s) => [s.label, s.points[0]!.value])).toEqual([
      ["Records", 7],
      ["Namespaces", 2],
    ]);
  });
});

describe("quotas", () => {
  it("reports pods used against max_pods", async () => {
    const { http, c } = client({ clientId: "c", clientSecret: "s", projectId: "p1" });
    http.route("POST", "login.pinecone.io/oauth/token", { access_token: "t", expires_in: 1800 });
    http.route("GET", "api.pinecone.io/admin/projects/p1", {
      id: "p1",
      name: "Prod",
      max_pods: 10,
    });
    http.route("GET", "api.pinecone.io/indexes", { indexes: [serverless, pod] });
    const quotas = await c.fetchQuotas();
    expect(quotas).toEqual([expect.objectContaining({ limit: 10, used: 6, unit: "pods" })]);
  });
});

describe("status feed", () => {
  it("maps serverless regions and pod environments", () => {
    expect(mapComponent("AWS us-east-1")).toMatchObject({ regions: ["us-east-1"] });
    expect(mapComponent("GCP europe-west4")).toMatchObject({ regions: ["europe-west4"] });
    expect(mapComponent("us-east1-gcp")).toMatchObject({ regions: ["us-east1-gcp"] });
    expect(mapComponent("Index Management")).toMatchObject({ providerWide: true });
    expect(parseStatusFeed(JSON.stringify({ incidents: [] }))).toEqual([]);
  });
});

describe("terraform", () => {
  it("maps a serverless index and a pod index", () => {
    const s = pineconeTerraformExport.mapResource(mapIndex(serverless, ACCOUNT))!;
    expect(s.resource.type).toBe("pinecone_index");
    expect(s.resource.importId).toBe("products");
    expect(s.resource.attributes["spec"]).toEqual({
      kind: "map",
      entries: {
        serverless: {
          kind: "map",
          entries: {
            cloud: { kind: "string", value: "aws" },
            region: { kind: "string", value: "us-east-1" },
          },
        },
      },
    });
    const p = pineconeTerraformExport.mapResource(mapIndex(pod, ACCOUNT))!;
    expect(JSON.stringify(p.resource.attributes["spec"])).toContain("p1.x1");
  });
});
