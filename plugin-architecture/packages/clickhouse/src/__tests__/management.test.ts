import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clickhouse/client-web", () => ({
  createClient: () => ({
    query: async () => ({ json: async () => [] }),
    command: async () => undefined,
    close: async () => undefined,
  }),
}));

import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import { ClickHouseClient, ipAccessListPatch } from "../client.js";
import { parsePrometheusText, serviceMetricSeries } from "../prometheus.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct-1";
const ORG = "/v1/organizations/org-1";

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];

function respond(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
}

function route(routes: Array<[string, string, unknown]>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace("https://api.clickhouse.cloud", "");
    calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const [m, p, body] of routes) {
      if (m === method && path === p) return respond(body);
    }
    throw new Error(`unrouted: ${method} ${path}`);
  }) as typeof fetch);
}

function client() {
  return new ClickHouseClient({
    apiKeyId: "kid",
    apiKeySecret: "secret",
    organizationId: "org-1",
  });
}

const SERVICE = {
  id: "svc1",
  name: "prod",
  state: "running",
  provider: "aws",
  region: "us-east-1",
  numReplicas: 3,
  minReplicaMemoryGb: 16,
  maxReplicaMemoryGb: 32,
  autoscalingMode: "vertical",
  releaseChannel: "fast",
  dataWarehouseId: "wh1",
  ipAccessList: [{ source: "203.0.113.0/24" }, { source: "0.0.0.0/0" }],
  endpoints: [
    { protocol: "https", host: "svc1.clickhouse.cloud", port: 8443 },
    { protocol: "nativesecure", host: "svc1.clickhouse.cloud", port: 9440 },
    { protocol: "mysql", host: "svc1.mysql.clickhouse.cloud", port: 3306 },
  ],
};

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin registration", () => {
  it("registers the new resource types", () => {
    const ids = plugin.resourceTypes.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "ch-backup",
        "ch-clickpipe",
        "ch-postgres",
        "ch-api-key",
        "ch-member",
      ]),
    );
    expect(plugin.manifest.credits).toBeDefined();
    expect(plugin.manifest.quotas).toBeDefined();
  });
});

describe("ch-service listing", () => {
  it("maps release channel, autoscaling, IP access list and MySQL endpoint", async () => {
    route([["GET", `${ORG}/services`, { result: [SERVICE] }]]);
    const [svc] = await client().listResources("ch-service", ACCOUNT);
    expect(svc!.fields).toMatchObject({
      releaseChannel: "fast",
      autoscalingMode: "vertical",
      ipAccessList: "203.0.113.0/24, 0.0.0.0/0",
      openToInternet: true,
      dataWarehouseId: "wh1",
    });
    expect(svc!.resolvedOutputs["mysqlHost"]).toBe("svc1.mysql.clickhouse.cloud:3306");
  });
});

describe("ch-service update", () => {
  it("sends basic details and replica scaling to their own endpoints", async () => {
    route([
      ["GET", `${ORG}/services`, { result: [SERVICE] }],
      ["PATCH", `${ORG}/services/svc1`, { result: SERVICE }],
      ["PATCH", `${ORG}/services/svc1/replicaScaling`, { result: SERVICE }],
    ]);
    await client().updateResource("ch-service", "acct-1:ch-service:svc1", ACCOUNT, {
      name: "renamed",
      releaseChannel: "default",
      ipAccessList: "203.0.113.0/24, 198.51.100.7",
      numReplicas: "4",
      idleScaling: "false",
    });
    const basic = calls.find((c) => c.method === "PATCH" && c.url === `${ORG}/services/svc1`);
    expect(basic!.body).toEqual({
      name: "renamed",
      releaseChannel: "default",
      ipAccessList: { remove: [{ source: "0.0.0.0/0" }], add: [{ source: "198.51.100.7" }] },
    });
    const scaling = calls.find((c) => c.url.endsWith("/replicaScaling"));
    expect(scaling!.body).toEqual({ numReplicas: 4, idleScaling: false });
  });

  it("skips the scaling call when only the name changes", async () => {
    route([
      ["GET", `${ORG}/services`, { result: [SERVICE] }],
      ["PATCH", `${ORG}/services/svc1`, { result: SERVICE }],
    ]);
    await client().updateResource("ch-service", "acct-1:ch-service:svc1", ACCOUNT, { name: "x" });
    expect(calls.some((c) => c.url.endsWith("/replicaScaling"))).toBe(false);
  });
});

