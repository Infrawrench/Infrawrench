import { describe, expect, it } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { ConfluentCloudClient, KAFKA_KEY_FIELD, KAFKA_SECRET_FIELD } from "../client.js";
import { makeHttp, makeSecrets } from "./helpers.js";
import type { Reply } from "./helpers.js";

const ENV = {
  id: "env-1",
  display_name: "prod",
  stream_governance_config: { package: "ESSENTIALS" },
};

const DEDICATED = {
  id: "lkc-ded",
  metadata: {
    resource_name: "crn://confluent.cloud/organization=o/environment=env-1/cloud-cluster=lkc-ded",
  },
  spec: {
    display_name: "orders",
    availability: "MULTI_ZONE",
    cloud: "AWS",
    region: "us-east-1",
    config: { kind: "Dedicated", cku: 4 },
    kafka_bootstrap_endpoint: "SASL_SSL://pkc-abc.us-east-1.aws.confluent.cloud:9092",
    http_endpoint: "https://pkc-abc.us-east-1.aws.confluent.cloud:443",
    environment: { id: "env-1" },
  },
  status: { phase: "PROVISIONED", cku: 4 },
};

const BASIC = {
  id: "lkc-basic",
  spec: {
    display_name: "scratch",
    availability: "SINGLE_ZONE",
    cloud: "GCP",
    region: "us-central1",
    config: { kind: "Basic", max_ecku: 1 },
    environment: { id: "env-1" },
  },
  status: { phase: "PROVISIONED" },
};

function routes(extra?: (url: URL, method: string, body: unknown) => Reply | undefined) {
  return (url: URL, method: string, body: unknown): Reply => {
    const custom = extra?.(url, method, body);
    if (custom) return custom;
    if (url.hostname === "api.telemetry.confluent.cloud") {
      const b = body as { aggregations: Array<{ metric: string }>; group_by?: string[] };
      const metric = b.aggregations[0]!.metric;
      if (metric.endsWith("retained_bytes") && b.group_by?.includes("metric.topic")) {
        return {
          body: {
            data: [
              { "resource.kafka.id": "lkc-ded", "metric.topic": "a", value: 10 },
              { "resource.kafka.id": "lkc-ded", "metric.topic": "b", value: 20 },
            ],
          },
        };
      }
      if (metric.endsWith("partition_count")) {
        return { body: { data: [{ "resource.kafka.id": "lkc-ded", value: 12 }] } };
      }
      if (metric.endsWith("received_bytes") || metric.endsWith("sent_bytes")) {
        // Only the dedicated cluster has traffic; the basic one has no rows.
        return { body: { data: [{ "resource.kafka.id": "lkc-ded", value: 5000 }] } };
      }
      return { body: { data: [] } };
    }
    if (url.pathname === "/org/v2/environments") return { body: { data: [ENV], metadata: {} } };
    if (url.pathname === "/cmk/v2/clusters") {
      return { body: { data: [DEDICATED, BASIC], metadata: {} } };
    }
    if (url.pathname === "/cmk/v2/clusters/lkc-ded") {
      return {
        body: method === "PATCH" ? { ...DEDICATED, spec: { ...DEDICATED.spec } } : DEDICATED,
      };
    }
    return { status: 404, body: { error: "not found" } };
  };
}

function client(
  route: (url: URL, method: string, body: unknown) => Reply,
  extra: Partial<HostServices> = {},
) {
  const { http, calls } = makeHttp(route);
  const c = new ConfluentCloudClient({ apiKey: "CLOUDKEY", apiSecret: "s3cr3t" }, {
    http,
    ...extra,
  } as unknown as HostServices);
  return { c, calls };
}

