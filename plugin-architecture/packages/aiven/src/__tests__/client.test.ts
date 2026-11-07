import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AivenClient, metricsPeriod, parseTags } from "../client.js";
import { chargeTypeOf, spreadLine } from "../cost-data.js";
import { chartsToSeries, parseChartTime, serviceConnectionString } from "../mappers.js";
import { parseStatusFeed } from "../status-feed.js";
import { aivenTerraformExport } from "../terraform.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function mockFetch(routes: Record<string, unknown | Handler>) {
  const calls: Array<{ method: string; url: URL; headers: Record<string, string>; body: unknown }> =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({
        method,
        url,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const handler = routes[`${method} ${url.pathname.replace(/^\/v1/, "")}`];
      if (handler === undefined) {
        return new Response(
          JSON.stringify({ errors: [{ message: "Not found", status: 404 }], message: "Not found" }),
          { status: 404 },
        );
      }
      const value = typeof handler === "function" ? (handler as Handler)(url, init) : handler;
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ACC = "acc";
const pg = {
  service_name: "pg-main",
  service_type: "pg",
  plan: "startup-4",
  cloud_name: "google-europe-west1",
  state: "RUNNING",
  node_count: 1,
  disk_space_mb: 81920,
  termination_protection: false,
  maintenance: { dow: "sunday", time: "03:00:00", updates: [{ description: "OS update" }] },
  service_uri: "postgres://avnadmin:pw@pg-main-p.aivencloud.com:12691/defaultdb?sslmode=require",
  service_uri_params: {
    host: "pg-main-p.aivencloud.com",
    port: "12691",
    user: "avnadmin",
    password: "pw",
    dbname: "defaultdb",
  },
  user_config: { pg_version: "17" },
  users: [{ username: "avnadmin", type: "primary", password: "pw" }],
  databases: ["defaultdb", "app"],
  connection_pools: [
    { pool_name: "app-pool", database: "app", pool_mode: "transaction", pool_size: 10 },
  ],
  service_integrations: [
    {
      service_integration_id: "i1",
      integration_type: "metrics",
      source_service: "pg-main",
      dest_service: "m3",
    },
  ],
};

describe("AivenClient", () => {
  it("sends the aivenv1 token and maps services with their children", async () => {
    const calls = mockFetch({
      "GET /project": {
        projects: [{ project_name: "acme", default_cloud: "google-europe-west1" }],
      },
      "GET /project/acme/service": { services: [pg] },
    });
    const c = hostClient(new AivenClient({ apiToken: "tok" }));
    const [svc] = await c.listResources("aiven-service", ACC);
    expect(calls[0]!.headers["Authorization"]).toBe("aivenv1 tok");
    expect(svc!.externalId).toBe("acme/pg-main");
    expect(svc!.fields).toMatchObject({
      version: "17",
      pendingMaintenance: 1,
      host: "pg-main-p.aivencloud.com",
      port: 12691,
    });
    expect((await c.listResources("aiven-database", ACC)).map((d) => d.externalId)).toEqual([
      "acme/pg-main/defaultdb",
      "acme/pg-main/app",
    ]);
    expect((await c.listResources("aiven-connection-pool", ACC))[0]!.fields["poolMode"]).toBe(
      "transaction",
    );
    expect((await c.listResources("aiven-integration", ACC))[0]!.externalId).toBe("acme/i1");
  });

  it("maps Aiven's error body and keeps the status", async () => {
    mockFetch({
      "GET /project": new Response(
        JSON.stringify({
          errors: [{ message: "Invalid token", status: 401 }],
          message: "Invalid token",
        }),
        { status: 401 },
      ),
    });
    const err = await hostClient(new AivenClient({ apiToken: "x" }))
      .listResources("aiven-project", ACC)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(401);
    expect(String((err as Error).message)).toMatch(/Invalid token/);
  });

  it("powers a service off with PUT powered=false", async () => {
    const calls = mockFetch({ "PUT /project/acme/service/pg-main": { service: pg } });
    await hostClient(new AivenClient({ apiToken: "t" })).invokeAction(
      "aiven-service",
      `${ACC}:aiven-service:acme/pg-main`,
      "power-off",
      ACC,
    );
    expect(calls[0]!.body).toEqual({ powered: false });
  });

  it("resolves the URI and the project CA", async () => {
    mockFetch({
      "GET /project/acme/service/pg-main": (url: URL) => {
        expect(url.searchParams.get("include_secrets")).toBe("true");
        return { service: pg };
      },
      "GET /project/acme/kms/ca": {
        certificate: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----",
      },
    });
    const c = hostClient(new AivenClient({ apiToken: "t" }));
    const id = `${ACC}:aiven-service:acme/pg-main`;
    expect(await c.resolveOutput("aiven-service", id, "connectionString", ACC)).toContain(
      "sslmode=require",
    );
    expect(await c.resolveOutput("aiven-service", id, "caCertificate", ACC)).toContain(
      "BEGIN CERTIFICATE",
    );
  });

  it("creates a Kafka topic with retention in ms", async () => {
    const calls = mockFetch({ "POST /project/acme/service/kafka-1/topic": {} });
    await hostClient(new AivenClient({ apiToken: "t" })).createResource("aiven-kafka-topic", ACC, {
      service: "acme/kafka-1",
      name: "orders",
      partitions: "6",
      replication: "3",
      retentionHours: "24",
    });
    expect(calls[0]!.body).toMatchObject({
      topic_name: "orders",
      partitions: 6,
      config: { retention_ms: 86_400_000 },
    });
  });
});

describe("Kafka topic partitions", () => {
  it("counts the partition list the detail route documents", async () => {
    mockFetch({
      "GET /project/acme/service/k1/topic/orders": {
        topic: {
          topic_name: "orders",
          replication: 3,
          partitions: [{ partition: 0 }, { partition: 1 }, { partition: 2 }],
        },
      },
    });
    const topic = await hostClient(new AivenClient({ apiToken: "x" })).getResource(
      "aiven-kafka-topic",
      `${ACC}:aiven-kafka-topic:acme/k1/orders`,
      ACC,
    );
    expect(topic.fields["partitions"]).toBe(3);
  });

  it("keeps the integer the list route documents", async () => {
    mockFetch({
      "GET /project": { projects: [{ project_name: "acme" }] },
      "GET /project/acme/service": {
        services: [{ service_name: "k1", service_type: "kafka", state: "RUNNING" }],
      },
      "GET /project/acme/service/k1/topic": {
        topics: [{ topic_name: "orders", partitions: 6, replication: 3 }],
      },
    });
    const [topic] = await hostClient(new AivenClient({ apiToken: "x" })).listResources(
      "aiven-kafka-topic",
      ACC,
    );
    expect(topic!.fields["partitions"]).toBe(6);
  });
});

describe("VPC peering count", () => {
  const routes = {
    "GET /project": { projects: [{ project_name: "acme" }] },
    "GET /project/acme/vpcs": {
      vpcs: [
        {
          project_vpc_id: "v1",
          cloud_name: "aws-eu-west-1",
          network_cidr: "10.0.0.0/24",
          state: "ACTIVE",
        },
      ],
    },
    "GET /project/acme/vpcs/v1": {
      project_vpc_id: "v1",
      cloud_name: "aws-eu-west-1",
      network_cidr: "10.0.0.0/24",
      state: "ACTIVE",
      peering_connections: [
        { peer_cloud_account: "111", peer_vpc: "vpc-a", state: "ACTIVE" },
        { peer_cloud_account: "222", peer_vpc: "vpc-b", state: "PENDING_PEER" },
      ],
    },
  };

  it("reads the count from the detail route, which is the only one that has it", async () => {
    mockFetch(routes);
    const [vpc] = await hostClient(new AivenClient({ apiToken: "x" })).listResources(
      "aiven-vpc",
      ACC,
    );
    expect(vpc!.fields["peerings"]).toBe(2);
    expect(vpc!.externalId).toBe("acme/v1");
  });

  it("reads each VPC once when both the VPCs and their peerings are listed", async () => {
    const calls = mockFetch(routes);
    const c = hostClient(new AivenClient({ apiToken: "x" }));
    await c.listResources("aiven-vpc", ACC);
    const peerings = await c.listResources("aiven-vpc-peering", ACC);
    expect(peerings).toHaveLength(2);
    expect(calls.filter((x) => x.url.pathname.endsWith("/vpcs/v1"))).toHaveLength(1);
  });

  it("drops a VPC deleted between the list and its read", async () => {
    const { "GET /project/acme/vpcs/v1": _gone, ...rest } = routes;
    mockFetch(rest);
    await expect(
      hostClient(new AivenClient({ apiToken: "x" })).listResources("aiven-vpc", ACC),
    ).resolves.toEqual([]);
  });

  it("fails the list when a VPC cannot be read, so stored rows are kept", async () => {
    const failure = () =>
      new Response(JSON.stringify({ message: "boom" }), {
        status: 500,
      });
    mockFetch({ ...routes, "GET /project/acme/vpcs/v1": failure });
    const c = hostClient(new AivenClient({ apiToken: "x" }));
    await expect(c.listResources("aiven-vpc", ACC)).rejects.toThrow(/500/);
    await expect(c.listResources("aiven-vpc-peering", ACC)).rejects.toThrow(/500/);
  });
});

describe("integration type picker", () => {
  const options = async () => {
    const config = await hostClient(new AivenClient({ apiToken: "x" })).getCreateConfig(
      "aiven-integration",
      `${ACC}:aiven-project:acme`,
    );
    const field = config.fields.find((f) => f.key === "integrationType");
    return field?.options ?? [];
  };

  const project = {
    "GET /project": { projects: [{ project_name: "acme" }] },
    "GET /project/acme/service": { services: [] },
  };

  it("offers what the project's integration types say connect two services", async () => {
    const calls = mockFetch({
      ...project,
      "GET /project/acme/integration_types": {
        integration_types: [
          {
            integration_type: "opensearch_cross_cluster_search",
            source_description: "Source OpenSearch",
            dest_description: "Remote OpenSearch",
            source_service_types: ["opensearch"],
            dest_service_types: ["opensearch"],
          },
          // Goes to an external endpoint, which this form has no field for.
          {
            integration_type: "external_google_cloud_logging",
            source_service_types: ["pg"],
            dest_service_types: [],
          },
        ],
      },
    });
    const offered = await options();
    expect(offered.map((o) => o.id)).toEqual(["opensearch_cross_cluster_search"]);
    expect(offered[0]!.description).toBe("Source OpenSearch to Remote OpenSearch");
    expect(calls.some((c) => c.url.pathname === "/v1/project/acme/integration_types")).toBe(true);
  });

  it("falls back to a fixed list without the type the API does not accept", async () => {
    mockFetch(project);
    const ids = (await options()).map((o) => o.id);
    expect(ids).toContain("metrics");
    expect(ids).not.toContain("m3aggregator");
  });
});

describe("Kafka connection string", () => {
  it("uses the SASL endpoint and inlines the CA", () => {
    const uri = serviceConnectionString(
      {
        service_type: "kafka",
        components: [
          {
            component: "kafka",
            host: "k.aivencloud.com",
            port: 100,
            kafka_authentication_method: "certificate",
          },
          {
            component: "kafka",
            host: "k.aivencloud.com",
            port: 200,
            kafka_authentication_method: "sasl",
          },
        ],
        users: [{ username: "avnadmin", type: "primary", password: "p w" }],
      },
      "PEM",
    );
    const u = new URL(uri);
    expect(u.host).toBe("k.aivencloud.com:200");
    expect(u.searchParams.get("sasl")).toBe("scram-sha-256");
    expect(u.searchParams.get("password")).toBe("p w");
    expect(atob(u.searchParams.get("ssl_ca") ?? "")).toBe("PEM");
  });

  it("is empty when only client certificates are enabled", () => {
    expect(
      serviceConnectionString(
        {
          service_type: "kafka",
          components: [{ component: "kafka", kafka_authentication_method: "certificate" }],
        },
        "PEM",
      ),
    ).toBe("");
  });
});

describe("metrics", () => {
  it("averages percentages and sums the rest across nodes, in both row shapes", () => {
    const series = chartsToSeries({
      cpu_usage: {
        data: {
          cols: [{ label: "time" }, { label: "n1" }, { label: "n2" }],
          rows: [["2026-10-01T00:00:00Z", 40, 20]],
        },
        hints: { title: "CPU usage %" },
      },
      net_receive: {
        data: {
          cols: [{ label: "time" }, { label: "n1" }, { label: "n2" }],
          rows: [{ c: [{ v: "Date(2026,9,1,0,0,0)" }, { v: 5 }, { v: 7 }] }],
        },
        hints: { title: "Network receive (bytes/s)" },
      },
    });
    expect(series.find((s) => s.label === "CPU usage %")).toMatchObject({
      unit: "%",
      points: [{ value: 30 }],
    });
    expect(series.find((s) => /receive/.test(s.label))?.points[0]).toEqual({
      timestamp: Date.UTC(2026, 9, 1),
      value: 12,
    });
  });

  it("parses chart times and picks periods", () => {
    expect(parseChartTime("Date(2026,0,2)")).toBe(Date.UTC(2026, 0, 2));
    expect(metricsPeriod(3_600_000)).toBe("hour");
    expect(metricsPeriod(3 * 86_400_000)).toBe("week");
  });
});

describe("costs", () => {
  it("spreads a line over the days it covers and keeps the range", () => {
    const rows = spreadLine(
      {
        line_total_usd: "30",
        line_type: "service_charge",
        project_name: "acme",
        service_name: "pg-main",
        service_type: "pg",
        cloud_name: "google-europe-west1",
        timestamp_begin: "2026-09-01T00:00:00Z",
        timestamp_end: "2026-09-04T00:00:00Z",
      },
      { period_begin: "2026-09-01T00:00:00Z", period_end: "2026-10-01T00:00:00Z" },
      { fromDate: "2026-09-02", toDate: "2026-09-30" },
      Date.parse("2026-10-06T00:00:00Z"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-09-02",
      amount: 10,
      service: "PostgreSQL",
      resourceId: "acme/pg-main",
      region: "google-europe-west1",
      chargeType: "usage",
    });
  });

  it("does not spread the running estimate into the future", () => {
    const rows = spreadLine(
      { line_total_usd: "6" },
      { period_begin: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z" },
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      Date.parse("2026-10-03T12:00:00Z"),
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(rows.reduce((n, r) => n + r.amount, 0)).toBeCloseTo(6);
  });

  it("maps line types to charge types", () => {
    expect(chargeTypeOf("credit_consumption")).toBe("credit");
    expect(chargeTypeOf("support_charge")).toBe("support");
  });
});

describe("misc", () => {
  it("parses tags", () => {
    expect(parseTags("team=data, env=prod")).toEqual({ team: "data", env: "prod" });
    expect(() => parseTags("bad")).toThrow();
  });

  it("drops old resolved incidents and picks up cloud names", () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    const body = JSON.stringify({
      incidents: [
        {
          id: "a",
          name: "Degraded google-europe-west1",
          status: "investigating",
          created_at: "2026-10-05T00:00:00Z",
          incident_updates: [],
        },
        {
          id: "b",
          name: "Old",
          status: "resolved",
          created_at: "2026-09-01T00:00:00Z",
          resolved_at: "2026-09-02T00:00:00Z",
          incident_updates: [],
        },
      ],
    });
    const out = parseStatusFeed(body, now);
    expect(out.map((i) => i.externalId)).toEqual(["a"]);
    expect(out[0]!.regions).toEqual(["google-europe-west1"]);
    expect(out[0]!.providerWide).toBe(true);
  });

  it("exports a PostgreSQL service for Terraform", () => {
    const out = aivenTerraformExport.mapResource({
      id: "a:aiven-service:acme/pg-main",
      pluginId: "aiven",
      resourceTypeId: "aiven-service",
      accountId: "a",
      displayName: "pg-main",
      fields: {
        name: "pg-main",
        project: "acme",
        serviceType: "pg",
        plan: "startup-4",
        cloud: "google-europe-west1",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "acme/pg-main",
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("aiven_pg");
    expect(out?.resource.importId).toBe("acme/pg-main");
  });
});