describe("ipAccessListPatch", () => {
  it("diffs comma or whitespace separated lists", () => {
    expect(ipAccessListPatch("a, b", "b c")).toEqual({
      remove: [{ source: "a" }],
      add: [{ source: "c" }],
    });
  });
});

describe("service detail extras", () => {
  it("enriches with the backup schedule and upgrade window and renders their actions", async () => {
    route([
      [
        "GET",
        `${ORG}/services/svc1/backupConfiguration`,
        {
          result: {
            backupPeriodInHours: 24,
            backupRetentionPeriodInHours: 48,
            backupStartTime: "03:00",
          },
        },
      ],
      [
        "GET",
        `${ORG}/services/svc1/upgradeWindow`,
        { result: { weekday: 2, startHourUtc: 6, duration: 6 } },
      ],
      ["GET", `${ORG}/services`, { result: [SERVICE] }],
    ]);
    const c = client();
    const [svc] = await c.listResources("ch-service", ACCOUNT);
    const enriched = await c.enrichDetail(svc!);
    const detail = c.renderDetail(enriched);
    const text = JSON.stringify(detail);
    expect(text).toContain("Daily at 03:00 UTC");
    expect(text).toContain("2 days");
    expect(text).toContain("Tuesday 06:00 UTC");
    const labels = (detail.headerActions ?? []).map((a) => a.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Backup schedule", "Upgrade window", "Clear upgrade window"]),
    );
  });

  it("saves the backup schedule and upgrade window", async () => {
    route([
      ["PATCH", `${ORG}/services/svc1/backupConfiguration`, { result: {} }],
      ["PUT", `${ORG}/services/svc1/upgradeWindow`, { result: {} }],
      ["DELETE", `${ORG}/services/svc1/upgradeWindow`, {}],
    ]);
    const c = client();
    await c.executeNoSqlCommand(
      "ch-service",
      "acct-1:ch-service:svc1",
      ACCOUNT,
      "set-backup-config",
      [JSON.stringify({ backupPeriodInHours: "12", backupStartTime: "", retentionDays: "7" })],
    );
    await c.executeNoSqlCommand(
      "ch-service",
      "acct-1:ch-service:svc1",
      ACCOUNT,
      "set-upgrade-window",
      [JSON.stringify({ weekday: "6", startHourUtc: "18" })],
    );
    await c.invokeAction("ch-service", "acct-1:ch-service:svc1", "clear-upgrade-window", ACCOUNT);
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["PATCH", { backupPeriodInHours: 12, backupRetentionPeriodInHours: 168 }],
      ["PUT", { weekday: 6, startHourUtc: 18 }],
      ["DELETE", undefined],
    ]);
  });

  it("rejects an upgrade window outside the allowed start hours", async () => {
    await expect(
      client().executeNoSqlCommand(
        "ch-service",
        "acct-1:ch-service:svc1",
        ACCOUNT,
        "set-upgrade-window",
        [JSON.stringify({ weekday: "1", startHourUtc: "3" })],
      ),
    ).rejects.toThrow(/00:00, 06:00, 12:00 or 18:00/);
  });
});