describe("ConfluentCloudClient", () => {
  it("authenticates with HTTP Basic using the Cloud API key", async () => {
    const { c, calls } = client(routes());
    await c.listResources("environment", "acc");
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("CLOUDKEY:s3cr3t")}`);
  });

  it("lists clusters per environment with metrics-derived usage and an idle flag", async () => {
    const { c, calls } = client(routes());
    const clusters = await c.listResources("kafka-cluster", "acc");
    expect(calls.some((x) => x.url.searchParams.get("environment") === "env-1")).toBe(true);
    const ded = clusters.find((r) => r.externalId === "lkc-ded")!;
    expect(ded.id).toBe("acc:kafka-cluster:env-1/lkc-ded");
    expect(ded.parentResourceId).toBe("acc:environment:env-1");
    expect(ded.fields).toMatchObject({
      cku: 4,
      clusterType: "Dedicated",
      placement: "AWS/us-east-1/MULTI_ZONE",
      topics: 2,
      partitions: 12,
      bytesIn7d: 5000,
      idle: "false",
    });
    const basic = clusters.find((r) => r.externalId === "lkc-basic")!;
    expect(basic.fields["maxEcku"]).toBe(1);
    expect(basic.fields["cku"]).toBeUndefined();
    expect(basic.fields["idle"]).toBe("true");
  });

  it("leaves usage absent (never zero) when the Metrics API refuses", async () => {
    const { c } = client(
      routes((url) =>
        url.hostname === "api.telemetry.confluent.cloud" ? { status: 403 } : undefined,
      ),
    );
    const clusters = await c.listResources("kafka-cluster", "acc");
    for (const r of clusters) {
      expect(r.fields["idle"]).toBeUndefined();
      expect(r.fields["bytesIn7d"]).toBeUndefined();
    }
  });

  it("resizes a Dedicated cluster with kind and environment in the PATCH", async () => {
    const { c, calls } = client(routes());
    await c.executeNoSqlCommand(
      "kafka-cluster",
      "acc:kafka-cluster:env-1/lkc-ded",
      "acc",
      "resize",
      [JSON.stringify({ cku: "3" })],
    );
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url.pathname).toBe("/cmk/v2/clusters/lkc-ded");
    expect(patch.body).toEqual({
      spec: { environment: { id: "env-1" }, config: { kind: "Dedicated", cku: 3 } },
    });
  });

  it("refuses 1 CKU on a multi-zone cluster before calling Confluent", async () => {
    const { c, calls } = client(routes());
    await expect(
      c.updateResource("kafka-cluster", "acc:kafka-cluster:env-1/lkc-ded", "acc", { cku: "1" }),
    ).rejects.toThrow(/at least 2/);
    expect(calls.some((x) => x.method === "PATCH")).toBe(false);
  });

  it("mints a cluster key for the Cloud key's owner and builds a kafka:// URL from it", async () => {
    const { secrets, store } = makeSecrets();
    const { c, calls } = client(
      routes((url, method) => {
        if (url.pathname === "/iam/v2/api-keys/CLOUDKEY") {
          return { body: { id: "CLOUDKEY", spec: { owner: { id: "u-owner" } } } };
        }
        if (url.pathname === "/iam/v2/api-keys" && method === "POST") {
          return { body: { id: "CLUSTERKEY", spec: { secret: "a+b/c=" } } };
        }
        return undefined;
      }),
      { secrets } as Partial<HostServices>,
    );
    const rid = "acc:kafka-cluster:env-1/lkc-ded";
    await c.executeNoSqlCommand("kafka-cluster", rid, "acc", "create-kafka-api-key", ["{}"]);
    const post = calls.find((x) => x.url.pathname === "/iam/v2/api-keys" && x.method === "POST")!;
    expect(post.body).toMatchObject({
      spec: { owner: { id: "u-owner" }, resource: { id: "lkc-ded", environment: "env-1" } },
    });
    expect(calls.some((x) => x.url.pathname === "/iam/v2/role-bindings")).toBe(false);
    expect(store.get(`${rid}|${KAFKA_KEY_FIELD}`)).toBe("CLUSTERKEY");
    expect(store.get(`${rid}|${KAFKA_SECRET_FIELD}`)).toBe("a+b/c=");

    const url = new URL(await c.resolveOutput("kafka-cluster", rid, "connectionString", "acc"));
    expect(url.protocol).toBe("kafka:");
    expect(url.host).toBe("pkc-abc.us-east-1.aws.confluent.cloud:9092");
    expect(url.searchParams.get("sasl")).toBe("plain");
    expect(url.searchParams.get("ssl")).toBe("true");
    expect(url.searchParams.get("user")).toBe("CLUSTERKEY");
    expect(url.searchParams.get("password")).toBe("a+b/c=");
  });

  it("grants a picked service account CloudClusterAdmin on the cluster's CRN", async () => {
    const { secrets } = makeSecrets();
    const { c, calls } = client(
      routes((url, method) => {
        if (url.pathname === "/iam/v2/role-bindings") return { status: 201, body: { id: "rb-1" } };
        if (url.pathname === "/iam/v2/api-keys" && method === "POST") {
          return { body: { id: "K", spec: { secret: "S" } } };
        }
        return undefined;
      }),
      { secrets } as Partial<HostServices>,
    );
    await c.executeNoSqlCommand(
      "kafka-cluster",
      "acc:kafka-cluster:env-1/lkc-ded",
      "acc",
      "create-kafka-api-key",
      [JSON.stringify({ owner: "acc:service-account:sa-9", grantRole: "CloudClusterAdmin" })],
    );
    const rb = calls.find((x) => x.url.pathname === "/iam/v2/role-bindings")!;
    expect(rb.body).toEqual({
      principal: "User:sa-9",
      role_name: "CloudClusterAdmin",
      crn_pattern: DEDICATED.metadata.resource_name,
    });
  });

  it("says how to get a key when none is stored", async () => {
    const { secrets } = makeSecrets();
    const { c } = client(routes(), { secrets } as Partial<HostServices>);
    await expect(
      c.resolveOutput(
        "kafka-cluster",
        "acc:kafka-cluster:env-1/lkc-ded",
        "connectionString",
        "acc",
      ),
    ).rejects.toThrow(/Create Kafka API key/);
  });

  it("pauses, resumes and restarts connectors on their own routes", async () => {
    const { c, calls } = client(routes(() => ({ status: 202 })));
    const rid = "acc:connector:env-1/lkc-ded/pg-sink";
    await c.invokeAction("connector", rid, "pause", "acc");
    await c.invokeAction("connector", rid, "resume", "acc");
    await c.invokeAction("connector", rid, "restart", "acc");
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "PUT /connect/v1/environments/env-1/clusters/lkc-ded/connectors/pg-sink/pause",
      "PUT /connect/v1/environments/env-1/clusters/lkc-ded/connectors/pg-sink/resume",
      "POST /connect/v1/environments/env-1/clusters/lkc-ded/connectors/pg-sink/restart",
    ]);
  });

  it("lists connectors with ids, task counts and 7-day records", async () => {
    const { c } = client(
      routes((url) => {
        if (url.pathname.endsWith("/clusters/lkc-ded/connectors")) {
          return {
            body: {
              "pg-sink": {
                id: { id: "lcc-1", id_type: "ID" },
                info: { config: { "connector.class": "PostgresSink" } },
                status: {
                  type: "sink",
                  connector: { state: "RUNNING" },
                  tasks: [
                    { id: 0, state: "RUNNING" },
                    { id: 1, state: "FAILED" },
                  ],
                },
              },
            },
          };
        }
        if (url.pathname.endsWith("/connectors")) return { body: {} };
        return undefined;
      }),
    );
    const [conn] = await c.listResources("connector", "acc");
    expect(conn!.id).toBe("acc:connector:env-1/lkc-ded/pg-sink");
    expect(conn!.externalId).toBe("lcc-1");
    expect(conn!.fields).toMatchObject({
      connectorClass: "PostgresSink",
      state: "RUNNING",
      tasks: 2,
      failedTasks: 1,
      recordsIn7d: 0,
      recordsOut7d: 0,
      idle: "true",
    });
  });

  it("prices the CKU catalog from billed CKU-hours, without 1 CKU on multi-zone", async () => {
    const { c } = client(
      routes((url) => {
        if (url.pathname === "/billing/v1/costs") {
          return {
            body: {
              data: [
                {
                  start_date: "2026-09-10",
                  line_type: "KAFKA_NUM_CKUS",
                  product: "KAFKA",
                  quantity: 96,
                  amount: 192,
                  resource: { id: "lkc-ded" },
                },
              ],
              metadata: {},
            },
          };
        }
        return undefined;
      }),
    );
    const prices = await c.getCreateSizePricing("kafka-cluster", {
      regionId: "AWS/us-east-1/MULTI_ZONE",
      sizes: [
        { id: "1", vcpus: 1, memoryMb: 1024 },
        { id: "2", vcpus: 2, memoryMb: 2048 },
      ],
    });
    expect(prices).toEqual({ "2": 2 * 730 * 2 });
  });
});
