import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { ElasticCloudClient, sourcesToRules, thresholdsToAlerts } from "../client.js";
import { chartToSeries } from "../metrics.js";
import { parseStatusFeed, regionIdsForComponent } from "../status-feed.js";
import { makeHttp, type Reply } from "./helpers.js";

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
  return { c: new ElasticCloudClient({ apiKey: "k" }, services), calls };
}

describe("ElasticCloudClient listing", () => {
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
