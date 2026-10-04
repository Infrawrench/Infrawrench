import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisCloudClient } from "../client.js";
import { completed, mockFetch } from "./helpers.js";

const PRO_SUB = {
  id: 1206,
  name: "prod",
  status: "active",
  deploymentType: "single-region",
  memoryStorage: "ram",
  numberOfDatabases: 1,
  publicEndpointAccess: true,
  paymentMethodType: "credit-card",
  subscriptionPricing: [
    {
      type: "Shards",
      typeDetails: "high-throughput",
      quantity: 2,
      quantityMeasurement: "shards",
      pricePerUnit: 0.124,
      priceCurrency: "USD",
      pricePeriod: "hour",
    },
  ],
  cloudDetails: [{ provider: "AWS", cloudAccountId: 1, regions: [{ region: "us-east-1" }] }],
};

const PRO_DB = {
  databaseId: 51,
  name: "cache",
  status: "active",
  provider: "AWS",
  region: "us-east-1",
  redisVersion: "7.4",
  datasetSizeInGb: 10,
  memoryLimitInGb: 20,
  memoryUsedInMb: 512,
  replication: true,
  dataPersistence: "none",
  dataEvictionPolicy: "allkeys-lru",
  throughputMeasurement: { by: "operations-per-second", value: 2500 },
  publicEndpoint: "redis-17571.c1.us-east-1-1.ec2.cloud.rlrcp.com:17571",
  security: { enableDefaultUser: true, enableTls: true, sourceIps: ["0.0.0.0/0"] },
  modules: [{ name: "RedisJSON", capabilityName: "JSON" }],
  alerts: [{ name: "dataset-size", value: 80 }],
};

const ESS_SUB = {
  id: 77,
  name: "small",
  status: "active",
  planId: 98181,
  planName: "Standard 1GB",
  size: 1,
  sizeMeasurementUnit: "GB",
  provider: "AWS",
  region: "us-west-1",
  price: 22,
  pricePeriod: "Month",
  priceCurrency: "USD",
};

function baseRoutes() {
  return {
    "GET /subscriptions": { subscriptions: [PRO_SUB] },
    "GET /fixed/subscriptions": { subscriptions: [ESS_SUB] },
    "GET /subscriptions/1206/databases": {
      subscription: [{ subscriptionId: 1206, databases: [PRO_DB] }],
    },
    "GET /fixed/subscriptions/77/databases": {
      subscription: {
        subscriptionId: 77,
        databases: [
          {
            databaseId: 88,
            name: "tiny",
            status: "active",
            planMemoryLimit: 1,
            memoryLimitMeasurementUnit: "GB",
            memoryUsedInMb: 2,
          },
        ],
      },
    },
  };
}

function client() {
  const c = new RedisCloudClient({ accountKey: "a", userKey: "u" });
  c.ctx.sleep = async () => {};
  return c;
}

afterEach(() => vi.unstubAllGlobals());

