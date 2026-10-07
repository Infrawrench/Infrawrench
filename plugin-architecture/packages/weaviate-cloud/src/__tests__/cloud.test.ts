import { describe, expect, it } from "vitest";
import { clusterKeyOf } from "../api.js";
import {
  fingerprint,
  parseRefreshToken,
  SESSION_FIELD,
  sessionResourceId,
  WCLOUD_CLIENT_ID,
} from "../cloud.js";
import { parseClusterLines, WeaviateClient } from "../client.js";
import { partsOf, splitScoped } from "../mappers.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { fakeHttp, respond } from "./helpers.js";

const ACCOUNT = "acct";
const API = "api-cloud.weaviate.cloud";
const AUTH = "auth.weaviate.cloud";
const A = "aaa.c0.europe-west3.gcp.weaviate.cloud";
const B = "bbb.c0.eu-central-1.aws.weaviate.cloud";
const SELF = "weaviate.internal:8080";

const meta = { version: "1.33.0", modules: {} };
const nodes = {
  nodes: [{ name: "n0", status: "HEALTHY", stats: { objectCount: 4, shardCount: 1 } }],
};

function signedIn(extra: Record<string, string> = {}) {
  const http = fakeHttp();
  http.route("POST", `${AUTH}/oauth2/v1/apps/token`, {
    access_token: "access-1",
    refresh_token: "refresh-2",
    expires_in: 3600,
  });
  http.route("GET", `${API}/v1/regions`, {
    data: [{ id: "eu-central-1", name: "Frankfurt", cloud_provider: "aws", is_default: true }],
    metadata: {},
  });
  http.route("GET", `${API}/v1/clusters`, {
    data: [
      {
        id: "c-a",
        name: "search",
        status: "READY",
        tier: "free",
        region: "eu-central-1",
        endpoint: `https://${A}`,
      },
      {
        id: "c-b",
        name: "docs",
        status: "READY",
        tier: "free",
        region: "eu-central-1",
        endpoint: B,
      },
    ],
    metadata: {},
  });
  const c = new WeaviateClient(
    { cloudToken: "refresh-1", ...extra },
    RESOURCE_TYPES,
    http.services,
  );
  return { http, c };
}

describe("ids and credentials", () => {
  it("files clusters under their host and splits child ids", () => {
    expect(clusterKeyOf("AAA.c0.europe-west3.gcp.weaviate.cloud/v1/")).toBe(A);
    expect(clusterKeyOf("http://weaviate.internal:8080")).toBe(SELF);
    expect(splitScoped(`${ACCOUNT}:tenant:${SELF}/Article/acme`)).toEqual({
      scope: { accountId: ACCOUNT, key: SELF },
      parts: ["Article", "acme"],
    });
    expect(partsOf(`${ACCOUNT}:backup:${A}/gcs/nightly`, 2)).toEqual(["gcs", "nightly"]);
  });

  it("reads More clusters lines", () => {
    expect(parseClusterLines(`# comment\n${A} key-a\n\nhttp://${SELF}\n${B},key-b`)).toEqual([
      { endpoint: `https://${A}`, apiKey: "key-a" },
      { endpoint: `http://${SELF}`, apiKey: "" },
      { endpoint: `https://${B}`, apiKey: "key-b" },
    ]);
  });

  it("accepts the bare refresh token or the whole wcloud credentials file", () => {
    expect(parseRefreshToken("  refresh-1 ")).toBe("refresh-1");
    expect(parseRefreshToken(JSON.stringify({ access_token: "x", refresh_token: "r" }))).toBe("r");
    expect(() => new WeaviateClient({}, RESOURCE_TYPES)).toThrow(/endpoint/);
  });
});

