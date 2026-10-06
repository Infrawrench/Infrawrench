import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { NorthflankClient, parseEnvLines } from "../client.js";
import { addonConnection, mapService, serviceState } from "../mappers.js";
import { metricBlocksToSeries } from "../metrics.js";
import { parseStatusFeed } from "../status-feed.js";
import { plugin } from "../plugin.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function mockFetch(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ method: string; url: URL; headers: Record<string, string>; body: unknown }> =
    [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const handler = routes[`${method} ${url.pathname}`];
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ error: { status: 404, message: `no route ${url.pathname}` } }),
        {
          status: 404,
        },
      );
    }
    const value = typeof handler === "function" ? (handler as Handler)(url, init) : handler;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ACC = "acc1";

describe("NorthflankClient HTTP", () => {
  it("sends the bearer token and follows cursor pagination", async () => {
    const calls = mockFetch({
      "GET /v1/projects": (url: URL) =>
        url.searchParams.get("cursor")
          ? {
              data: { projects: [{ id: "p2", uid: "u2", name: "Two" }] },
              pagination: { hasNextPage: false, count: 1 },
            }
          : {
              data: { projects: [{ id: "p1", uid: "u1", name: "One" }] },
              pagination: { hasNextPage: true, cursor: "c1", count: 1 },
            },
      "GET /v1/projects/p1": {
        data: { id: "p1", name: "One", deployment: { region: "europe-west" }, services: [{}] },
      },
      "GET /v1/projects/p2": {
        data: { id: "p2", name: "Two", deployment: { region: "us-central" } },
      },
    });
    const client = new NorthflankClient({ apiToken: "tok" });
    const projects = await client.listResources("nf-project", ACC);
    expect(projects.map((p) => p.externalId)).toEqual(["p1", "p2"]);
    expect(projects[0]!.fields["region"]).toBe("europe-west");
    expect(projects[0]!.fields["serviceCount"]).toBe(1);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("c1");
  });

  it("prefixes team-scoped paths for organisation tokens but not /v1/auth", async () => {
    const calls = mockFetch({
      "GET /v1/auth": { data: { entityId: "acme", entityType: "org", name: "ci" } },
      "GET /v1/teams/platform/domains": {
        data: { domains: [] },
        pagination: { hasNextPage: false },
      },
    });
    const client = new NorthflankClient({ apiToken: "tok", teamId: "platform" });
    const [account] = await client.listResources("nf-account", ACC);
    expect(account!.fields["teamId"]).toBe("platform");
    await client.listResources("nf-domain", ACC);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/auth", "/v1/teams/platform/domains"]);
  });

  it("maps API errors to a status-carrying error with Northflank's message", async () => {
    mockFetch({
      "GET /v1/projects": new Response(
        JSON.stringify({ error: { status: 403, message: "Forbidden" } }),
        { status: 403 },
      ),
    });
    const client = new NorthflankClient({ apiToken: "tok" });
    const err = await client.listResources("nf-project", ACC).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(String((err as Error).message)).toMatch(/Forbidden.*API role/);
  });

  it("merges runtime variables instead of replacing them", async () => {
    const calls = mockFetch({
      "GET /v1/projects/p1/services/api/runtime-environment": {
        data: { runtimeEnvironment: { A: "1", B: "2" } },
      },
      "POST /v1/projects/p1/services/api/runtime-environment": { data: {} },
    });
    const client = new NorthflankClient({ apiToken: "tok" });
    await client.executeNoSqlCommand("nf-service", `${ACC}:nf-service:p1/api`, ACC, "set-env", [
      JSON.stringify({ variables: "B=3\nC=x=y" }),
    ]);
    expect(calls[1]!.body).toEqual({ runtimeEnvironment: { A: "1", B: "3", C: "x=y" } });
  });

  it("resolves an addon's public connection string when public access is on", async () => {
    mockFetch({
      "GET /v1/projects/p1/addons/db": {
        data: {
          id: "db",
          spec: { type: "postgresql", config: { networking: { externalAccessEnabled: true } } },
        },
      },
      "GET /v1/projects/p1/addons/db/credentials": {
        data: {
          secrets: { username: "u", password: "pw" },
          envs: {
            POSTGRES_URI: "postgresql://u:pw@primary.db--abc.addon.code.run:5432/db",
            EXTERNAL_POSTGRES_URI: "postgresql://u:pw@primary.db--abc.addon.code.run:28000/db",
            JDBC_POSTGRES_URI: "jdbc:postgresql://x",
            HOST: "primary.db--abc.addon.code.run",
          },
        },
      },
    });
    const client = new NorthflankClient({ apiToken: "tok" });
    const uri = await client.resolveOutput(
      "nf-addon",
      `${ACC}:nf-addon:p1/db`,
      "connectionString",
      ACC,
    );
    expect(uri).toContain(":28000/");
    expect(await client.resolveOutput("nf-addon", `${ACC}:nf-addon:p1/db`, "password", ACC)).toBe(
      "pw",
    );
  });

  it("refuses a private addon's connection string with guidance", async () => {
    mockFetch({
      "GET /v1/projects/p1/addons/db": {
        data: { id: "db", spec: { type: "redis", config: { networking: {} } } },
      },
      "GET /v1/projects/p1/addons/db/credentials": { data: { secrets: {}, envs: {} } },
    });
    const client = new NorthflankClient({ apiToken: "tok" });
    await expect(
      client.resolveOutput("nf-addon", `${ACC}:nf-addon:p1/db`, "connectionString", ACC),
    ).rejects.toThrow(/public access/);
  });

  it("attributes daily PaaS spend to projects and keeps the remainder", async () => {
    const day = Date.UTC(2026, 8, 1) / 1000;
    mockFetch({
      "GET /v1/projects": {
        data: { projects: [{ id: "p1", uid: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "One" }] },
        pagination: { hasNextPage: false },
      },
      "GET /v1/projects/p1": { data: { id: "p1", uid: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "One" } },
      "GET /v1/billing/usage": (url: URL) =>
        url.searchParams.get("projectId")
          ? {
              data: {
                usage: [
                  { timestamp: day, currency: "usd", paas: { price: { cpu: 1.5, memory: 0.5 } } },
                ],
              },
              pagination: { hasNextPage: false },
            }
          : {
              data: {
                usage: [
                  {
                    timestamp: day,
                    currency: "usd",
                    paas: { price: { cpu: 2, memory: 0.5 } },
                    loadBalancer: { price: { total: 0.3 } },
                  },
                ],
              },
              pagination: { hasNextPage: false },
            },
    });
    const client = new NorthflankClient({ apiToken: "tok" });
    const rows = (await client.fetchCostData(ACC, {
      fromDate: "2026-09-01",
      toDate: "2026-09-01",
    })) as Array<{
      service?: string;
      resourceId?: string;
      amount: number;
      currency: string;
    }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "Compute (CPU)",
          resourceId: "p1",
          amount: 1.5,
          currency: "USD",
        }),
        expect.objectContaining({ service: "Compute (memory)", resourceId: "p1", amount: 0.5 }),
        expect.objectContaining({ service: "Load balancers", amount: 0.3 }),
      ]),
    );
    const unattributed = rows.filter((r) => !r.resourceId);
    expect(unattributed.find((r) => r.service === "Compute (CPU)")?.amount).toBe(0.5);
    expect(unattributed.find((r) => r.service === "Compute (memory)")).toBeUndefined();
    expect(rows.reduce((n, r) => n + r.amount, 0)).toBeCloseTo(2.8);
  });

  it("lists teams for an organisation token and nothing for a team token", async () => {
    mockFetch({
      "GET /v1/auth": { data: { entityType: "org", entityId: "acme" } },
      "GET /v1/teams": {
        data: { teams: [{ id: "platform", name: "Platform" }] },
        pagination: { hasNextPage: false },
      },
    });
    expect(await plugin.listCredentialOptions!("teamId", { apiToken: "t" })).toEqual([
      { id: "platform", label: "Platform" },
    ]);
    mockFetch({ "GET /v1/auth": { data: { entityType: "team", entityId: "me" } } });
    expect(await plugin.listCredentialOptions!("teamId", { apiToken: "t" })).toEqual([]);
  });
});