describe("ch-service metrics", () => {
  const PROM = [
    "# HELP ClickHouseMetrics_Query Number of executing queries",
    "# TYPE ClickHouseMetrics_Query gauge",
    'ClickHouseMetrics_Query{clickhouse_org="o",clickhouse_service="svc1",hostname="r0"} 2',
    'ClickHouseMetrics_Query{clickhouse_org="o",clickhouse_service="svc1",hostname="r1"} 3',
    'ClickHouseAsyncMetrics_TotalBytesOfMergeTreeTables{hostname="r0"} 2147483648',
    'ClickHouseAsyncMetrics_ReplicasMaxAbsoluteDelay{hostname="r0"} 4',
    'ClickHouseAsyncMetrics_ReplicasMaxAbsoluteDelay{hostname="r1"} 9',
    'Unrelated_metric{hostname="r0"} 1',
  ].join("\n");

  it("parses exposition text and sums across replicas", () => {
    expect(parsePrometheusText(PROM)).toHaveLength(6);
    const series = serviceMetricSeries(PROM, 1000);
    expect(series).toEqual([
      { label: "Running queries", points: [{ timestamp: 1000, value: 5 }] },
      { label: "MergeTree data size", unit: "GB", points: [{ timestamp: 1000, value: 2 }] },
      { label: "Max replica delay", unit: "s", points: [{ timestamp: 1000, value: 9 }] },
    ]);
  });

  it("scrapes the filtered Prometheus endpoint", async () => {
    route([["GET", `${ORG}/services/svc1/prometheus?filtered_metrics=true`, PROM]]);
    const series = await client().fetchMetricSeries(
      "ch-service",
      "acct-1:ch-service:svc1",
      ACCOUNT,
    );
    expect(series[0]!.label).toBe("Running queries");
  });
});

describe("backups and ClickPipes", () => {
  it("lists backups per service with the source service id", async () => {
    route([
      ["GET", `${ORG}/services`, { result: [SERVICE] }],
      [
        "GET",
        `${ORG}/services/svc1/backups`,
        {
          result: [
            {
              id: "b1",
              status: "done",
              serviceId: "svc1",
              startedAt: "2026-09-01T03:00:00Z",
              sizeInBytes: 1024,
              type: "full",
            },
          ],
        },
      ],
    ]);
    const [b] = await client().listResources("ch-backup", ACCOUNT);
    expect(b!.parentResourceId).toBe("acct-1:ch-service:svc1");
    expect(b!.fields).toMatchObject({ serviceId: "svc1", status: "done", sizeInBytes: 1024 });
  });

  it("skips services whose ClickPipes cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      const path = String(url).replace("https://api.clickhouse.cloud", "");
      if (path === `${ORG}/services`) return respond({ result: [SERVICE] });
      return respond("forbidden", 403);
    }) as typeof fetch);
    expect(await client().listResources("ch-clickpipe", ACCOUNT)).toEqual([]);
  });

  it("lists ClickPipes, derives the source kind, and drives state and scaling", async () => {
    const pipe = {
      id: "p1",
      serviceId: "svc1",
      name: "events",
      state: "Running",
      scaling: { replicas: 2 },
      source: { kafka: { brokers: "b" }, objectStorage: null },
      destination: { database: "default", table: "events" },
    };
    route([
      ["GET", `${ORG}/services`, { result: [SERVICE] }],
      ["GET", `${ORG}/services/svc1/clickpipes`, { result: [pipe] }],
      ["PATCH", `${ORG}/services/svc1/clickpipes/p1/state`, { result: pipe }],
      [
        "PATCH",
        `${ORG}/services/svc1/clickpipes/p1/scaling`,
        { result: { ...pipe, scaling: { replicas: 4 } } },
      ],
      ["DELETE", `${ORG}/services/svc1/clickpipes/p1`, {}],
    ]);
    const c = client();
    const [p] = await c.listResources("ch-clickpipe", ACCOUNT);
    expect(p!.id).toBe("acct-1:ch-clickpipe:svc1/p1");
    expect(p!.fields).toMatchObject({
      sourceType: "kafka",
      destinationTable: "events",
      replicas: 2,
    });
    expect((c.renderDetail(p!).headerActions ?? []).map((a) => a.label)).toContain("Stop");

    await c.invokeAction("ch-clickpipe", p!.id, "stop", ACCOUNT);
    const updated = await c.updateResource("ch-clickpipe", p!.id, ACCOUNT, { replicas: "4" });
    expect(updated.fields["replicas"]).toBe(4);
    await c.deleteResource("ch-clickpipe", p!.id, ACCOUNT);
    expect(calls.filter((x) => x.method !== "GET").map((x) => [x.method, x.url, x.body])).toEqual([
      ["PATCH", `${ORG}/services/svc1/clickpipes/p1/state`, { command: "stop" }],
      ["PATCH", `${ORG}/services/svc1/clickpipes/p1/scaling`, { replicas: 4 }],
      ["DELETE", `${ORG}/services/svc1/clickpipes/p1`, undefined],
    ]);
  });
});

