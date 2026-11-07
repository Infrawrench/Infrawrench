import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { PineconeApiError } from "../api.js";
import { buildConfigurePatch, parseMetadata, parseRoles, PineconeClient } from "../client.js";
import {
  indexShape,
  mapAssistant,
  mapBackupSchedule,
  mapIndex,
  parseTags,
  tagPatch,
} from "../mappers.js";
import { parsePrometheusText, prometheusSeries } from "../metrics.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { pineconeTerraformExport } from "../terraform.js";
import type { PcIndex } from "../types.js";
import { fakeHttp, respond } from "./helpers.js";

const ACCOUNT = "acct";

function client(extra: Record<string, string> = {}) {
  const http = fakeHttp();
  const c = hostClient(
    new PineconeClient({ apiKey: "pcsk_k", ...extra }, RESOURCE_TYPES, http.services),
  );
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

  describe("lists that cannot say they are complete (#384)", () => {
    const admin = { clientId: "cid", clientSecret: "secret" };
    const withToken = (http: ReturnType<typeof fakeHttp>) =>
      http.route("POST", "login.pinecone.io/oauth/token", { access_token: "t", expires_in: 1800 });

    /** A route that always has another page, numbering its cursors so none repeats. */
    const endless = (key: string, cursor: string) => (call: { url: URL }) => ({
      [key]: [{ backup_id: "b", name: "x", restore_job_id: "r", id: "s" }],
      pagination: { next: `${call.url.searchParams.get(cursor) ?? ""}n` },
    });

    const walks: [string, string, string, string, Record<string, string>][] = [
      ["backup", "api.pinecone.io/backups", "data", "paginationToken", {}],
      ["restore-job", "api.pinecone.io/restore-jobs", "data", "paginationToken", {}],
      ["assistant", "api.pinecone.io/assistant/assistants", "assistants", "pagination_token", {}],
      [
        "service-account",
        "api.pinecone.io/admin/service-accounts",
        "data",
        "paginationToken",
        admin,
      ],
    ];

    it.each(walks)("%s throws past 100 pages of 100", async (type, route, key, cursor, creds) => {
      const { http, c } = client(creds);
      withToken(http);
      http.route("GET", route, endless(key, cursor));
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      const pages = http.calls.filter((call) => `${call.url.host}${call.url.pathname}` === route);
      expect(pages).toHaveLength(100);
      expect(pages[0]!.url.searchParams.get("limit")).toBe("100");
    });

    it("throws for a backup schedule list past its cap", async () => {
      const { http, c } = client();
      http.route("GET", "api.pinecone.io/indexes", { indexes: [serverless] });
      http.route(
        "GET",
        "api.pinecone.io/indexes/products/backup-schedules",
        endless("data", "paginationToken"),
      );
      await expect(c.listResources("backup-schedule", ACCOUNT)).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it.each(walks)(
      "%s refuses a page with its key renamed",
      async (type, route, key, cursor, creds) => {
        const { http, c } = client(creds);
        withToken(http);
        http.route("GET", route, { rows: [], [key]: "not a list" });
        await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");

        const later = client(creds);
        withToken(later.http);
        later.http.route("GET", route, (call: { url: URL }) =>
          call.url.searchParams.get(cursor)
            ? { [key]: { oops: true } }
            : {
                [key]: [{ backup_id: "b", restore_job_id: "r", id: "s", name: "x" }],
                pagination: { next: "p2" },
              },
        );
        await expect(later.c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
      },
    );

    it.each([
      ["index", "api.pinecone.io/indexes", {}],
      ["collection", "api.pinecone.io/collections", {}],
      ["project", "api.pinecone.io/admin/projects", admin],
      ["restore-job", "api.pinecone.io/restore-jobs", {}],
      ["service-account", "api.pinecone.io/admin/service-accounts", admin],
    ] as const)("%s refuses a 200 with its list left out", async (type, route, creds) => {
      const { http, c } = client(creds);
      withToken(http);
      http.route("GET", route, { message: "try again" });
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    });

    it.each([
      ["index", "api.pinecone.io/indexes", {}],
      ["collection", "api.pinecone.io/collections", {}],
      ["backup", "api.pinecone.io/backups", {}],
      ["assistant", "api.pinecone.io/assistant/assistants", {}],
      ["project", "api.pinecone.io/admin/projects", admin],
    ] as const)("%s refuses a 200 with no body", async (type, route, creds) => {
      const { http, c } = client(creds);
      withToken(http);
      http.route("GET", route, respond(200, "", true));
      await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("reads an api key list with no data as a failure, not as no keys", async () => {
      const { http, c } = client(admin);
      withToken(http);
      http.route("GET", "api.pinecone.io/admin/projects", { data: [{ id: "p1", name: "Prod" }] });
      http.route("GET", "api.pinecone.io/admin/projects/p1/api-keys", { message: "try again" });
      await expect(c.listResources("api-key", ACCOUNT)).rejects.toThrow("is not a list");
    });

    it("takes the empty answers the document allows", async () => {
      const { http, c } = client();
      http.route("GET", "api.pinecone.io/indexes", { indexes: [] });
      http.route("GET", "api.pinecone.io/collections", { collections: [] });
      // Both documents leave the key optional and show no empty answer.
      http.route("GET", "api.pinecone.io/backups", {});
      http.route("GET", "api.pinecone.io/assistant/assistants", {});
      for (const type of ["index", "collection", "backup", "assistant"]) {
        expect(await c.listResources(type, ACCOUNT)).toEqual([]);
      }
    });

    it("still reads a forbidden index's schedules as none, and throws on anything else", async () => {
      const { http, c } = client();
      http.route("GET", "api.pinecone.io/indexes", { indexes: [serverless] });
      http.route(
        "GET",
        "api.pinecone.io/indexes/products/backup-schedules",
        respond(403, { status: 403, error: { code: "FORBIDDEN", message: "no" } }),
      );
      expect(await c.listResources("backup-schedule", ACCOUNT)).toEqual([]);
      http.route(
        "GET",
        "api.pinecone.io/indexes/products/backup-schedules",
        respond(500, { status: 500, error: { code: "INTERNAL", message: "no" } }),
      );
      await expect(c.listResources("backup-schedule", ACCOUNT)).rejects.toThrow("500");
    });

    it("keeps three pages of a schedule's history in its detail view, without throwing", async () => {
      const { http, c } = client();
      http.route(
        "GET",
        "api.pinecone.io/backup-schedules/s1/history",
        endless("data", "paginationToken"),
      );
      const detail = await c.enrichDetail(
        mapBackupSchedule(
          {
            schedule_id: "s1",
            index_id: "i",
            name: "nightly",
            frequency: "daily",
            enabled: true,
            created_at: "2026-01-01T00:00:00Z",
            next_scheduled_run: null,
            project_id: "p",
            retention_expire_after_days: 7,
            schedule_type: "time-based",
          },
          "products",
          ACCOUNT,
        ),
      );
      expect(JSON.parse(String(detail.fields["__history"]))).toHaveLength(3);
      expect(http.calls).toHaveLength(3);
    });

    const assistant = mapAssistant(
      { name: "helper", status: "Ready", host: "prod-1-data.ke.pinecone.io" },
      ACCOUNT,
    );
    const filesRoute = "prod-1-data.ke.pinecone.io/files/helper";

    it("counts every page of an assistant's files", async () => {
      const { http, c } = client();
      http.route("GET", filesRoute, (call: { url: URL }) =>
        call.url.searchParams.get("pagination_token") === "p2"
          ? { files: [{ id: "f2", name: "two.pdf" }] }
          : { files: [{ id: "f1", name: "one.pdf" }], pagination: { next: "p2" } },
      );
      const detail = await c.enrichDetail(assistant);
      expect(detail.fields["fileCount"]).toBe(2);
      expect(http.calls.map((call) => call.url.searchParams.get("limit"))).toEqual(["100", "100"]);
    });

    it("shows no file count rather than a short one", async () => {
      const { http, c } = client();
      http.route("GET", filesRoute, endless("files", "pagination_token"));
      const detail = await c.enrichDetail(assistant);
      expect(detail.fields["fileCount"]).toBeUndefined();
      expect(http.calls).toHaveLength(100);
    });

    it("still shows an index's own backups when the project has more than the cap", async () => {
      const { http, c } = client();
      http.route("GET", "api.pinecone.io/backups", (call: { url: URL }) => ({
        data: [
          {
            backup_id: `b${call.url.searchParams.get("paginationToken") ?? ""}`,
            source_index_name: "products",
            status: "Ready",
          },
        ],
        pagination: { next: `${call.url.searchParams.get("paginationToken") ?? ""}n` },
      }));
      http.route("GET", "api.pinecone.io/indexes/products/backup-schedules", { data: [] });
      const detail = await c.enrichDetail(mapIndex({ ...serverless, status: {} }, ACCOUNT));
      expect(JSON.parse(String(detail.fields["__backups"]))).toHaveLength(50);
    });
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

describe("a name that could not be looked up", () => {
  const scheduleId = `${ACCOUNT}:backup-schedule:s1`;
  const schedule = {
    schedule_id: "s1",
    index_id: "i1",
    name: "nightly",
    frequency: "daily",
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    next_scheduled_run: null,
    project_id: "p",
    retention_expire_after_days: 7,
    schedule_type: "time-based",
  };
  const broken = respond(500, { status: 500, error: { code: "INTERNAL", message: "no" } });

  it("finds a schedule's index by its schedules", async () => {
    const { http, c } = client();
    http.route("GET", "api.pinecone.io/backup-schedules/s1", schedule);
    http.route("GET", "api.pinecone.io/indexes", { indexes: [serverless] });
    http.route("GET", "api.pinecone.io/indexes/products/backup-schedules", { data: [schedule] });
    const found = await c.getResource("backup-schedule", scheduleId, ACCOUNT);
    expect(found.fields["indexName"]).toBe("products");
  });

  it("fails a schedule edit's read-back rather than blank the stored index name", async () => {
    for (const failing of [
      "api.pinecone.io/indexes",
      "api.pinecone.io/indexes/products/backup-schedules",
    ]) {
      const { http, c } = client();
      http.route("PATCH", "api.pinecone.io/backup-schedules/s1", schedule);
      http.route("GET", "api.pinecone.io/backup-schedules/s1", schedule);
      http.route("GET", "api.pinecone.io/indexes", { indexes: [serverless] });
      http.route("GET", "api.pinecone.io/indexes/products/backup-schedules", { data: [schedule] });
      http.route("GET", failing, broken);
      await expect(
        c.updateResource("backup-schedule", scheduleId, ACCOUNT, { frequency: "weekly" }),
      ).rejects.toThrow("500");
    }
  });

  it("skips an index whose schedules are refused, as the list does", async () => {
    const { http, c } = client();
    http.route("GET", "api.pinecone.io/backup-schedules/s1", schedule);
    http.route("GET", "api.pinecone.io/indexes", {
      indexes: [{ ...serverless, name: "first" }, serverless],
    });
    http.route(
      "GET",
      "api.pinecone.io/indexes/first/backup-schedules",
      respond(403, { status: 403, error: { code: "FORBIDDEN", message: "no" } }),
    );
    http.route("GET", "api.pinecone.io/indexes/products/backup-schedules", { data: [schedule] });
    const found = await c.getResource("backup-schedule", scheduleId, ACCOUNT);
    expect(found.fields["indexName"]).toBe("products");
  });

  it("fails an API key edit's read-back rather than blank the stored project name", async () => {
    const { http, c } = client({ clientId: "cid", clientSecret: "s" });
    const key = { id: "k1", name: "ci", project_id: "p1", roles: ["ProjectEditor"] };
    http.route("POST", "login.pinecone.io/oauth/token", { access_token: "t", expires_in: 1800 });
    http.route("PATCH", "api.pinecone.io/admin/api-keys/k1", key);
    http.route("GET", "api.pinecone.io/admin/api-keys/k1", key);
    http.route("GET", "api.pinecone.io/admin/projects", broken);
    await expect(
      c.updateResource("api-key", `${ACCOUNT}:api-key:k1`, ACCOUNT, { name: "renamed" }),
    ).rejects.toThrow("500");
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
        body: {
          type: "string",
          full_text_search: { language: "en", stemming: true, stop_words: false },
        },
      }),
    ).toMatchObject({ kind: "documents", fullTextFields: ["body"] });
  });

  it("reads the hosted embedding on a string field (#469)", () => {
    const embed = { model: "llama-text-embed-v2", dimension: 1024, metric: "cosine" };
    const sparseEmbed = { model: "pinecone-sparse-english-v0" };
    const fullText = { language: "en", stemming: true, stop_words: false };

    expect(indexShape({ body: { type: "string", embed } })).toMatchObject({
      kind: "documents",
      vectorType: "dense",
      dimension: 1024,
      metric: "cosine",
      embedModel: "llama-text-embed-v2",
    });
    expect(indexShape({ body: { type: "string", sparse_embed: sparseEmbed } })).toMatchObject({
      kind: "documents",
      vectorType: "sparse",
      dimension: undefined,
      metric: "dotproduct",
      embedModel: "pinecone-sparse-english-v0",
    });
    // The document's own example: one field with both, beside a full-text one.
    expect(
      indexShape({
        body: { type: "string", embed, sparse_embed: sparseEmbed },
        title: { type: "string", full_text_search: fullText },
      }),
    ).toMatchObject({
      kind: "documents",
      vectorType: "dense",
      dimension: 1024,
      metric: "cosine",
      embedModel: "llama-text-embed-v2, pinecone-sparse-english-v0",
      fullTextFields: ["title"],
    });
    expect(
      indexShape({ body: { type: "string", embed, full_text_search: fullText } }),
    ).toMatchObject({
      kind: "documents",
      vectorType: "dense",
      embedModel: "llama-text-embed-v2",
      fullTextFields: ["body"],
    });
  });

  it("calls a named sparse-only schema sparse, not dense", () => {
    expect(indexShape({ terms: { type: "sparse_vector" } })).toMatchObject({
      kind: "sparse",
      vectorType: "sparse",
    });
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

describe("hosts a response names (#386)", () => {
  const discovery = "api.pinecone.io/prometheus/projects/p1/metrics/discovery";
  const allowed = "metrics.us-east-1-aws.pinecone.io";
  const sample = 'pinecone_db_record_total{index_name="products"} 7';

  function scrapes(targets: string[]) {
    const { http, c } = client({ projectId: "p1" });
    http.route("GET", "api.pinecone.io/indexes/products", serverless);
    http.route("POST", "products-abc.svc.aped-4627.pinecone.io/describe_index_stats", {
      totalVectorCount: 7,
    });
    http.route("GET", discovery, [{ targets }]);
    http.route("GET", `${allowed}/metrics`, respond(200, sample, true));
    return { http, c };
  }

  const fetchMetrics = (c: ReturnType<typeof client>["c"]) =>
    c.fetchMetricSeries("index", `${ACCOUNT}:index:products`, ACCOUNT);

  it("scrapes a target under pinecone.io with the key as a Bearer token", async () => {
    const { http, c } = scrapes([`https://${allowed}/metrics`]);
    const series = await fetchMetrics(c);
    expect(series.find((s) => s.label === "Records (Prometheus)")!.points[0]!.value).toBe(7);
    const scrape = http.calls.find((call) => call.url.host === allowed)!;
    expect(scrape.headers["Authorization"]).toBe("Bearer pcsk_k");
  });

  it.each([
    ["another host", "https://evil.example/metrics"],
    ["a bare host", "evil.example/metrics"],
    ["a lookalike", "https://metrics.pinecone.io.evil.example/metrics"],
    ["plain http", `http://${allowed}/metrics`],
  ])("sends the key to no target on %s, and still scrapes the rest", async (_, target) => {
    const { http, c } = scrapes([target, `https://${allowed}/metrics`]);
    const series = await fetchMetrics(c);
    const hosts = http.calls.map((call) => `${call.url.protocol}//${call.url.host}`);
    expect(hosts).not.toContain("https://evil.example");
    expect(hosts).not.toContain("https://metrics.pinecone.io.evil.example");
    expect(hosts).not.toContain(`http://${allowed}`);
    expect(series.find((s) => s.label === "Records (Prometheus)")!.points[0]!.value).toBe(7);
  });

  it("sends the key to no index or assistant host outside pinecone.io", async () => {
    const { http, c } = client();
    for (const host of ["evil.example", "http://products.svc.pinecone.io"]) {
      const assistant = mapAssistant({ name: "helper", status: "Ready", host }, ACCOUNT);
      const detail = await c.enrichDetail(assistant);
      expect(detail.fields["fileCount"]).toBeUndefined();

      http.route("GET", "api.pinecone.io/assistant/assistants/helper", {
        name: "helper",
        status: "Ready",
        host,
      });
      const events = [];
      for await (const event of c.streamChatMessage!("assistant", assistant.id, ACCOUNT, [
        { role: "user", content: "hello" },
      ])) {
        events.push(event);
      }
      expect(events[0]).toMatchObject({
        kind: "error",
        message: expect.stringContaining("Refusing to send the account's credentials there"),
      });

      const index = mapIndex({ ...serverless, host }, ACCOUNT);
      await c.enrichDetail(index);
    }
    const hosts = http.calls.map((call) => `${call.url.protocol}//${call.url.host}`);
    expect(new Set(hosts)).toEqual(new Set(["https://api.pinecone.io"]));
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

  it("does not export a document index whose only field carries a hosted embedding (#469)", () => {
    const documentIndex: PcIndex = {
      ...serverless,
      name: "articles",
      schema: {
        fields: {
          body: {
            type: "string",
            embed: { model: "llama-text-embed-v2", dimension: 1024, metric: "cosine" },
          },
        },
      },
    };
    expect(pineconeTerraformExport.mapResource(mapIndex(documentIndex, ACCOUNT))).toBeNull();
  });
});
