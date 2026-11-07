import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { AlgoliaApiError, keyFingerprint } from "../api.js";
import { AlgoliaClient, parseAcl, settingsPatch, usageSeries } from "../client.js";
import { mapApiKey, mapCrawler, mapIndex } from "../mappers.js";
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
  const c = hostClient(
    new AlgoliaClient(
      { appId: "TESTAPP", apiKey: "admin", ...extra },
      RESOURCE_TYPES,
      http.services,
    ),
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

describe("documented field names", () => {
  it("reads an index's A/B test from `id`, and still from `abTestId`", () => {
    const test = { id: 42, variants: [] };
    expect(mapIndex({ name: "prod", abTest: test }, undefined, ACCOUNT).fields["abTest"]).toBe(
      "42",
    );
    expect(
      mapIndex({ name: "prod", abTest: { abTestId: 7 } }, undefined, ACCOUNT).fields["abTest"],
    ).toBe("7");
    expect(mapIndex({ name: "prod" }, undefined, ACCOUNT).fields["abTest"]).toBe("");
  });

  it("reads a crawler's last start from `lastReindexStartAt`, and still from the spelling read before", () => {
    const at = "2026-10-01T10:00:00.000Z";
    expect(
      mapCrawler("c1", { lastReindexStartAt: at }, ACCOUNT).fields["lastReindexStartedAt"],
    ).toBe(at);
    expect(
      mapCrawler("c1", { lastReindexStartedAt: at }, ACCOUNT).fields["lastReindexStartedAt"],
    ).toBe(at);
    expect(mapCrawler("c1", {}, ACCOUNT).fields["lastReindexStartedAt"]).toBe("");
  });
});

describe("lists that cannot say they are complete", () => {
  const CRAWLERS = "crawler.algolia.com/api/1/crawlers";
  const ABTESTS = "analytics.algolia.com/2/abtests";
  const INDEXES = `${READ}/1/indexes`;
  const crawlerCreds = { crawlerUserId: "user", crawlerApiKey: "key" };
  const on = (http: ReturnType<typeof fakeHttp>, path: string) =>
    http.calls.filter((call) => `${call.url.host}${call.url.pathname}` === path);
  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `c${from + i}` }));
  const tests = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ abTestID: from + i, name: `t${from + i}` }));

  it("throws at the index page cap with more to read", async () => {
    const { http, c } = client();
    http.route("GET", INDEXES, { items: [{ name: "a" }], nbPages: 1000 });
    await expect(c.listResources("index", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(on(http, INDEXES)).toHaveLength(50);
  });

  it("refuses an index page with its key renamed, first or later", async () => {
    const first = client();
    first.http.route("GET", INDEXES, { indices: [{ name: "a" }], nbPages: 1 });
    await expect(first.c.listResources("index", ACCOUNT)).rejects.toThrow("is not a list");

    const later = client();
    later.http.route("GET", INDEXES, (call: { url: URL }) =>
      call.url.searchParams.get("page") === "1"
        ? { indices: [{ name: "b" }], nbPages: 2 }
        : { items: [{ name: "a" }], nbPages: 2 },
    );
    await expect(later.c.listResources("index", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("keeps reading indices when a full page does not say how many pages there are", async () => {
    const { http, c } = client();
    const full = Array.from({ length: 1000 }, (_, i) => ({ name: `i${i}` }));
    http.route("GET", INDEXES, (call: { url: URL }) =>
      call.url.searchParams.get("page") === "1" ? { items: [{ name: "last" }] } : { items: full },
    );
    const list = await c.listResources("index", ACCOUNT);
    expect(list).toHaveLength(1001);
    expect(on(http, INDEXES)).toHaveLength(2);
  });

  it("reads an empty application as no indices", async () => {
    const { http, c } = client();
    http.route("GET", INDEXES, { items: [], nbPages: 0 });
    await expect(c.listResources("index", ACCOUNT)).resolves.toEqual([]);
    expect(on(http, INDEXES)).toHaveLength(1);
  });

  it("refuses a key list with its key renamed, through the application's catch too", async () => {
    const { http, c } = client();
    http.route("GET", INDEXES, { items: [], nbPages: 0 });
    http.route("GET", `${READ}/1/keys`, { message: "try again" });
    await expect(c.listResources("api-key", ACCOUNT)).rejects.toThrow("is not a list");
    await expect(c.listResources("application", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("still counts no keys when the application's key cannot list them", async () => {
    const { http, c } = client();
    http.route("GET", INDEXES, { items: [], nbPages: 0 });
    http.route("GET", `${READ}/1/keys`, respond(403, { message: "Method not allowed" }));
    const [app] = await c.listResources("application", ACCOUNT);
    expect(app!.fields["apiKeyCount"]).toBe(0);
  });

  it("walks A/B tests by offset until the reported total", async () => {
    const { http, c } = client();
    http.route("GET", ABTESTS, (call: { url: URL }) => {
      const offset = Number(call.url.searchParams.get("offset") ?? 0);
      return { abtests: tests(offset === 0 ? 100 : 20, offset), count: 100, total: 120 };
    });
    const list = await c.listResources("ab-test", ACCOUNT);
    expect(list).toHaveLength(120);
    expect(list[119]!.externalId).toBe("119");
    expect(on(http, ABTESTS).map((call) => call.url.searchParams.get("offset"))).toEqual([
      "0",
      "100",
    ]);
    expect(on(http, ABTESTS)[0]!.url.searchParams.get("limit")).toBe("100");
  });

  it("reads null A/B tests as none, as the document says", async () => {
    const { http, c } = client();
    http.route("GET", ABTESTS, { abtests: null, count: 0, total: 0 });
    await expect(c.listResources("ab-test", ACCOUNT)).resolves.toEqual([]);
  });

  it("throws at the A/B test cap with more to read", async () => {
    const { http, c } = client();
    http.route("GET", ABTESTS, () => ({ abtests: tests(100), count: 100, total: 1_000_000 }));
    await expect(c.listResources("ab-test", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(on(http, ABTESTS)).toHaveLength(100);
  });

  it("refuses an A/B test page with its key renamed, first or later", async () => {
    const first = client();
    first.http.route("GET", ABTESTS, { tests: [], count: 0, total: 0 });
    await expect(first.c.listResources("ab-test", ACCOUNT)).rejects.toThrow("is not a list");

    const later = client();
    later.http.route("GET", ABTESTS, (call: { url: URL }) =>
      call.url.searchParams.get("offset") === "100"
        ? { tests: [], count: 0, total: 120 }
        : { abtests: tests(100), count: 100, total: 120 },
    );
    await expect(later.c.listResources("ab-test", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads A/B testing being unavailable as none, but only on the first page", async () => {
    const first = client();
    first.http.route("GET", ABTESTS, respond(403, { message: "Not on this plan" }));
    await expect(first.c.listResources("ab-test", ACCOUNT)).resolves.toEqual([]);

    const later = client();
    later.http.route("GET", ABTESTS, (call: { url: URL }) =>
      call.url.searchParams.get("offset") === "100"
        ? respond(403, { message: "Not on this plan" })
        : { abtests: tests(100), count: 100, total: 120 },
    );
    await expect(later.c.listResources("ab-test", ACCOUNT)).rejects.toThrow("Not on this plan");
  });

  it("walks crawlers by page until the reported total", async () => {
    const { http, c } = client(crawlerCreds);
    http.route("GET", CRAWLERS, (call: { url: URL }) =>
      call.url.searchParams.get("page") === "2"
        ? { items: rows(5, 100), total: 105, page: 2, itemsPerPage: 100 }
        : { items: rows(100), total: 105, page: 1, itemsPerPage: 100 },
    );
    const list = await c.listResources("crawler", ACCOUNT);
    expect(list.map((r) => r.externalId)).toContain("c104");
    expect(list).toHaveLength(105);
    const reads = on(http, CRAWLERS);
    expect(reads.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(reads[0]!.url.searchParams.get("itemsPerPage")).toBe("100");
    expect(reads[0]!.url.searchParams.get("appID")).toBe("TESTAPP");
  });

  it("ends crawlers on a short page when no total is reported", async () => {
    const { http, c } = client(crawlerCreds);
    http.route("GET", CRAWLERS, { items: rows(3) });
    await expect(c.listResources("crawler", ACCOUNT)).resolves.toHaveLength(3);
    expect(on(http, CRAWLERS)).toHaveLength(1);
  });

  it("reads a crawler answer with no items and a total of 0 as none", async () => {
    const { http, c } = client(crawlerCreds);
    http.route("GET", CRAWLERS, { total: 0, page: 1, itemsPerPage: 100 });
    await expect(c.listResources("crawler", ACCOUNT)).resolves.toEqual([]);
  });

  it("throws at the crawler page cap, the document's last page, with more to read", async () => {
    const { http, c } = client(crawlerCreds);
    http.route("GET", CRAWLERS, () => ({ items: rows(100), total: 1_000_000 }));
    await expect(c.listResources("crawler", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(on(http, CRAWLERS)).toHaveLength(100);
  });

  it("refuses a crawler page with its key renamed, first or later", async () => {
    const first = client(crawlerCreds);
    first.http.route("GET", CRAWLERS, { crawlers: rows(1), total: 1 });
    await expect(first.c.listResources("crawler", ACCOUNT)).rejects.toThrow("is not a list");

    const later = client(crawlerCreds);
    later.http.route("GET", CRAWLERS, (call: { url: URL }) =>
      call.url.searchParams.get("page") === "2"
        ? { crawlers: rows(1), total: 105 }
        : { items: rows(100), total: 105 },
    );
    await expect(later.c.listResources("crawler", ACCOUNT)).rejects.toThrow("is not a list");
  });
});
