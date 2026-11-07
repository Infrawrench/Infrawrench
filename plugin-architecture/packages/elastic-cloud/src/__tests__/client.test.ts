import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { ElasticCloudClient, sourcesToRules, thresholdsToAlerts } from "../client.js";
import { chartToSeries } from "../metrics.js";
import { parseStatusFeed, regionIdsForComponent } from "../status-feed.js";
import { makeHttp, type Recorded, type Reply } from "./helpers.js";

const DEPLOYMENT = {
  id: "dep1",
  name: "search-prod",
  alias: "search-prod",
  healthy: true,
  resources: {
    elasticsearch: [
      {
        ref_id: "main-elasticsearch",
        id: "es1",
        region: "gcp-europe-west1",
        info: {
          status: "started",
          healthy: true,
          metadata: {
            service_url: "https://es1.example.cloud.es.io",
            aliased_url: "https://search-prod.es.example.cloud.es.io",
            cloud_id: "search-prod:abc",
          },
          topology: {
            instances: [
              {
                instance_name: "instance-0000000001",
                zone: "europe-west1-b",
                healthy: true,
                memory: { instance_capacity: 8192, memory_pressure: 64 },
                disk: { disk_space_used: 1024, disk_space_available: 4096 },
              },
            ],
          },
          plan_info: {
            healthy: true,
            current: {
              plan: {
                elasticsearch: { version: "9.1.3" },
                deployment_template: { id: "gcp-storage-optimized" },
                cluster_topology: [
                  { id: "hot_content", zone_count: 2, size: { value: 8192, resource: "memory" } },
                  { id: "ml", zone_count: 1, size: { value: 0, resource: "memory" } },
                ],
              },
            },
          },
        },
      },
    ],
    kibana: [
      {
        ref_id: "main-kibana",
        id: "kb1",
        region: "gcp-europe-west1",
        info: { metadata: { aliased_url: "https://search-prod.kb.example.cloud.es.io" } },
      },
    ],
  },
  settings: { traffic_filter_settings: { rulesets: ["rs1"] } },
  metadata: { tags: [{ key: "env", value: "prod" }] },
};

function client(
  route: (url: URL, method: string, body: unknown) => Reply,
  secrets?: Map<string, string>,
) {
  const { http, calls } = makeHttp(route);
  const services: HostServices = {
    http,
    ...(secrets
      ? {
          secrets: {
            getPlaintext: async (id: string, key: string) => secrets.get(`${id}/${key}`) ?? null,
            setPlaintext: async (id: string, key: string, value: string) => {
              secrets.set(`${id}/${key}`, value);
            },
          },
        }
      : {}),
  };
  return { c: hostClient(new ElasticCloudClient({ apiKey: "k" }, services)), calls };
}