describe("RedisCloudClient", () => {
  it("sends both key headers", async () => {
    const { fn } = mockFetch(baseRoutes());
    await client().listResources("rc-subscription", "acc");
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("a");
    expect(headers["x-api-secret-key"]).toBe("u");
  });

  it("lists Pro and Essentials subscriptions with prices", async () => {
    mockFetch(baseRoutes());
    const subs = await client().listResources("rc-subscription", "acc");
    expect(subs.map((s) => s.externalId)).toEqual(["pro-1206", "ess-77"]);
    expect(subs[0]!.fields).toMatchObject({
      plan: "Pro",
      shards: 2,
      monthlyPrice: 181.04,
      region: "us-east-1",
    });
    expect(subs[1]!.fields).toMatchObject({
      plan: "Essentials",
      planName: "Standard 1GB",
      monthlyPrice: 22,
    });
  });

  it("lists databases under their subscription and flags an empty paid one", async () => {
    mockFetch(baseRoutes());
    const dbs = await client().listResources("rc-database", "acc");
    const pro = dbs.find((d) => d.externalId === "51")!;
    expect(pro.parentResourceId).toBe("acc:rc-subscription:pro-1206");
    expect(pro.fields).toMatchObject({
      memoryUsedPct: 5,
      throughputOpsPerSec: 2500,
      modules: "JSON",
      sourceIps: "0.0.0.0/0",
      enableTls: true,
    });
    const ess = dbs.find((d) => d.externalId === "88")!;
    expect(ess.fields["savingsFlag"]).toBe("empty");
    expect(pro.fields["savingsFlag"]).toBeUndefined();
  });

  it("builds a TLS connection string from the single-database GET", async () => {
    mockFetch({
      ...baseRoutes(),
      "GET /subscriptions/1206/databases/51": {
        ...PRO_DB,
        security: { ...PRO_DB.security, password: "p@ss" },
      },
    });
    const c = client();
    const cs = await c.resolveOutput(
      "rc-database",
      "acc:rc-database:51",
      "connectionString",
      "acc",
    );
    expect(cs).toBe("rediss://default:p%40ss@redis-17571.c1.us-east-1-1.ec2.cloud.rlrcp.com:17571");
  });

  it("refuses to resize below the stored data", async () => {
    mockFetch({
      ...baseRoutes(),
      "GET /subscriptions/1206/databases/51": { ...PRO_DB, memoryUsedInMb: 4096 },
    });
    await expect(
      client().executeNoSqlCommand("rc-database", "acc:rc-database:51", "acc", "resize-memory", [
        JSON.stringify({ datasetSizeInGb: "2" }),
      ]),
    ).rejects.toThrow(/at least 4.4 GB/);
  });

  it("resizes through a task and reports completion", async () => {
    const { calls } = mockFetch({
      ...baseRoutes(),
      "GET /subscriptions/1206/databases/51": PRO_DB,
      "PUT /subscriptions/1206/databases/51": { taskId: "t-9", status: "received" },
      "GET /tasks/t-9": completed({}, 51),
    });
    const res = await client().executeNoSqlCommand(
      "rc-database",
      "acc:rc-database:51",
      "acc",
      "resize-memory",
      [JSON.stringify({ datasetSizeInGb: "2" })],
    );
    expect(res).toEqual({ ok: true, message: "Resize complete." });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ datasetSizeInGb: 2 });
  });

  it("validates alert ranges", async () => {
    mockFetch(baseRoutes());
    await expect(
      client().executeNoSqlCommand("rc-database", "acc:rc-database:51", "acc", "set-alerts", [
        JSON.stringify({ latency: "20000" }),
      ]),
    ).rejects.toThrow(/1 to 10000/);
  });

  it("surfaces a failed task's own explanation", async () => {
    mockFetch({
      ...baseRoutes(),
      "POST /subscriptions/1206/databases/51/backup": { taskId: "t-2", status: "received" },
      "GET /tasks/t-2": {
        taskId: "t-2",
        status: "processing-error",
        response: {
          error: {
            type: "DATABASE_BACKUP_NOT_CONFIGURED",
            description: "Backup is not configured",
          },
        },
      },
    });
    await expect(
      client().executeNoSqlCommand("rc-database", "acc:rc-database:51", "acc", "backup", [
        JSON.stringify({}),
      ]),
    ).rejects.toThrow(/Backup is not configured/);
  });

  it("reads VPC peerings through the task the GET returns", async () => {
    mockFetch({
      ...baseRoutes(),
      "GET /subscriptions/1206/peerings": { taskId: "t-3", status: "received" },
      "GET /tasks/t-3": completed({
        peerings: [
          {
            vpcPeeringId: 10,
            status: "active",
            awsAccountId: "123",
            vpcUid: "vpc-1",
            vpcCidrs: [{ vpcCidr: "10.0.0.0/16" }],
          },
        ],
      }),
    });
    const peerings = await client().listResources("rc-vpc-peering", "acc");
    expect(peerings).toHaveLength(1);
    expect(peerings[0]!.externalId).toBe("1206/10");
    expect(peerings[0]!.fields).toMatchObject({ vpcCidrs: "10.0.0.0/16", provider: "AWS" });
  });

  it("lists a type empty on 403 and throws on 401", async () => {
    mockFetch({ "GET /acl/users": new Response("{}", { status: 403 }) });
    expect(await client().listResources("rc-acl-user", "acc")).toEqual([]);
    mockFetch({ "GET /acl/users": new Response("{}", { status: 401 }) });
    await expect(client().listResources("rc-acl-user", "acc")).rejects.toThrow(/401/);
  });

  it("creates an ACL role from the picker values", async () => {
    const { calls } = mockFetch({
      "POST /acl/roles": { taskId: "t-4", status: "received" },
      "GET /tasks/t-4": completed({}, 5),
    });
    const role = await client().createResource("rc-acl-role", "acc", {
      name: "readers",
      ruleName: "Read-Only",
      databases: JSON.stringify(["1206/51"]),
    });
    expect(role.externalId).toBe("5");
    expect(calls[0]!.body).toEqual({
      name: "readers",
      redisRules: [
        { ruleName: "Read-Only", databases: [{ subscriptionId: 1206, databaseId: 51 }] },
      ],
    });
  });

  it("renders a right-sizing hint for a mostly empty Pro database", async () => {
    mockFetch(baseRoutes());
    const c = client();
    const db = (await c.listResources("rc-database", "acc")).find((d) => d.externalId === "51")!;
    const detail = c.renderDetail(db);
    expect(detail.sections.map((s) => s.title)).toContain("Right-sizing");
    expect(detail.metricsCapability).toBeDefined();
  });
});