describe("API keys and members", () => {
  const KEY = {
    id: "k1",
    name: "ci",
    state: "enabled",
    keySuffix: "abcd",
    assignedRoles: [{ roleId: "r1", roleName: "Org Admin", roleType: "system" }],
    createdAt: "2026-01-01T00:00:00Z",
    usedAt: "2026-09-30T12:00:00Z",
    expireAt: null,
  };

  it("lists keys with roles, admin flag and last use", async () => {
    route([["GET", `${ORG}/keys`, { result: [KEY] }]]);
    const [k] = await client().listResources("ch-api-key", ACCOUNT);
    expect(k!.fields).toMatchObject({
      roles: "Org Admin",
      isAdmin: true,
      lastUsedAt: "2026-09-30T12:00:00Z",
      expireAt: "",
    });
  });

  it("disables, renames and deletes keys", async () => {
    route([
      ["PATCH", `${ORG}/keys/k1`, { result: { ...KEY, name: "ci2" } }],
      ["DELETE", `${ORG}/keys/k1`, {}],
    ]);
    const c = client();
    await c.invokeAction("ch-api-key", "acct-1:ch-api-key:k1", "disable", ACCOUNT);
    const renamed = await c.updateResource("ch-api-key", "acct-1:ch-api-key:k1", ACCOUNT, {
      name: "ci2",
    });
    expect(renamed.displayName).toBe("ci2");
    await c.deleteResource("ch-api-key", "acct-1:ch-api-key:k1", ACCOUNT);
    expect(calls.map((x) => [x.method, x.body])).toEqual([
      ["PATCH", { state: "disabled" }],
      ["PATCH", { name: "ci2" }],
      ["DELETE", undefined],
    ]);
  });

  it("lists members falling back to the legacy role", async () => {
    route([
      [
        "GET",
        `${ORG}/members`,
        { result: [{ userId: "u1", name: "Ada", email: "ada@example.com", role: "developer" }] },
      ],
      ["DELETE", `${ORG}/members/u1`, {}],
    ]);
    const c = client();
    const [m] = await c.listResources("ch-member", ACCOUNT);
    expect(m!.fields).toMatchObject({ roles: "developer", isAdmin: false });
    await c.deleteResource("ch-member", m!.id, ACCOUNT);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `${ORG}/members/u1` });
  });
});

