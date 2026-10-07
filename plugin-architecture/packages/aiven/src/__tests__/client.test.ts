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
    const c = new AivenClient({ apiToken: "tok" });
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
    const err = await new AivenClient({ apiToken: "x" })
      .listResources("aiven-project", ACC)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(401);
    expect(String((err as Error).message)).toMatch(/Invalid token/);
  });

  it("powers a service off with PUT powered=false", async () => {
    const calls = mockFetch({ "PUT /project/acme/service/pg-main": { service: pg } });
    await new AivenClient({ apiToken: "t" }).invokeAction(
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
    const c = new AivenClient({ apiToken: "t" });
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
    await new AivenClient({ apiToken: "t" }).createResource("aiven-kafka-topic", ACC, {
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