describe("ElasticCloudClient listing", () => {
  describe("an answer without its list", () => {
    const orgs = { organizations: [{ id: "org1", name: "Acme" }] };

    it.each([
      ["deployment", "/api/v1/deployments", { items: [{ id: "dep1" }] }],
      ["traffic-filter", "/api/v1/deployments/traffic-filter/rulesets", { items: [{ id: "r" }] }],
      ["extension", "/api/v1/deployments/extensions", { items: [{ id: "e" }] }],
      ["organization", "/api/v1/organizations", { orgs: [{ id: "org1" }] }],
      ["project", "/api/v1/serverless/projects/security", { projects: [{ id: "p" }] }],
    ])("fails a %s list rather than read it as empty", async (typeId, path, body) => {
      const { c } = client((url) => (url.pathname === path ? { body } : { body: { items: [] } }));
      await expect(c.listResources(typeId, "acct")).rejects.toThrow("is not a list");
    });

    it.each([
      ["organization", "/api/v1/organizations", { organizations: [{ id: "org1" }] }],
      ["project", "/api/v1/serverless/projects/security", { items: [{ id: "p" }] }],
    ])("fails a %s list that says it has another page", async (typeId, path, body) => {
      const { c, calls } = client((url) =>
        url.pathname === path ? { body: { ...body, next_page: "t1" } } : { body: { items: [] } },
      );
      await expect(c.listResources(typeId, "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      // The first page, then the token in a header and in the query, neither moving it.
      expect(calls.filter((x) => x.url.pathname === path)).toHaveLength(3);
    });

    it.each([
      ["organization", "/api/v1/organizations", { organizations: [{ id: "org1" }] }],
      ["project", "/api/v1/serverless/projects/security", { items: [{ id: "p" }] }],
    ])("keeps a %s list whose next_page is empty", async (typeId, path, body) => {
      for (const next_page of [null, ""]) {
        const { c } = client((url) =>
          url.pathname === path ? { body: { ...body, next_page } } : { body: { items: [] } },
        );
        await expect(c.listResources(typeId, "acct")).resolves.toHaveLength(1);
      }
    });

    it("does not read a project list with another page as none while labelling budgets", async () => {
      const { c } = client((url) => {
        if (url.pathname === "/api/v1/serverless/projects/vectordb") {
          return { body: { items: [{ id: "p" }], next_page: "t1" } };
        }
        if (url.pathname === "/api/v1/organizations") return { body: orgs };
        if (url.pathname.endsWith("/budgets")) return { body: [] };
        if (url.pathname === "/api/v1/deployments") return { body: { deployments: [] } };
        return { body: { items: [] } };
      });
      await expect(c.listResources("budget", "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it("fails a budget list that is not an array", async () => {
      const { c } = client((url) => {
        if (url.pathname === "/api/v1/organizations") return { body: orgs };
        if (url.pathname.endsWith("/budgets")) return { body: { budgets: [{ id: 7 }] } };
        if (url.pathname === "/api/v1/deployments") return { body: { deployments: [] } };
        return { body: { items: [] } };
      });
      await expect(c.listResources("budget", "acct")).rejects.toThrow("is not a list");
    });

    it.each([
      ["deployments", "/api/v1/deployments", { items: [] }],
      ["projects", "/api/v1/serverless/projects/vectordb", { projects: [] }],
    ])("does not swallow unreadable %s while labelling budgets", async (_name, path, body) => {
      const { c } = client((url) => {
        if (url.pathname === path) return { body };
        if (url.pathname === "/api/v1/organizations") return { body: orgs };
        if (url.pathname.endsWith("/budgets")) return { body: [] };
        if (url.pathname === "/api/v1/deployments") return { body: { deployments: [] } };
        return { body: { items: [] } };
      });
      await expect(c.listResources("budget", "acct")).rejects.toThrow("is not a list");
    });

    it("still lists nothing for an empty account", async () => {
      const { c } = client((url) => {
        if (url.pathname === "/api/v1/organizations") return { body: orgs };
        if (url.pathname.endsWith("/budgets")) return { body: [] };
        if (url.pathname === "/api/v1/deployments") return { body: { deployments: [] } };
        if (url.pathname.endsWith("/rulesets")) return { body: { rulesets: [] } };
        if (url.pathname.endsWith("/extensions")) return { body: { extensions: [] } };
        return { body: { items: [] } };
      });
      for (const typeId of ["deployment", "project", "traffic-filter", "extension", "budget"]) {
        await expect(c.listResources(typeId, "acct")).resolves.toEqual([]);
      }
    });
  });

  describe("serverless traffic filters", () => {
    const PATH = "/api/v1/serverless/traffic-filters";
    const filter = (id: string) => ({
      id,
      name: id,
      type: "ip",
      region: "aws-us-east-1",
      include_by_default: false,
      rules: [{ source: "203.0.113.0/24" }],
    });

    it("sends each next_page back in X-Elastic-Next-Page until it is absent", async () => {
      const replies: Record<string, Reply> = {
        "": { body: { items: [filter("f1")], next_page: "t1" } },
        // The document: a token does not promise the next page has anything on it.
        t1: { body: { items: [], next_page: "t2" } },
        t2: { body: { items: [filter("f2")], next_page: null } },
      };
      const token = () => calls.at(-1)?.headers["X-Elastic-Next-Page"] ?? "";
      const { c, calls } = client(() => replies[token()] ?? { status: 500 });
      const rows = await c.listResources("serverless-traffic-filter", "acct");
      expect(rows.map((r) => r.externalId)).toEqual(["f1", "f2"]);
      expect(calls.map((x) => x.headers["X-Elastic-Next-Page"])).toEqual([undefined, "t1", "t2"]);
      expect(new Set(calls.map((x) => x.url.pathname))).toEqual(new Set([PATH]));
    });

    it("throws at the page cap rather than return part of the list", async () => {
      const { c, calls } = client(() => ({
        body: { items: [filter("f1")], next_page: "again" },
      }));
      await expect(c.listResources("serverless-traffic-filter", "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(calls).toHaveLength(50);
    });

    it("throws on a renamed list, on the first page and on a later one", async () => {
      const first = client(() => ({ body: { filters: [filter("f1")] } }));
      await expect(first.c.listResources("serverless-traffic-filter", "acct")).rejects.toThrow(
        "is not a list",
      );
      expect(first.calls).toHaveLength(1);

      const later = client(() => ({
        body:
          later.calls.length === 1
            ? { items: [filter("f1")], next_page: "t1" }
            : { filters: [filter("f2")] },
      }));
      await expect(later.c.listResources("serverless-traffic-filter", "acct")).rejects.toThrow(
        "is not a list",
      );
      expect(later.calls).toHaveLength(2);
    });

    it("lists nothing when the key cannot read filters, but only on the first page", async () => {
      const denied = client(() => ({ status: 403, body: { errors: [] } }));
      await expect(denied.c.listResources("serverless-traffic-filter", "acct")).resolves.toEqual(
        [],
      );

      const midway = client(() =>
        midway.calls.length === 1
          ? { body: { items: [filter("f1")], next_page: "t1" } }
          : { status: 403, body: { errors: [] } },
      );
      await expect(midway.c.listResources("serverless-traffic-filter", "acct")).rejects.toThrow(
        "403",
      );
      expect(midway.calls).toHaveLength(2);
    });
  });

  describe("a list whose document gives next_page no way back", () => {
    const LISTS = [
      ["organization", "/api/v1/organizations", "organizations"],
      ["project", "/api/v1/serverless/projects/security", "items"],
    ] as const;
    const row = (id: string) => ({ id, name: id, type: "security", region_id: "r" });
    const idsOf = (rows: Array<{ displayName: string }>) => rows.map((r) => r.displayName);

    /** Answers `page(token, request)` on `path`, and an empty list on anything else. */
    function paged(path: string, key: string, page: (token: string, request: Recorded) => Reply) {
      const seen = client((url) => {
        if (url.pathname !== path) return { body: { items: [] } };
        const request = seen.calls.at(-1);
        if (!request) throw new Error("A reply with no request");
        const token =
          request.headers["X-Elastic-Next-Page"] ?? request.url.searchParams.get("next_page") ?? "";
        const reply = page(token, request);
        if (!reply.body || typeof reply.body !== "object" || !("rows" in reply.body)) return reply;
        const { rows, ...rest } = reply.body;
        return { ...reply, body: { [key]: rows, ...rest } };
      });
      return { ...seen, ofPath: () => seen.calls.filter((x) => x.url.pathname === path) };
    }

    it.each(LISTS)("reads a %s list on through a header token", async (typeId, path, key) => {
      const replies: Record<string, Reply> = {
        "": { body: { rows: [row("a")], next_page: "t1" } },
        t1: { body: { rows: [row("b")], next_page: "t2" } },
        t2: { body: { rows: [row("c")] } },
      };
      const { c, ofPath } = paged(path, key, (token) => replies[token] ?? { status: 500 });
      expect(idsOf(await c.listResources(typeId, "acct"))).toEqual(["a", "b", "c"]);
      expect(ofPath().map((x) => x.headers["X-Elastic-Next-Page"])).toEqual([
        undefined,
        "t1",
        "t2",
      ]);
      expect(ofPath().every((x) => !x.url.searchParams.has("next_page"))).toBe(true);
    });

    it.each(LISTS)("falls back to the query when %s ignores the header", async (typeId, p, key) => {
      const { c, ofPath } = paged(p, key, (_, request) => {
        const query = request.url.searchParams.get("next_page");
        if (query === "t1") return { body: { rows: [row("b")], next_page: "t2" } };
        if (query === "t2") return { body: { rows: [row("c")] } };
        return { body: { rows: [row("a")], next_page: "t1" } };
      });
      expect(idsOf(await c.listResources(typeId, "acct"))).toEqual(["a", "b", "c"]);
      // Once the query is known to work the header is not tried again.
      expect(ofPath().map((x) => x.headers["X-Elastic-Next-Page"])).toEqual([
        undefined,
        "t1",
        undefined,
        undefined,
      ]);
      expect(ofPath().map((x) => x.url.searchParams.get("next_page"))).toEqual([
        null,
        null,
        "t1",
        "t2",
      ]);
    });

    it.each(LISTS)("falls back to the query when %s refuses the header", async (typeId, p, key) => {
      const { c, ofPath } = paged(p, key, (_, request) => {
        if (request.headers["X-Elastic-Next-Page"]) return { status: 400, body: { errors: [] } };
        if (request.url.searchParams.get("next_page")) return { body: { rows: [row("b")] } };
        return { body: { rows: [row("a")], next_page: "t1" } };
      });
      expect(idsOf(await c.listResources(typeId, "acct"))).toEqual(["a", "b"]);
      expect(ofPath()).toHaveLength(3);
    });

    it.each(LISTS)("takes a token on the last page of a %s list", async (typeId, path, key) => {
      const { c, ofPath } = paged(path, key, (token) =>
        token === "t1" ? { body: { rows: [] } } : { body: { rows: [row("a")], next_page: "t1" } },
      );
      expect(idsOf(await c.listResources(typeId, "acct"))).toEqual(["a"]);
      expect(ofPath()).toHaveLength(2);
    });

    it.each(LISTS)("keeps one copy of a %s row that comes twice", async (typeId, path, key) => {
      const replies: Record<string, Reply> = {
        "": { body: { rows: [row("a"), row("b")], next_page: "t1" } },
        t1: { body: { rows: [row("b"), row("c")] } },
      };
      const { c } = paged(path, key, (token) => replies[token] ?? { status: 500 });
      expect(idsOf(await c.listResources(typeId, "acct"))).toEqual(["a", "b", "c"]);
    });

    it.each(LISTS)("fails a %s list that stalls once it has moved", async (typeId, path, key) => {
      const replies: Record<string, Reply> = {
        "": { body: { rows: [row("a")], next_page: "t1" } },
        t1: { body: { rows: [row("b")], next_page: "t2" } },
        t2: { body: { rows: [row("b")], next_page: "t3" } },
      };
      const { c, ofPath } = paged(path, key, (token) => replies[token] ?? { status: 500 });
      await expect(c.listResources(typeId, "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      // The header worked, so the query is not tried when it stops working.
      expect(ofPath()).toHaveLength(3);
    });

    it.each(LISTS)("throws at the page cap on a %s list", async (typeId, path, key) => {
      const { c, ofPath } = paged(path, key, (token) => {
        const n = token ? Number(token) : 0;
        return { body: { rows: [row(`r${n}`)], next_page: String(n + 1) } };
      });
      await expect(c.listResources(typeId, "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      expect(ofPath()).toHaveLength(1000);
    });

    it.each(LISTS)("fails a %s list renamed on a later page", async (typeId, path, key) => {
      const { c } = paged(path, key, (token) =>
        token ? { body: { renamed: [row("b")] } } : { body: { rows: [row("a")], next_page: "t1" } },
      );
      await expect(c.listResources(typeId, "acct")).rejects.toThrow("is not a list");
    });

    it.each(LISTS)("does not read a refused %s page as none", async (typeId, path, key) => {
      const { c } = paged(path, key, (token) =>
        token
          ? { status: 403, body: { errors: [] } }
          : { body: { rows: [row("a")], next_page: "t1" } },
      );
      await expect(c.listResources(typeId, "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it("does not read a refused organization page as no budgets", async () => {
      const { c } = paged("/api/v1/organizations", "organizations", (token) =>
        token
          ? { status: 404, body: { errors: [] } }
          : { body: { rows: [{ id: "org1" }], next_page: "t1" } },
      );
      await expect(c.listResources("budget", "acct")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
    });

    it.each(LISTS)("keeps the status of a %s page that failed outright", async (typeId, p, key) => {
      for (const status of [401, 429, 503]) {
        const { c, ofPath } = paged(p, key, (token) =>
          token ? { status, body: {} } : { body: { rows: [row("a")], next_page: "t1" } },
        );
        await expect(c.listResources(typeId, "acct")).rejects.toThrow(String(status));
        expect(ofPath()).toHaveLength(2);
      }
    });

    it("still reads a 403 on the first page of a project list as none", async () => {
      const { c } = client(() => ({ status: 403, body: { errors: [] } }));
      await expect(c.listResources("project", "acct")).resolves.toEqual([]);
    });
  });

  it("lists hosted deployments with version, region, size, health and endpoints", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/api/v1/deployments") {
        return { body: { deployments: [{ id: "dep1", name: "search-prod", resources: [] }] } };
      }
      if (url.pathname === "/api/v1/deployments/dep1") {
        expect(url.searchParams.get("show_plans")).toBe("true");
        return { body: DEPLOYMENT };
      }
      return { status: 404 };
    });
    const [d] = await c.listResources("deployment", "acct");
    expect(d!.id).toBe("acct:deployment:dep1");
    expect(d!.fields).toMatchObject({
      name: "search-prod",
      version: "9.1.3",
      region: "gcp-europe-west1",
      status: "started",
      healthy: true,
      hotSizeGb: 8,
      hotZones: "2",
      totalMemoryGb: 16,
      tags: "env:prod",
      trafficFilterIds: "rs1",
      esEndpoint: "https://search-prod.es.example.cloud.es.io",
      kibanaUrl: "https://search-prod.kb.example.cloud.es.io",
    });
    expect(d!.resolvedOutputs["cloudId"]).toBe("search-prod:abc");
  });

  it("lists projects of every type and skips types the key cannot read", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/api/v1/serverless/projects/elasticsearch") {
        return {
          body: {
            items: [
              {
                id: "p1",
                name: "search",
                region_id: "aws-us-east-1",
                type: "elasticsearch",
                search_lake: { search_power: 100 },
                endpoints: { elasticsearch: "https://es", kibana: "https://kb" },
                metadata: { created_at: "2026-01-01", tags: { team: "core" } },
              },
            ],
          },
        };
      }
      if (url.pathname === "/api/v1/serverless/projects/security") return { status: 403 };
      return { body: { items: [] } };
    });
    const rows = await c.listResources("project", "acct");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalId).toBe("elasticsearch/p1");
    expect(rows[0]!.fields).toMatchObject({
      projectType: "Elasticsearch",
      region: "aws-us-east-1",
      searchPower: 100,
      tags: "team:core",
    });
  });

  it("lists budgets per organization on the billing host", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/api/v1/organizations") {
        return { body: { organizations: [{ id: "org1", name: "Acme" }] } };
      }
      if (url.pathname === "/api/v1/billing/organization/org1/budgets") {
        return {
          body: [
            {
              id: 7,
              amount: 500,
              period: "monthly",
              active: true,
              scope_type: "cloud_resource",
              scope_values: ["dep1"],
              recipient_group: [],
              alerts: [
                { id: 1, operator: "gte", threshold: 80, threshold_type: "percentage" },
                { id: 2, operator: "gte", threshold: 50, threshold_type: "percentage" },
              ],
            },
          ],
        };
      }
      if (url.pathname === "/api/v1/deployments") {
        return { body: { deployments: [{ id: "dep1", name: "search-prod" }] } };
      }
      return { body: { items: [] } };
    });
    const [b] = await c.listResources("budget", "acct");
    expect(b!.externalId).toBe("org1/7");
    expect(b!.displayName).toBe("Budget for search-prod");
    expect(b!.fields).toMatchObject({ amount: 500, alertThresholds: "50, 80", scopeIds: "dep1" });
    expect(calls.find((x) => x.url.pathname.endsWith("/budgets"))!.url.host).toBe(
      "billing.elastic-cloud.com",
    );
  });
});