describe("Managed Postgres", () => {
  const PG = {
    id: "pg1",
    name: "app-db",
    provider: "aws",
    region: "us-east-1",
    postgresVersion: "18",
    size: "r8gd.large",
    haType: "async",
    state: "running",
    isPrimary: true,
  };

  it("reads each service for hostname and storage", async () => {
    route([
      ["GET", `${ORG}/postgres`, { result: [PG] }],
      [
        "GET",
        `${ORG}/postgres/pg1`,
        { result: { ...PG, hostname: "pg1.example", storageSize: 100, username: "postgres" } },
      ],
    ]);
    const [pg] = await client().listResources("ch-postgres", ACCOUNT);
    expect(pg!.fields).toMatchObject({
      hostname: "pg1.example",
      storageSize: 100,
      haType: "async",
    });
    expect(pg!.resolvedOutputs["connectionString"]).toBeUndefined();
  });

  it("creates with the provider-specific size and keeps the one-time connection string", async () => {
    route([
      [
        "POST",
        `${ORG}/postgres`,
        {
          result: {
            ...PG,
            provider: "gcp",
            size: "c4a-highmem-4",
            connectionString: "postgres://u:p@h/db",
          },
        },
      ],
    ]);
    const created = await client().createResource("ch-postgres", ACCOUNT, {
      name: "app-db",
      provider: "gcp",
      region: "us-central1",
      postgresVersion: "17",
      awsSize: "r8gd.large",
      gcpSize: "c4a-highmem-4",
      haType: "none",
    });
    expect(calls[0]!.body).toEqual({
      name: "app-db",
      provider: "gcp",
      region: "us-central1",
      size: "c4a-highmem-4",
      postgresVersion: "17",
      haType: "none",
    });
    const resource = normalizeResourceCreateResult(created).resource;
    expect(resource.resolvedOutputs["connectionString"]).toBe("postgres://u:p@h/db");
  });

  it("offers provider-filtered sizes and regions on the create form", async () => {
    const config = await client().getCreateConfig("ch-postgres");
    const aws = config.fields.find((f) => f.key === "awsSize")!;
    const gcp = config.fields.find((f) => f.key === "gcpSize")!;
    expect(aws.options!.every((o) => o.id.includes("."))).toBe(true);
    expect(gcp.options!.every((o) => !o.id.includes("."))).toBe(true);
    const region = config.fields.find((f) => f.key === "region")!;
    expect(region.regions!.some((r) => r.availableFor?.includes("azure"))).toBe(false);
  });

  it("restarts, resizes and maps time-series metrics", async () => {
    route([
      ["PATCH", `${ORG}/postgres/pg1/state`, { result: PG }],
      ["PATCH", `${ORG}/postgres/pg1`, { result: { ...PG, size: "r8gd.xlarge" } }],
      [
        "GET",
        `${ORG}/postgres/pg1/metrics?from_date=${encodeURIComponent("1970-01-01T00:00:00.000Z")}&to_date=${encodeURIComponent("1970-01-01T01:00:00.000Z")}`,
        {
          result: {
            metrics: [
              {
                key: "cpu_usage",
                name: "CPU usage",
                unit: "%",
                description: "",
                series: [{ label: "total", dataPoints: [{ timestamp: 60, value: 12.5 }] }],
              },
            ],
          },
        },
      ],
    ]);
    const c = client();
    await c.invokeAction("ch-postgres", "acct-1:ch-postgres:pg1", "restart", ACCOUNT);
    const resized = await c.updateResource("ch-postgres", "acct-1:ch-postgres:pg1", ACCOUNT, {
      size: "r8gd.xlarge",
    });
    expect(resized.fields["size"]).toBe("r8gd.xlarge");
    const series = await c.fetchMetricSeries("ch-postgres", "acct-1:ch-postgres:pg1", ACCOUNT, {
      startMs: 0,
      endMs: 3_600_000,
    });
    expect(series).toEqual([
      { label: "CPU usage", unit: "%", points: [{ timestamp: 60_000, value: 12.5 }] },
    ]);
    expect(calls[0]!.body).toEqual({ command: "restart" });
  });
});

describe("credits and quotas", () => {
  it("maps credit balances", async () => {
    route([
      [
        "GET",
        `${ORG}/creditBalances`,
        {
          result: {
            totalRemainingCredits: 250,
            balances: [
              {
                id: "bal1",
                type: "prepaid",
                remainingCredits: 250,
                totalAmount: 1000,
                expirationDate: "2027-01-01",
              },
            ],
          },
        },
      ],
    ]);
    expect(await client().fetchCreditBalance()).toEqual([
      {
        key: "bal1",
        label: "Prepaid credits",
        remaining: 250,
        currency: "USD",
        granted: 1000,
        expiresAt: "2027-01-01",
      },
    ]);
  });

  it("keeps only quotas that report usage", async () => {
    route([
      [
        "GET",
        `${ORG}/quotas`,
        {
          result: [
            {
              quotaCode: "services-per-organization",
              name: "Services",
              description: "",
              scope: "organization",
              value: 20,
              usage: 4,
              adjustable: true,
            },
            {
              quotaCode: "replicas-per-warehouse",
              name: "Replicas",
              description: "",
              scope: "warehouse",
              value: 20,
              adjustable: true,
            },
          ],
        },
      ],
    ]);
    expect(await client().fetchQuotas()).toEqual([
      {
        id: "services-per-organization",
        service: "organization",
        name: "Services",
        limit: 20,
        used: 4,
        adjustable: true,
      },
    ]);
  });
});
