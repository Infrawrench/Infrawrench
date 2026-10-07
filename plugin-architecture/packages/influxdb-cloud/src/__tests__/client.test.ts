import { afterEach, describe, expect, it, vi } from "vitest";
import { InfluxClient, isFlux } from "../client.js";
import { InfluxApiError, parseAnnotatedCsv } from "../api.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { T } from "../resource-types.js";
import { mockFetch } from "./helpers.js";

const creds = { region: "us-east-1-1", token: "tok", orgId: "org1" };
const USAGE = [
  "#group,false,false,true,true,false,false,true,true,true,true",
  "#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string,string,string",
  "#default,_result,,,,,,,,,",
  ",result,table,_start,_stop,_time,_value,_field,_measurement,bucket_id,org_id",
  ",,0,2026-10-06T10:00:00Z,2026-10-06T12:00:00Z,2026-10-06T11:00:00Z,1000,gauge,storage_usage_bucket_bytes,b1,org1",
  ",,0,2026-10-06T10:00:00Z,2026-10-06T12:00:00Z,2026-10-06T12:00:00Z,2048,gauge,storage_usage_bucket_bytes,b1,org1",
  "",
].join("\n");

afterEach(() => vi.unstubAllGlobals());

describe("InfluxClient", () => {
  it("requires either Cloud or Dedicated credentials", () => {
    expect(() => new InfluxClient({})).toThrow(/region and API token/);
    expect(
      () =>
        new InfluxClient({
          dedicatedAccountId: "a",
          dedicatedClusterId: "c",
          dedicatedManagementToken: "m",
        }),
    ).not.toThrow();
  });

  it("lists buckets with retention in days and latest storage, skipping system buckets", async () => {
    const { calls } = mockFetch({
      "GET /api/v2/buckets": {
        buckets: [
          {
            id: "b1",
            name: "metrics",
            orgID: "org1",
            retentionRules: [{ type: "expire", everySeconds: 2592000 }],
            type: "user",
          },
          { id: "b2", name: "_monitoring", type: "system", retentionRules: [] },
          { id: "b3", name: "forever", type: "user", retentionRules: [] },
        ],
      },
      "GET /api/v2/orgs/org1/usage": USAGE,
    });
    const client = new InfluxClient(creds);
    const buckets = await client.listResources(T.bucket, "acc");
    expect(buckets.map((b) => b.externalId)).toEqual(["b1", "b3"]);
    expect(buckets[0]!.fields).toMatchObject({
      retentionDays: 30,
      storageBytes: 2048,
      region: "us-east-1-1",
    });
    expect(buckets[1]!.fields["retentionDays"]).toBe(0);
    expect(calls[0]!.headers["Authorization"]).toBe("Token tok");
    expect(calls[0]!.url.searchParams.get("orgID")).toBe("org1");
  });

  it("returns nothing for Cloud types on a Dedicated-only account", async () => {
    const client = new InfluxClient({
      dedicatedAccountId: "a",
      dedicatedClusterId: "c",
      dedicatedManagementToken: "m",
    });
    expect(await client.listResources(T.bucket, "acc")).toEqual([]);
  });

  it("creates a scoped token and returns it once", async () => {
    const { calls } = mockFetch({
      "POST /api/v2/authorizations": {
        id: "a1",
        description: "t",
        status: "active",
        token: "secret==",
        permissions: [{ action: "read", resource: { type: "buckets", id: "b1" } }],
      },
    });
    const client = new InfluxClient(creds);
    const res = await client.createResource(T.token, "acc", {
      description: "t",
      readBuckets: '["b1"]',
      other: '["tasks:read"]',
    });
    expect(calls[0]!.body).toEqual({
      orgID: "org1",
      description: "t",
      permissions: [
        { action: "read", resource: { type: "buckets", id: "b1", orgID: "org1" } },
        { action: "read", resource: { type: "tasks", orgID: "org1" } },
      ],
    });
    expect("resource" in res && res.resource.resolvedOutputs["token"]).toBe("secret==");
  });

  it("updates bucket retention and turns 0 into keep-forever", async () => {
    const { calls } = mockFetch({
      "PATCH /api/v2/buckets/b1": {},
      "GET /api/v2/buckets": { buckets: [{ id: "b1", name: "metrics", retentionRules: [] }] },
      "GET /api/v2/orgs/org1/usage": "",
    });
    const client = new InfluxClient(creds);
    await client.updateResource(T.bucket, "acc:influx-bucket:b1", "acc", {
      retentionDays: "0",
      description: "x",
    });
    expect(calls[0]!.body).toEqual({ description: "x", retentionRules: [] });
  });

  it("runs InfluxQL through /query and flattens series", async () => {
    mockFetch({
      "GET /api/v2/buckets": { buckets: [{ id: "b1", name: "metrics" }] },
      "GET /query": (url: URL) => {
        expect(url.searchParams.get("db")).toBe("metrics");
        return {
          results: [
            {
              series: [
                {
                  name: "cpu",
                  tags: { host: "a" },
                  columns: ["time", "usage"],
                  values: [[1, 0.5]],
                },
              ],
            },
          ],
        };
      },
    });
    const client = new InfluxClient(creds);
    const res = await client.executeQuery("acc:influx-bucket:b1", "acc", "SELECT usage FROM cpu");
    expect(res.rows).toEqual([{ measurement: "cpu", host: "a", time: 1, usage: 0.5 }]);
  });

  it("runs Flux through /api/v2/query and parses annotated CSV", async () => {
    const { calls } = mockFetch({
      "POST /api/v2/query": "#datatype,string,long,double\n,result,table,_value\n,_result,0,1.5\n",
    });
    const client = new InfluxClient(creds);
    const res = await client.executeQuery(
      "acc:influx-bucket:b1",
      "acc",
      'from(bucket: "m") |> range(start: -1h)',
    );
    expect(res.rows).toEqual([{ _value: "1.5" }]);
    expect(calls[0]!.url.searchParams.get("orgID")).toBe("org1");
  });

  it("reports quotas only where the plan states a limit", async () => {
    mockFetch({
      "GET /api/v2/orgs/org1/limits": {
        limits: {
          bucket: { maxBuckets: 2, maxRetentionDuration: 0 },
          task: { maxTasks: 0 },
          check: { maxChecks: 0 },
          rate: {},
        },
      },
      "GET /api/v2/buckets": { buckets: [{ id: "b1", type: "user" }] },
    });
    const client = new InfluxClient(creds);
    expect(await client.fetchQuotas("acc")).toEqual([
      {
        id: "buckets",
        service: "InfluxDB Cloud",
        name: "Buckets",
        region: "us-east-1-1",
        limit: 2,
        used: 1,
      },
    ]);
  });

  it("charts bucket storage from the usage CSV", async () => {
    mockFetch({ "GET /api/v2/orgs/org1/usage": USAGE });
    const client = new InfluxClient(creds);
    const series = await client.fetchMetricSeries(T.bucket, "acc:influx-bucket:b1", "acc");
    expect(series).toEqual([
      {
        label: "Storage",
        unit: "bytes",
        points: [
          { timestamp: Date.parse("2026-10-06T11:00:00Z"), value: 1000 },
          { timestamp: Date.parse("2026-10-06T12:00:00Z"), value: 2048 },
        ],
      },
    ]);
  });

  it("manages Cloud Dedicated databases with retention in nanoseconds", async () => {
    const { calls } = mockFetch({
      "POST console.influxdata.com/api/v0/accounts/a/clusters/c/databases": {
        name: "db1",
        retentionPeriod: 2592000000000000,
        maxTables: 500,
      },
    });
    const client = new InfluxClient({
      dedicatedAccountId: "a",
      dedicatedClusterId: "c",
      dedicatedManagementToken: "m",
    });
    const r = await client.createResource(T.dedicatedDatabase, "acc", {
      name: "db1",
      retentionDays: "30",
      maxTables: "500",
    });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer m");
    expect(calls[0]!.body).toEqual({
      name: "db1",
      retentionPeriod: 2592000000000000,
      maxTables: 500,
    });
    expect(("resource" in r ? r.resource : r).fields["retentionDays"]).toBe(30);
  });

  it("maps a 401 to an error with status", async () => {
    mockFetch({
      "GET /api/v2/buckets": new Response(
        '{"code":"unauthorized","message":"unauthorized access"}',
        { status: 401 },
      ),
    });
    const err = await new InfluxClient(creds)
      .listResources(T.bucket, "acc")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfluxApiError);
    expect((err as InfluxApiError).status).toBe(401);
  });

  it("lists organizations for the picker", async () => {
    mockFetch({ "GET /api/v2/orgs": { orgs: [{ id: "org1", name: "Acme" }] } });
    expect(
      await plugin.listCredentialOptions!("orgId", { region: "us-east-1-1", token: "tok" }),
    ).toEqual([{ id: "org1", label: "Acme", description: "org1" }]);
  });
});

