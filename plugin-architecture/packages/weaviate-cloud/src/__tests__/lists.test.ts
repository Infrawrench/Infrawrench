import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it } from "vitest";
import { WeaviateClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { fakeHttp, respond } from "./helpers.js";

const HOST = "abc.c0.europe-west3.gcp.weaviate.cloud";
const OTHER = "def.c0.europe-west3.gcp.weaviate.cloud";
const ACCOUNT = "acct";
const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

type UnreadPart = { parentResourceIds?: readonly string[]; idPrefixes?: readonly string[] };

/** Pretends to be a host that tracks unread rows, as the server's sync does. */
function trackUnread(): UnreadPart[] {
  const parts: UnreadPart[] = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: UnreadPart) => void parts.push(part));
  return parts;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, UNREAD_HOOK);
});

function client(extra: Record<string, string> = {}) {
  const http = fakeHttp();
  const c = hostClient(
    new WeaviateClient({ endpoint: HOST, apiKey: "k", ...extra }, RESOURCE_TYPES, http.services),
  );
  return { http, c };
}

const collectionName = (i: number) => `Mt${String(i).padStart(4, "0")}`;

/** A schema of `count` multi-tenant collections, each with one tenant. */
function multiTenant(http: ReturnType<typeof fakeHttp>, host: string, count: number) {
  const classes = Array.from({ length: count }, (_, i) => ({
    class: collectionName(i),
    multiTenancyConfig: { enabled: true },
  }));
  http.route("GET", `${host}/v1/schema`, { classes: [...classes, { class: "Plain" }] });
  for (const c of classes) {
    http.route("GET", `${host}/v1/schema/${c.class}/tenants`, [
      { name: `t-${c.class}`, activityStatus: "HOT" },
    ]);
  }
}

const tenantReads = (http: ReturnType<typeof fakeHttp>) =>
  http.calls.filter((x) => x.url.pathname.endsWith("/tenants")).length;