describe("mappers", () => {
  it("derives service state from instances and deployment status", () => {
    expect(serviceState({ serviceType: "deployment", deployment: { instances: 0 } })).toBe(
      "paused",
    );
    expect(
      serviceState({ serviceType: "combined", status: { deployment: { status: "FAILED" } } }),
    ).toBe("failed");
    expect(serviceState({ serviceType: "build" })).toBe("build");
    const r: ResourceInstance = mapService(ACC, "p1", {
      id: "web",
      name: "web",
      serviceType: "deployment",
      deployment: { instances: 2, external: { imagePath: "nginx:1" } },
      ports: [
        { name: "p01", public: true, dns: "p01--web--abc.code.run" },
        { name: "x", public: false },
      ],
    });
    expect(r.externalId).toBe("p1/web");
    expect(r.fields["publicUrls"]).toBe("https://p01--web--abc.code.run");
    expect(r.parentResourceId).toBe(`${ACC}:nf-project:p1`);
  });

  it("prefers the master URL for Redis and ignores JDBC strings", () => {
    const c = addonConnection(
      {
        envs: {
          REDIS_MASTER_URL: "rediss://m",
          REDIS_REPLICA_URL: "rediss://r",
          REDIS_CONNECT_COMMAND: "redis-cli",
        },
      },
      false,
    );
    expect(c.connectionString).toBe("rediss://m");
  });

  it("parses KEY=value lines", () => {
    expect(parseEnvLines('# c\nA=1\n\nB="two"\n')).toEqual({ A: "1", B: "two" });
    expect(() => parseEnvLines("nope")).toThrow(/KEY=value/);
  });
});

