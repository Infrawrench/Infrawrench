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