describe("ElasticCloudClient updates and actions", () => {
  it("resizes the hot tier through the tiers endpoint, and rejects an unoffered size", async () => {
    const patches: unknown[] = [];
    const { c } = client((url, method, body) => {
      if (url.pathname === "/api/v1/deployments/dep1") return { body: DEPLOYMENT };
      if (url.pathname.endsWith("/tiers") && method === "GET") {
        return {
          body: {
            hot_content: { memory_size: 8192, zone_count: 2, available_sizes: [4096, 8192, 16384] },
          },
        };
      }
      if (url.pathname.endsWith("/tiers") && method === "PATCH") {
        patches.push(body);
        return { status: 202, body: { id: "dep1", name: "x", resources: [] } };
      }
      return { body: { rulesets: [] } };
    });
    await expect(
      c.updateResource("deployment", "acct:deployment:dep1", "acct", { hotSizeGb: "12" }),
    ).rejects.toThrow(/4, 8, 16/);
    await c.updateResource("deployment", "acct:deployment:dep1", "acct", { hotSizeGb: "16" });
    expect(patches).toEqual([{ hot_content: { memory_size: 16384 } }]);
  });

  it("renames without pruning resources", async () => {
    let put: unknown;
    const { c } = client((url, method, body) => {
      if (url.pathname === "/api/v1/deployments/dep1" && method === "PUT") {
        put = body;
        return { body: { id: "dep1", name: "renamed", resources: [] } };
      }
      if (url.pathname === "/api/v1/deployments/dep1") return { body: DEPLOYMENT };
      return { body: {} };
    });
    await c.updateResource("deployment", "acct:deployment:dep1", "acct", { name: "renamed" });
    expect(put).toEqual({ name: "renamed", prune_orphans: false });
  });

  it("restarts Elasticsearch on its ref id and applies a traffic filter", async () => {
    const { c, calls } = client((url) =>
      url.pathname === "/api/v1/deployments/dep1" ? { body: DEPLOYMENT } : { body: {} },
    );
    await c.invokeAction("deployment", "acct:deployment:dep1", "restart-elasticsearch", "acct");
    await c.invokeAction("deployment", "acct:deployment:dep1", "attach-filter:rs2", "acct");
    const posts = calls.filter((x) => x.method === "POST");
    expect(posts[0]!.url.pathname).toBe(
      "/api/v1/deployments/dep1/elasticsearch/main-elasticsearch/_restart",
    );
    expect(posts[1]!.url.pathname).toBe(
      "/api/v1/deployments/traffic-filter/rulesets/rs2/associations",
    );
    expect(posts[1]!.body).toEqual({ entity_type: "deployment", id: "dep1" });
  });

  it("stores reset project credentials as the password output", async () => {
    const secrets = new Map<string, string>();
    const { c } = client(() => ({ body: { username: "admin", password: "s3cret" } }), secrets);
    const rid = "acct:project:elasticsearch/p1";
    await c.invokeAction("project", rid, "reset-credentials", "acct");
    expect(await c.resolveOutput("project", rid, "password", "acct")).toBe("s3cret");
  });

  it("creates an IP traffic filter and associates the picked deployments", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/api/v1/deployments/traffic-filter/rulesets" && method === "POST") {
        return { status: 201, body: { id: "rs9" } };
      }
      if (url.pathname === "/api/v1/deployments/traffic-filter/rulesets/rs9") {
        return {
          body: {
            id: "rs9",
            name: "office",
            type: "ip",
            region: "aws-us-east-1",
            include_by_default: false,
            rules: [{ source: "1.2.3.4/32" }],
          },
        };
      }
      return { body: {} };
    });
    const r = await c.createResource("traffic-filter", "acct", {
      name: "office",
      region: "aws-us-east-1",
      sources: "1.2.3.4/32",
      deploymentIds: JSON.stringify(["dep1"]),
    });
    expect(r.fields["sources"]).toBe("1.2.3.4/32");
    const create = calls.find((x) => x.method === "POST" && x.url.pathname.endsWith("/rulesets"));
    expect(create!.body).toMatchObject({
      type: "ip",
      region: "aws-us-east-1",
      rules: [{ source: "1.2.3.4/32" }],
    });
    expect(calls.some((x) => x.url.pathname.endsWith("/rs9/associations"))).toBe(true);
  });
});