describe("tenants", () => {
  it("reads every multi-tenant collection where nobody keeps unread rows", async () => {
    const { http, c } = client();
    multiTenant(http, HOST, 260);
    const tenants = await c.listResources("tenant", ACCOUNT);
    expect(tenants).toHaveLength(260);
    expect(tenantReads(http)).toBe(260);
  });

  it("reads a budget per poll and names the collections it left for later", async () => {
    const parts = trackUnread();
    const { http, c } = client();
    multiTenant(http, HOST, 260);
    const tenants = await c.listResources("tenant", ACCOUNT);
    expect(tenants).toHaveLength(200);
    expect(tenantReads(http)).toBe(200);
    const unread = parts.flatMap((p) => p.parentResourceIds ?? []);
    expect(unread).toHaveLength(60);
    const read = new Set(tenants.map((t) => t.parentResourceId));
    for (const id of unread) {
      expect(id).toMatch(new RegExp(`^${ACCOUNT}:collection:${HOST}/Mt\\d{4}$`));
      expect(read.has(id)).toBe(false);
    }
  });

  it("reads them all in one poll when they fit", async () => {
    const parts = trackUnread();
    const { http, c } = client();
    multiTenant(http, HOST, 60);
    expect(await c.listResources("tenant", ACCOUNT)).toHaveLength(60);
    expect(parts).toEqual([]);
  });

  it.each([
    ["an empty body", respond(200, "", true)],
    ["an error object", { error: [{ message: "nope" }] }],
    ["an empty object", {}],
  ])("fails on %s rather than reading no tenants", async (_, answer) => {
    const { http, c } = client();
    http.route("GET", `${HOST}/v1/schema`, {
      classes: [{ class: "Mt", multiTenancyConfig: { enabled: true } }],
    });
    http.route("GET", `${HOST}/v1/schema/Mt/tenants`, answer);
    await expect(c.listResources("tenant", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("still reads tenants keyed by name", async () => {
    const { http, c } = client();
    http.route("GET", `${HOST}/v1/schema`, {
      classes: [{ class: "Mt", multiTenancyConfig: { enabled: true } }],
    });
    http.route("GET", `${HOST}/v1/schema/Mt/tenants`, { a: { name: "a" }, b: { name: "b" } });
    const tenants = await c.listResources("tenant", ACCOUNT);
    expect(tenants.map((t) => t.displayName)).toEqual(["a", "b"]);
  });
});

describe("a cluster that cannot be read", () => {
  function twoClusters() {
    const { http, c } = client({ clusters: `https://${OTHER} other-key` });
    http.route("GET", `${HOST}/v1/schema`, { classes: [{ class: "Article" }] });
    http.route("GET", `${OTHER}/v1/schema`, respond(401, { error: [{ message: "bad key" }] }));
    return { http, c };
  }

  it("keeps the refused cluster's rows where the host tracks them", async () => {
    const parts = trackUnread();
    const { c } = twoClusters();
    const collections = await c.listResources("collection", ACCOUNT);
    expect(collections.map((x) => x.externalId)).toEqual([`${HOST}/Article`]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:cluster:${OTHER}`] }]);
  });

  it("fails where nobody keeps the rows, rather than reading them as none", async () => {
    const { c } = twoClusters();
    await expect(c.listResources("collection", ACCOUNT)).rejects.toThrow("bad key");
  });

  it("keeps the rows of a Weaviate Cloud cluster that is not READY", async () => {
    const parts = trackUnread();
    const http = fakeHttp();
    http.route("POST", "auth.weaviate.cloud/oauth2/v1/apps/token", {
      access_token: "access-1",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });
    http.route("GET", "api-cloud.weaviate.cloud/v1/clusters", {
      data: [{ id: "c-o", name: "o", status: "UPDATING", endpoint: `https://${OTHER}` }],
      metadata: {},
    });
    http.secrets.set(`${ACCOUNT}:cluster:${OTHER}/apiKey`, "stored-key");
    const c = hostClient(
      new WeaviateClient({ cloudToken: "refresh-1" }, RESOURCE_TYPES, http.services),
    );
    expect(await c.listResources("collection", ACCOUNT)).toEqual([]);
    expect(parts).toEqual([{ parentResourceIds: [`${ACCOUNT}:cluster:${OTHER}`] }]);
    expect(http.calls.some((x) => x.url.host === OTHER)).toBe(false);
  });
});

describe("Weaviate Cloud's cluster list", () => {
  function signedIn(answer: unknown) {
    const http = fakeHttp();
    http.route("POST", "auth.weaviate.cloud/oauth2/v1/apps/token", {
      access_token: "access-1",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });
    http.route("GET", "api-cloud.weaviate.cloud/v1/regions", { data: [], metadata: {} });
    http.route("GET", "api-cloud.weaviate.cloud/v1/clusters", answer);
    return hostClient(
      new WeaviateClient({ cloudToken: "refresh-1" }, RESOURCE_TYPES, http.services),
    );
  }

  it.each([
    ["an empty body", respond(200, "", true)],
    ["no envelope", { metadata: {} }],
  ])("fails on %s rather than reading no clusters", async (_, answer) => {
    await expect(signedIn(answer).listResources("cluster", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads a bare array of clusters too", async () => {
    const clusters = await signedIn([
      {
        id: "c-a",
        name: "a",
        status: "READY",
        endpoint: "https://aaa.c0.europe-west3.gcp.weaviate.cloud",
      },
    ]).listResources("cluster", ACCOUNT);
    expect(clusters.map((x) => x.displayName)).toEqual(["a"]);
  });

  it("reads null data as no clusters", async () => {
    expect(await signedIn({ data: null, metadata: {} }).listResources("cluster", ACCOUNT)).toEqual(
      [],
    );
  });
});

describe("child lists of a cluster", () => {
  const cases: Array<[string, string, unknown]> = [
    ["collection", "/v1/schema", { classes: [] }],
    ["alias", "/v1/aliases", { aliases: [] }],
    ["db-user", "/v1/users/db", []],
    ["role", "/v1/authz/roles", []],
    ["backup", "/v1/backups/gcs", []],
  ];

  function cluster(type: string, path: string, answer: unknown) {
    const { http, c } = client();
    if (type === "backup") http.route("GET", `${HOST}/v1/meta`, { modules: { "backup-gcs": {} } });
    http.route("GET", `${HOST}${path}`, answer);
    return c;
  }

  it.each(cases)("fails %s on an empty body rather than reading none", async (type, path) => {
    const c = cluster(type, path, respond(200, "", true));
    await expect(c.listResources(type, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each(cases)("fails %s on an error object rather than reading none", async (type, path) => {
    const c = cluster(type, path, { error: [{ message: "proxy" }], items: "x" });
    const read = c.listResources(type, ACCOUNT);
    if (type === "collection" || type === "alias") await expect(read).resolves.toEqual([]);
    else await expect(read).rejects.toThrow("is not a list");
  });

  it.each(cases)("reads %s's empty answer as none", async (type, path, empty) => {
    expect(await cluster(type, path, empty).listResources(type, ACCOUNT)).toEqual([]);
  });

  it.each([
    ["collection", "/v1/schema"],
    ["alias", "/v1/aliases"],
  ])("reads %s's key left out as none, as go-swagger leaves an empty list", async (type, path) => {
    expect(await cluster(type, path, {}).listResources(type, ACCOUNT)).toEqual([]);
  });

  it.each([
    ["collection", "/v1/schema", { classes: "nope" }],
    ["alias", "/v1/aliases", { aliases: { a: 1 } }],
  ])("fails %s when its key is not a list", async (type, path, answer) => {
    await expect(cluster(type, path, answer).listResources(type, ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });
});