describe("many clusters per account", () => {
  it("lists every credential cluster with its own key", async () => {
    const http = fakeHttp();
    for (const host of [A, SELF]) {
      http.route("GET", `${host}/v1/meta`, meta);
      http.route("GET", `${host}/v1/nodes`, nodes);
      http.route("GET", `${host}/v1/schema`, { classes: [{ class: "Article" }] });
    }
    const c = new WeaviateClient(
      { endpoint: A, apiKey: "key-a", clusters: `http://${SELF}` },
      RESOURCE_TYPES,
      http.services,
    );
    const clusters = await c.listResources("cluster", ACCOUNT);
    expect(clusters.map((x) => [x.id, x.fields["hosting"], x.fields["status"]])).toEqual([
      [`${ACCOUNT}:cluster:${A}`, "Weaviate Cloud", "HEALTHY"],
      [`${ACCOUNT}:cluster:${SELF}`, "Self-hosted", "HEALTHY"],
    ]);
    const cols = await c.listResources("collection", ACCOUNT);
    expect(cols.map((x) => [x.id, x.parentResourceId, x.fields["cluster"]])).toEqual([
      [`${ACCOUNT}:collection:${A}/Article`, `${ACCOUNT}:cluster:${A}`, A],
      [`${ACCOUNT}:collection:${SELF}/Article`, `${ACCOUNT}:cluster:${SELF}`, SELF],
    ]);
    const auth = http.calls
      .filter((x) => x.url.pathname === "/v1/schema")
      .map((x) => x.headers["Authorization"]);
    expect(auth).toEqual(["Bearer key-a", undefined]);
  });

  it("connects a cluster by endpoint into the More clusters credential", async () => {
    const http = fakeHttp();
    http.route("GET", `${A}/v1/schema`, { classes: [] });
    http.route("GET", `${SELF}/v1/schema`, { classes: [] });
    const c = new WeaviateClient({ endpoint: A, apiKey: "key-a" }, RESOURCE_TYPES, http.services);
    const res = await c.createResource("cluster", ACCOUNT, {
      endpoint: `http://${SELF}/`,
      apiKey: "key-self",
    });
    expect("credentialUpdates" in res && res.credentialUpdates).toEqual({
      clusters: `http://${SELF} key-self`,
    });
  });

  it("refuses a key the cluster rejects", async () => {
    const http = fakeHttp();
    http.route("GET", `${SELF}/v1/schema`, respond(401, { error: [{ message: "bad key" }] }));
    const c = new WeaviateClient({ endpoint: A }, RESOURCE_TYPES, http.services);
    await expect(
      c.createResource("cluster", ACCOUNT, { endpoint: `http://${SELF}`, apiKey: "nope" }),
    ).rejects.toThrow(/refused/);
  });
});

