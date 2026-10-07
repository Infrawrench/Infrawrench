import { describe, expect, it } from "vitest";
import { AlgoliaApiError, keyFingerprint } from "../api.js";
import { AlgoliaClient, parseAcl, settingsPatch, usageSeries } from "../client.js";
import { mapApiKey, mapIndex } from "../mappers.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { parseStatusFeed } from "../status-feed.js";
import { algoliaTerraformExport } from "../terraform.js";
import { fakeHttp, respond } from "./helpers.js";

const APP = "testapp";
const READ = `${APP}-dsn.algolia.net`;
const WRITE = `${APP}.algolia.net`;
const ACCOUNT = "acct";

function client(extra: Record<string, string> = {}) {
  const http = fakeHttp();
  const c = new AlgoliaClient(
    { appId: "TESTAPP", apiKey: "admin", ...extra },
    RESOURCE_TYPES,
    http.services,
  );
  return { http, c };
}

describe("transport", () => {
  it("lists indices across pages with app and key headers", async () => {
    const { http, c } = client();
    http.route("GET", `${READ}/1/indexes`, (call: { url: URL }) =>
      call.url.searchParams.get("page") === "1"
        ? { items: [{ name: "b", entries: 0 }], nbPages: 2 }
        : { items: [{ name: "a", entries: 5, replicas: ["a_price"] }], nbPages: 2 },
    );
    http.route("GET", `${READ}/1/indexes/a/settings`, {
      searchableAttributes: ["title", "body"],
      typoTolerance: "min",
      distinct: true,
    });
    const list = await c.listResources("index", ACCOUNT);
    expect(list.map((r) => r.externalId)).toEqual(["a", "b"]);
    expect(list[0]!.fields).toMatchObject({
      searchableAttributes: "title, body",
      typoTolerance: "min",
      distinct: 1,
    });
    expect(http.calls[0]!.headers["x-algolia-application-id"]).toBe("TESTAPP");
    expect(http.calls[0]!.headers["x-algolia-api-key"]).toBe("admin");
  });

  it("falls back to the next host on a 5xx and keeps 4xx status", async () => {
    const { http, c } = client();
    http.route("GET", `${READ}/1/indexes/x/settings`, respond(503, { message: "unavailable" }));
    http.route("GET", `${APP}-1.algolianet.com/1/indexes/x/settings`, { hitsPerPage: 5 });
    http.route("GET", `${READ}/1/indexes`, { items: [{ name: "x" }], nbPages: 1 });
    const idx = await c.getResource("index", `${ACCOUNT}:index:x`, ACCOUNT);
    expect(idx.fields["hitsPerPage"]).toBe(5);
    http.route(
      "GET",
      `${READ}/1/keys`,
      respond(403, { message: "Method not allowed with this API key", status: 403 }),
    );
    const err = await c.listResources("api-key", ACCOUNT).catch((e) => e);
    expect(err).toBeInstanceOf(AlgoliaApiError);
    expect((err as AlgoliaApiError).status).toBe(403);
    expect((err as Error).message).toContain("Method not allowed");
  });

  it("keeps key values out of resource ids but resolves them as outputs", async () => {
    const { http, c } = client();
    http.route("GET", `${READ}/1/keys`, {
      keys: [
        { value: "secretvalue1234", acl: ["search"], createdAt: 1_700_000_000_000, validity: 3600 },
      ],
    });
    const [key] = await c.listResources("api-key", ACCOUNT);
    expect(key!.id).not.toContain("secretvalue1234");
    expect(key!.externalId).toBe(keyFingerprint("secretvalue1234"));
    expect(key!.fields["expiresAt"]).toBe(new Date(1_700_000_000_000 + 3_600_000).toISOString());
    expect(await c.resolveOutput("api-key", key!.id, "apiKey", ACCOUNT)).toBe("secretvalue1234");
  });

  it("updates a key with the merged body on the write host", async () => {
    const { http, c } = client();
    http.route("GET", `${READ}/1/keys`, {
      keys: [{ value: "k1", acl: ["search"], description: "old", indexes: ["prod"] }],
    });
    http.route("PUT", `${WRITE}/1/keys/k1`, { key: "k1" });
    await c.updateResource("api-key", `${ACCOUNT}:api-key:${keyFingerprint("k1")}`, ACCOUNT, {
      acl: "search, browse",
    });
    const put = http.calls.find((x) => x.method === "PUT")!;
    expect(put.body).toEqual({ acl: ["search", "browse"], description: "old", indexes: ["prod"] });
  });

  it("reads usage only with a usage key", async () => {
    const { http, c } = client({ usageApiKey: "usage" });
    http.route(
      "GET",
      "usage.algolia.com/1/usage/total_search_operations,total_write_operations,records,data_size,avg_processing_time,90p_processing_time,99p_processing_time,max_qps,used_search_capacity,degraded_queries_max_capacity_queries_impacted",
      {
        total_search_operations: [{ t: 1000, v: 12 }],
        used_search_capacity: [{ t: 1000, v: { "c1-de-1": 20, "c1-de-2": 35 } }],
      },
    );
    const s = await c.fetchMetricSeries(
      "application",
      `${ACCOUNT}:application:application`,
      ACCOUNT,
      { startMs: 0, endMs: 3600_000 },
    );
    expect(s.map((x) => [x.label, x.points[0]!.value])).toEqual([
      ["Search Operations", 12],
      ["Search Capacity Used", 35],
    ]);
    const call = http.calls.find((x) => x.url.host === "usage.algolia.com")!;
    expect(call.headers["x-algolia-api-key"]).toBe("usage");
    expect(call.url.searchParams.get("granularity")).toBe("hourly");
  });

  it("copies and moves indices through the operation endpoint", async () => {
    const { http, c } = client();
    http.route("POST", `${WRITE}/1/indexes/prod/operation`, { taskID: 1 });
    await c.executeNoSqlCommand("index", `${ACCOUNT}:index:prod`, ACCOUNT, "copyIndex", [
      JSON.stringify({ destination: "prod_copy", scope: "settings,synonyms,rules" }),
    ]);
    expect(http.calls[0]!.body).toEqual({
      operation: "copy",
      destination: "prod_copy",
      scope: ["settings", "synonyms", "rules"],
    });
  });
});