describe("pure helpers", () => {
  it("parses alert thresholds and keeps rule descriptions", () => {
    expect(thresholdsToAlerts("50, 80%, x, 100")).toEqual([
      { operator: "gte", threshold: 50, threshold_type: "percentage" },
      { operator: "gte", threshold: 80, threshold_type: "percentage" },
      { operator: "gte", threshold: 100, threshold_type: "percentage" },
    ]);
    expect(sourcesToRules(["a", "b"], [{ id: "1", source: "a", description: "office" }])).toEqual([
      { source: "a", description: "office" },
      { source: "b" },
    ]);
  });

  it("folds chart values into ordered series", () => {
    const series = chartToSeries({
      data: [
        {
          timestamp: 1_759_000_000,
          values: [
            { name: "a", value: 1 },
            { name: "b", value: 4 },
          ],
        },
        { timestamp: 1_759_086_400, values: [{ name: "a", value: 2 }] },
      ],
    });
    expect(series.map((s) => s.label)).toEqual(["b", "a"]);
    expect(series[1]!.points).toEqual([
      { timestamp: 1_759_000_000_000, value: 1 },
      { timestamp: 1_759_086_400_000, value: 2 },
    ]);
  });

  it("maps status components to region ids", () => {
    expect(regionIdsForComponent("AWS EC2 Health: us-east-1")).toEqual([
      "aws-us-east-1",
      "us-east-1",
    ]);
    expect(regionIdsForComponent("Elasticsearch connectivity: GCP us-east4")).toEqual([
      "gcp-us-east4",
    ]);
    expect(regionIdsForComponent("Kibana connectivity: Azure azure-centralindia")).toEqual([
      "azure-centralindia",
    ]);
    expect(regionIdsForComponent("Cloud console")).toEqual([]);
  });

  it("parses the Statuspage feed", () => {
    const incidents = parseStatusFeed(
      JSON.stringify({
        page: { id: "x", name: "Elastic Cloud (Public)", url: "https://status.elastic.co" },
        incidents: [
          {
            id: "i1",
            name: "Elevated latency",
            status: "investigating",
            impact: "minor",
            created_at: "2026-10-04T10:00:00Z",
            shortlink: "https://stspg.io/x",
            components: [{ name: "Elasticsearch connectivity: GCP us-east4" }],
            incident_updates: [],
          },
        ],
      }),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.regions).toContain("gcp-us-east4");
  });
});