describe("helpers", () => {
  it("tells Flux from InfluxQL", () => {
    expect(isFlux('from(bucket:"x") |> range(start:-1h)')).toBe(true);
    expect(isFlux("SELECT * FROM cpu")).toBe(false);
  });

  it("parses multi-table annotated CSV with quoted cells", () => {
    expect(parseAnnotatedCsv(',result,table,a\n,,0,"x,y"\n\n,result,table,b\n,,1,2\n')).toEqual([
      { a: "x,y" },
      { b: "2" },
    ]);
  });

  it("maps status incidents to regions through their component group", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "i1",
          name: "Slow queries",
          status: "investigating",
          impact: "minor",
          created_at: new Date().toISOString(),
          components: [{ name: "API Queries", group_id: "zk71dc4www40" }],
        },
        {
          id: "i2",
          name: "SSO",
          status: "monitoring",
          impact: "minor",
          created_at: new Date().toISOString(),
          components: [{ name: "Auth0 User Authentication", group_id: "hd39m4t0zywd" }],
        },
      ],
    });
    const [a, b] = parseStatusFeed(body);
    expect(a).toMatchObject({ regions: ["westeurope-1"], resourceTypes: [T.bucket] });
    expect(a!.providerWide).toBeUndefined();
    expect(b!.providerWide).toBe(true);
  });
});