describe("Weaviate Cloud organization", () => {
  it("lists the organization's clusters and refreshes with the wcloud client id", async () => {
    const { http, c } = signedIn({ clusters: `${B} key-b` });
    http.route("GET", `${B}/v1/meta`, meta);
    http.route("GET", `${B}/v1/nodes`, nodes);
    const clusters = await c.listResources("cluster", ACCOUNT);
    const byKey = Object.fromEntries(clusters.map((x) => [x.externalId, x.fields]));
    expect(byKey[A]).toMatchObject({
      name: "search",
      clusterId: "c-a",
      tier: "free",
      lifecycle: "READY",
      region: "eu-central-1",
      cloud: "aws",
      status: "NOT_CONNECTED",
      connection: "Not connected",
    });
    expect(byKey[B]).toMatchObject({ status: "HEALTHY", connection: "Account credentials" });

    const token = http.calls.find((x) => x.url.host === AUTH)!;
    const form = new URLSearchParams(String(token.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe(WCLOUD_CLIENT_ID);
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(http.calls.find((x) => x.url.host === API)!.headers["Authorization"]).toBe(
      "Bearer access-1",
    );
    // The rotated refresh token is kept for the next session.
    expect(JSON.parse(http.secrets.get(`${sessionResourceId(ACCOUNT)}/${SESSION_FIELD}`)!)).toEqual(
      { seed: fingerprint("refresh-1"), token: "refresh-2" },
    );
  });

  it("connects a listed cluster by claiming its one-time key", async () => {
    const { http, c } = signedIn();
    http.route("GET", `${API}/v1/clusters/c-a`, {
      data: { id: "c-a", status: "READY", endpoint: `https://${A}`, api_key: { value: "once" } },
      metadata: {},
    });
    http.route("GET", `${A}/v1/schema`, { classes: [{ class: "Doc" }] });
    http.route("GET", `${A}/v1/nodes`, nodes);
    await c.executeNoSqlCommand("cluster", `${ACCOUNT}:cluster:${A}`, ACCOUNT, "connect", [
      JSON.stringify({ apiKey: "" }),
    ]);
    expect(http.secrets.get(`${ACCOUNT}:cluster:${A}/apiKey`)).toBe("once");
    const cols = await c.listResources("collection", ACCOUNT);
    expect(cols.map((x) => x.id)).toEqual([`${ACCOUNT}:collection:${A}/Doc`]);
    expect(
      http.calls
        .filter((x) => x.url.host === A)
        .every((x) => x.headers["Authorization"] === "Bearer once"),
    ).toBe(true);
  });

  it("says so when the one-time key was already shown", async () => {
    const { http, c } = signedIn();
    http.route("GET", `${API}/v1/clusters/c-a`, {
      data: { id: "c-a", api_key: { value: "", warning: "already revealed" } },
      metadata: {},
    });
    await expect(
      c.executeNoSqlCommand("cluster", `${ACCOUNT}:cluster:${A}`, ACCOUNT, "connect", [
        JSON.stringify({}),
      ]),
    ).rejects.toThrow(/already shown/);
  });

  it("creates a free cluster with an idempotency key and claims its key once READY", async () => {
    const { http, c } = signedIn();
    http.route("POST", `${API}/v1/clusters`, {
      data: {
        id: "c-new",
        name: "fresh",
        status: "CREATING",
        tier: "free",
        region: "eu-central-1",
      },
      metadata: {},
    });
    const created = await c.createResource("cluster", ACCOUNT, {
      mode: "create",
      name: "fresh",
      region: "eu-central-1",
      tier: "free",
    });
    const post = http.calls.find((x) => x.method === "POST" && x.url.host === API)!;
    expect(post.body).toEqual({ name: "fresh", region: "eu-central-1", tier: "free" });
    expect(post.headers["Idempotency-Key"]).toBeTruthy();
    expect("id" in created && created.fields["lifecycle"]).toBe("CREATING");
    expect(http.secrets.get(`${ACCOUNT}:cluster:wcd-c-new/pendingKey`)).toBe("1");

    const host = "new.c0.eu-central-1.aws.weaviate.cloud";
    http.route("GET", `${API}/v1/clusters`, {
      data: [{ id: "c-new", status: "READY", endpoint: `https://${host}` }],
      metadata: {},
    });
    http.route("GET", `${API}/v1/clusters/c-new`, {
      data: {
        id: "c-new",
        status: "READY",
        endpoint: `https://${host}`,
        api_key: { value: "minted" },
      },
      metadata: {},
    });
    http.route("GET", `${host}/v1/meta`, meta);
    http.route("GET", `${host}/v1/nodes`, nodes);
    const fresh = new WeaviateClient({ cloudToken: "refresh-1" }, RESOURCE_TYPES, http.services);
    const [cluster] = await fresh.listResources("cluster", ACCOUNT);
    expect(http.secrets.get(`${ACCOUNT}:cluster:${host}/apiKey`)).toBe("minted");
    expect(http.secrets.get(`${ACCOUNT}:cluster:wcd-c-new/pendingKey`)).toBe("");
    expect(cluster!.fields).toMatchObject({ status: "HEALTHY", connection: "Connected key" });
  });

  it("explains the free-cluster quota", async () => {
    const { http, c } = signedIn();
    http.route(
      "POST",
      `${API}/v1/clusters`,
      respond(409, { error: { code: "quota_exceeded", message: "limit" }, metadata: {} }),
    );
    await expect(c.createResource("cluster", ACCOUNT, { mode: "create" })).rejects.toThrow(
      /one free cluster/,
    );
  });

  it("offers the organization's regions and only the free tier", async () => {
    const { c } = signedIn();
    await c.listResources("cluster", ACCOUNT);
    const cfg = await c.getCreateConfig("cluster");
    const region = cfg.fields.find((f) => f.key === "region")!;
    expect(region.defaultValue).toBe("eu-central-1");
    expect(cfg.fields.find((f) => f.key === "tier")!.options!.map((o) => o.id)).toEqual(["free"]);
  });

  it("asks for a new sign-in when the refresh token is refused", async () => {
    const http = fakeHttp();
    http.route("POST", `${AUTH}/oauth2/v1/apps/token`, respond(400, { error: "invalid_grant" }));
    const c = new WeaviateClient({ cloudToken: "stale" }, RESOURCE_TYPES, http.services);
    await expect(c.listResources("cluster", ACCOUNT)).rejects.toThrow(/wcloud auth login/);
  });
});