describe("helpers", () => {
  it("builds a settings patch from edited fields", () => {
    expect(
      settingsPatch({
        searchableAttributes: "title, unordered(body)",
        typoTolerance: "false",
        hitsPerPage: "30",
        ignorePlurals: "true",
      }),
    ).toEqual({
      searchableAttributes: ["title", "unordered(body)"],
      typoTolerance: false,
      hitsPerPage: 30,
      ignorePlurals: true,
    });
  });

  it("validates ACLs", () => {
    expect(parseAcl('["search","browse"]')).toEqual(["search", "browse"]);
    expect(() => parseAcl("search, admin")).toThrow(/Unknown ACL admin/);
  });

  it("collapses per-server usage values", () => {
    expect(
      usageSeries({ x: [{ t: 1, v: { a: 1, b: 4 } }] }, { x: { label: "X", unit: "u" } })[0]!
        .points[0]!.value,
    ).toBe(4);
  });
});

describe("status feed", () => {
  it("groups non-operational runs per cluster", () => {
    const now = Date.UTC(2026, 9, 6);
    const body = JSON.stringify({
      incidents: {
        "c1-de": [
          { t: now - 3_600_000, v: { title: "Degraded search", status: "degraded_performance" } },
          { t: now - 1_800_000, v: { title: "Outage", status: "major_outage" } },
        ],
        "m81-usc": [
          { t: now - 7_200_000, v: { title: "Major issue", status: "major_outage" } },
          {
            t: now - 3_600_000,
            v: { title: "Everything operating normally.", status: "operational" },
          },
        ],
        "old-1": [
          { t: now - 10 * 86_400_000, v: { title: "Old", status: "partial_outage" } },
          { t: now - 9 * 86_400_000, v: { title: "Fine", status: "operational" } },
        ],
      },
    });
    const [active, resolved, ...rest] = parseStatusFeed(body, now);
    expect(active).toMatchObject({
      regions: ["c1-de"],
      state: "investigating",
      impact: "major",
      title: "Degraded search",
    });
    expect(resolved).toMatchObject({ regions: ["m81-usc"], state: "resolved" });
    expect(rest).toEqual([]);
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});

describe("terraform", () => {
  it("maps a primary index into settings blocks", () => {
    const idx = mapIndex(
      { name: "prod" },
      {
        searchableAttributes: ["title"],
        customRanking: ["desc(pop)"],
        hitsPerPage: 20,
        replicas: ["prod_price"],
      },
      ACCOUNT,
    );
    const out = algoliaTerraformExport.mapResource(idx)!;
    expect(out.resource.importId).toBe("prod");
    expect(out.resource.attributes["ranking"]).toEqual({
      kind: "block",
      attributes: {
        custom_ranking: { kind: "list", items: [{ kind: "string", value: "desc(pop)" }] },
      },
    });
    expect(Object.keys(out.resource.attributes)).toEqual([
      "name",
      "attributes",
      "ranking",
      "pagination",
      "advanced",
    ]);
    expect(
      algoliaTerraformExport.mapResource(
        mapIndex({ name: "r", primary: "prod" }, undefined, ACCOUNT),
      ),
    ).toBeNull();
  });

  it("exports an API key without its value", () => {
    const out = algoliaTerraformExport.mapResource(
      mapApiKey({ value: "zzz", acl: ["search"], description: "web" }, ACCOUNT),
    )!;
    expect(JSON.stringify(out)).not.toContain("zzz");
    expect(out.resource.importId).toBeUndefined();
  });
});