describe("metrics", () => {
  it("sums replicas, averages percentages", () => {
    const series = metricBlocksToSeries({
      memory: {
        metricInfo: { metricId: "memory", metricUnit: "mb" },
        values: [
          { data: [{ ts: "2026-10-01T00:00:00Z", value: 100 }] },
          { data: [{ ts: "2026-10-01T00:00:00Z", value: 50 }] },
        ],
      },
      cpu: {
        metricInfo: { metricId: "cpu", metricUnit: "pct" },
        values: [
          { data: [{ ts: "2026-10-01T00:00:00Z", value: 40 }] },
          { data: [{ ts: "2026-10-01T00:00:00Z", value: 20 }] },
        ],
      },
    });
    expect(series.find((s) => s.label === "Memory")?.points[0]?.value).toBe(150);
    expect(series.find((s) => s.label === "CPU")).toMatchObject({
      unit: "%",
      points: [{ value: 30 }],
    });
  });
});

describe("status feed", () => {
  // Trimmed from https://status.northflank.com/history.rss (2026-10).
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n  <channel>\n    <title>Northflank Status - Incident history</title>\n    <link>https://status.northflank.com</link>\n    <description>Northflank</description>\n    <pubDate>Fri, 25 Sep 2026 15:15:00 +0000</pubDate>\n    \n<item>\n  <title>Degraded SSO login via WorkOS</title>\n  <description>\n    Type: Incident\n    Duration: 46 minutes\n\n    Affected Components: Northflank App\n    Sep 25, 15:15:00 GMT+0 - Investigating - We are currently investigating this incident. Sep 25, 16:01:05 GMT+0 - Resolved - This incident has been resolved. \n  </description>\n  <content:encoded>\n    <![CDATA[<p><strong>Type:</strong> Incident</p>\n    <p><strong>Duration:</strong> 46 minutes</p>\n    <p><strong>Affected Components:</strong> </p>\n    &lt;p&gt;&lt;small&gt;Sep &lt;var data-var=&#039;date&#039;&gt; 25&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;15:15:00&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; -\n  We are currently investigating this incident..&lt;/p&gt;\n&lt;p&gt;&lt;small&gt;Sep &lt;var data-var=&#039;date&#039;&gt; 25&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;16:01:05&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; -\n  This incident has been resolved..&lt;/p&gt;\n]]>\n  </content:encoded>\n  <pubDate>Fri, 25 Sep 2026 15:15:00 +0000</pubDate>\n  <link>https://status.northflank.com/incident/cmuh4kc8h00s013pih51rz3uf</link>\n  <guid>https://status.northflank.com/incident/cmuh4kc8h00s013pih51rz3uf</guid>\n</item>\n<item>\n  <title>Addon expose/unexpose temporarily disabled in US - Central</title>\n  <description>\n    Type: Incident\n    Duration: 2 hours and 25 minutes\n\n    Affected Components: Addons\n    Sep 4, 18:27:54 GMT+0 - Monitoring - We have temporarily disabled addon expose/unexpose in our US - Central region. This is due to an ongoing incident with our cloud service provider.  \nWe will re-enable this feature once we confirm that it is safe to do so. Sep 4, 20:52:58 GMT+0 - Resolved - This incident has been resolved. \n  </description>\n  <content:encoded>\n    <![CDATA[<p><strong>Type:</strong> Incident</p>\n    <p><strong>Duration:</strong> 2 hours and 25 minutes</p>\n    <p><strong>Affected Components:</strong> </p>\n    &lt;p&gt;&lt;small&gt;Sep &lt;var data-var=&#039;date&#039;&gt; 4&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;18:27:54&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Monitoring&lt;/strong&gt; -\n  We have temporarily disabled addon expose/unexpose in our US - Central region. This is due to an ongoing incident with our cloud service provider.  \nWe will re-enable this feature once we confirm that it is safe to do so..&lt;/p&gt;\n&lt;p&gt;&lt;small&gt;Sep &lt;var data-var=&#039;date&#039;&gt; 4&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;20:52:58&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; -\n  This incident has been resolved..&lt;/p&gt;\n]]>\n  </content:encoded>\n  <pubDate>Fri, 4 Sep 2026 18:27:54 +0000</pubDate>\n  <link>https://status.northflank.com/incident/cmtnae42b0e811no58822esum</link>\n  <guid>https://status.northflank.com/incident/cmtnae42b0e811no58822esum</guid>\n</item>\n<item>\n  <title>Workloads Failing to Start Across Multiple Regions</title>\n  <description>\n    Type: Incident\n    Duration: 1 hour and 1 minute\n\n    Affected Components: Addons, Jobs, Services\n    Aug 5, 13:27:13 GMT+0 - Investigating - We are seeing partial start up issues for workloads across multiple regions. \n\nWe are currently investigating this incident. Aug 5, 13:42:39 GMT+0 - Monitoring - We have identified the issue and applied a mitigation. Previously stuck workloads are now starting successfully across affected regions. We are monitoring recovery and will confirm once all workloads are fully operational. Aug 5, 14:27:54 GMT+0 - Resolved - All affected workloads are now fully operational.  \n  </description>\n  <content:encoded>\n    <![CDATA[<p><strong>Type:</strong> Incident</p>\n    <p><strong>Duration:</strong> 1 hour and 1 minute</p>\n    <p><strong>Affected Components:</strong> , , </p>\n    &lt;p&gt;&lt;small&gt;Aug &lt;var data-var=&#039;date&#039;&gt; 5&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;13:27:13&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; -\n  We are seeing partial start up issues for workloads across multiple regions. \n\nWe are currently investigating this incident..&lt;/p&gt;\n&lt;p&gt;&lt;small&gt;Aug &lt;var data-var=&#039;date&#039;&gt; 5&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;13:42:39&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Monitoring&lt;/strong&gt; -\n  We have identified the issue and applied a mitigation. Previously stuck workloads are now starting successfully across affected regions. We are monitoring recovery and will confirm once all workloads are fully operational..&lt;/p&gt;\n&lt;p&gt;&lt;small&gt;Aug &lt;var data-var=&#039;date&#039;&gt; 5&lt;/var&gt;, &lt;var data-var=&#039;time&#039;&gt;14:27:54&lt;/var&gt; GMT+0&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Resolved&lt;/strong&gt; -\n  All affected workloads are now fully operational. .&lt;/p&gt;\n]]>\n  </content:encoded>\n  <pubDate>Wed, 5 Aug 2026 13:27:13 +0000</pubDate>\n  <link>https://status.northflank.com/incident/cmsg4fvtt034m1ao3nowjoker</link>\n  <guid>https://status.northflank.com/incident/cmsg4fvtt034m1ao3nowjoker</guid>\n</item>\n</channel>\n</rss>\n\n';

  it("parses Instatus RSS items with their last state and components", () => {
    const all = parseStatusFeed(body, Date.parse("2026-09-05T00:00:00Z"));
    const addon = all.find((i) => /Addon expose/.test(i.title));
    expect(addon).toMatchObject({
      state: "resolved",
      resolvedAt: "2026-09-04T20:52:58.000Z",
      services: ["Addons"],
      resourceTypes: ["nf-addon"],
    });
    expect(addon?.providerWide).toBe(false);
  });

  it("drops incidents resolved long ago", () => {
    expect(parseStatusFeed(body, Date.parse("2027-01-01T00:00:00Z"))).toEqual([]);
  });

  it("rejects a non-RSS body", () => {
    expect(() => parseStatusFeed("<html></html>")).toThrow();
  });
});
