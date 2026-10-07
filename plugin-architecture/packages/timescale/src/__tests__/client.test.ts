import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { TimescaleClient, configUpdateFrom, exporterCreateBody } from "../client.js";
import { TigerApiError } from "../api.js";
import { mockFetch } from "./helpers.js";

const SERVICE = {
  service_id: "kd9w2xp4mz",
  project_id: "rp1pz7uyae",
  name: "metrics-prod",
  region_code: "us-east-1",
  service_type: "TIMESCALEDB",
  created: "2026-01-15T09:30:00Z",
  status: "READY",
  resources: [{ id: "n4", spec: { cpu_millis: 2000, memory_gbs: 8, volume_type: "gp3" } }],
  metrics: { memory_mb: 2048, storage_mb: 10240, milli_cpu: 350 },
  metadata: { environment: "PROD" },
  endpoint: { host: "kd9w2xp4mz.abc.tsdb.cloud.timescale.com", port: 32625 },
  connection_pooler: {
    endpoint: { host: "kd9w2xp4mz.pool.tsdb.cloud.timescale.com", port: 33333 },
  },
  ha_replicas: { replica_count: 0, sync_replica_count: 0 },
  data_tiering: { enabled: false },
  vpc_endpoint: { host: "vpc.host", port: 5432, vpc_id: "1337" },
  read_replica_sets: [
    {
      id: "alb8jicdpr",
      name: "reporting",
      status: "active",
      nodes: 2,
      cpu_millis: 1000,
      memory_gbs: 4,
      endpoint: { host: "replica.host", port: 30000 },
    },
  ],
  metric_exporter_id: "3f7c1c9a-0d2e-4d76-9a1b-5c8e0f2a7b31",
};

const base = {
  "GET /projects": [{ id: "rp1pz7uyae", name: "Prod" }],
  "GET /projects/rp1pz7uyae/services": [SERVICE],
  "GET /projects/rp1pz7uyae/services/kd9w2xp4mz": SERVICE,
  "GET /projects/rp1pz7uyae/services/kd9w2xp4mz/backup-retention": {
    type: "TIME",
    retention_days: 21,
  },
};

function secretsStore() {
  const store = new Map<string, string>();
  const secrets: NonNullable<HostServices["secrets"]> = {
    getPlaintext: async (id, key) => store.get(`${id}|${key}`) ?? null,
    setPlaintext: async (id, key, value) => {
      store.set(`${id}|${key}`, value);
    },
  };
  return { store, secrets };
}

afterEach(() => vi.unstubAllGlobals());

describe("TimescaleClient", () => {
  it("authenticates with HTTP Basic over the public key and secret", async () => {
    const { calls } = mockFetch(base);
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    await client.listResources("ts-project", "acc");
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("pub:sec")}`);
    expect(calls[0]!.url.host).toBe("console.cloud.tigerdata.com");
  });

  it("maps services with compute, HA, pooler, VPC and retention", async () => {
    mockFetch(base);
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    const [svc] = await client.listResources("ts-service", "acc");
    expect(svc!.id).toBe("acc:ts-service:rp1pz7uyae/kd9w2xp4mz");
    expect(svc!.parentResourceId).toBe("acc:ts-project:rp1pz7uyae");
    expect(svc!.fields).toMatchObject({
      computeSize: "2000/8",
      vcpus: 2,
      haReplicas: "0",
      nodeCount: 1,
      poolerEnabled: true,
      dataTiering: false,
      backupRetentionDays: 21,
      vpcId: "1337",
      environment: "PROD",
      region: "us-east-1",
      metricExporterId: "3f7c1c9a-0d2e-4d76-9a1b-5c8e0f2a7b31",
    });
  });

  it("lists read replica sets from the embedded array", async () => {
    mockFetch(base);
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    const replicas = await client.listResources("ts-read-replica", "acc");
    expect(replicas).toHaveLength(1);
    expect(replicas[0]!.externalId).toBe("rp1pz7uyae/kd9w2xp4mz/alb8jicdpr");
    expect(replicas[0]!.fields["computeSize"]).toBe("1000/4");
  });

  it("lists preview types empty when the plan refuses them", async () => {
    mockFetch({
      ...base,
      "GET /projects/rp1pz7uyae/exporters": new Response('{"code":"FORBIDDEN","message":"plan"}', {
        status: 403,
      }),
      "GET /projects/rp1pz7uyae/allow-lists": new Response('{"code":"FORBIDDEN"}', { status: 403 }),
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    expect(await client.listResources("ts-exporter", "acc")).toEqual([]);
    expect(await client.listResources("ts-allow-list", "acc")).toEqual([]);
  });

  it("surfaces a 401 with its status and a readable message", async () => {
    mockFetch({
      "GET /projects": new Response('{"code":"UNAUTHORIZED","message":"Invalid"}', { status: 401 }),
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "bad" });
    const err = await client.listResources("ts-project", "acc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TigerApiError);
    expect((err as TigerApiError).status).toBe(401);
    expect((err as Error).message).toMatch(/Project settings/);
  });

  it("keeps the initial password from create and builds the connection string from it", async () => {
    const { secrets } = secretsStore();
    const created = { ...SERVICE, status: "QUEUED", initial_password: "p@ss word" };
    const { calls } = mockFetch({ ...base, "POST /projects/rp1pz7uyae/services": created });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" }, { secrets });
    const r = await client.createResource("ts-service", "acc", {
      projectId: "rp1pz7uyae",
      name: "metrics-prod",
      serviceType: "POSTGRES",
      region: "eu-central-1",
      computeSize: "1000/4",
      haReplicas: "1",
      environment: "PROD",
    });
    expect(calls.at(-1)!.body).toEqual({
      name: "metrics-prod",
      addons: [],
      region_code: "eu-central-1",
      cpu_millis: "1000",
      memory_gbs: "4",
      replica_count: 1,
      environment_tag: "PROD",
    });
    const uri = await client.resolveOutput("ts-service", r.id, "connectionString", "acc");
    expect(uri).toBe(
      "postgresql://tsdbadmin:p%40ss%20word@kd9w2xp4mz.abc.tsdb.cloud.timescale.com:32625/tsdb?sslmode=require",
    );
    const pooled = await client.resolveOutput("ts-service", r.id, "poolerConnectionString", "acc");
    expect(pooled).toContain(":33333/tsdb");
  });

  it("explains a missing password instead of returning a URI without one", async () => {
    mockFetch(base);
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" }, secretsStore());
    await expect(
      client.resolveOutput(
        "ts-service",
        "acc:ts-service:rp1pz7uyae/kd9w2xp4mz",
        "connectionString",
        "acc",
      ),
    ).rejects.toThrow(/Set password/);
  });

  it("set-password calls updatePassword and stores the value", async () => {
    const { store, secrets } = secretsStore();
    const { calls } = mockFetch({
      ...base,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/updatePassword": null,
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" }, { secrets });
    await client.executeNoSqlCommand(
      "ts-service",
      "acc:ts-service:rp1pz7uyae/kd9w2xp4mz",
      "acc",
      "set-password",
      [JSON.stringify({ password: "" })],
    );
    const sent = (calls.at(-1)!.body as { password: string }).password;
    expect(sent).toHaveLength(24);
    expect(store.get("acc:ts-service:rp1pz7uyae/kd9w2xp4mz|tsdbadminPassword")).toBe(sent);
  });

  it("applies each edited service field through its own endpoint", async () => {
    const { calls } = mockFetch({
      ...base,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/rename": SERVICE,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/resize": SERVICE,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/setHA": SERVICE,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/disablePooler": { message: "ok" },
      "PUT /projects/rp1pz7uyae/services/kd9w2xp4mz/backup-retention": {
        type: "TIME",
        retention_days: 30,
      },
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    await client.updateResource("ts-service", "acc:ts-service:rp1pz7uyae/kd9w2xp4mz", "acc", {
      name: "renamed",
      computeSize: "4000/16",
      haReplicas: "2",
      syncReplicas: "1",
      poolerEnabled: "false",
      backupRetentionDays: "30",
    });
    const writes = calls
      .filter((c) => c.method !== "GET")
      .map((c) => [c.path.split("/").pop(), c.body]);
    expect(writes).toEqual([
      ["rename", { name: "renamed" }],
      ["resize", { cpu_millis: "4000", memory_gbs: "16" }],
      ["setHA", { replica_count: 2, sync_replica_count: 1 }],
      ["disablePooler", undefined],
      ["backup-retention", { type: "TIME", retention_days: 30 }],
    ]);
  });

  it("refuses a synchronous replica without two HA replicas, and sizes off the list", async () => {
    mockFetch(base);
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    await expect(
      client.updateResource("ts-service", "acc:ts-service:rp1pz7uyae/kd9w2xp4mz", "acc", {
        haReplicas: "1",
        syncReplicas: "1",
      }),
    ).rejects.toThrow(/HA replicas set to 2/);
    await expect(
      client.updateResource("ts-service", "acc:ts-service:rp1pz7uyae/kd9w2xp4mz", "acc", {
        computeSize: "3000/12",
      }),
    ).rejects.toThrow(/compute size/);
  });

  it("pause and resume map to stop and start", async () => {
    const { calls } = mockFetch({
      ...base,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/stop": SERVICE,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/start": SERVICE,
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    await client.invokeAction("ts-service", "acc:ts-service:rp1pz7uyae/kd9w2xp4mz", "pause", "acc");
    await client.invokeAction(
      "ts-service",
      "acc:ts-service:rp1pz7uyae/kd9w2xp4mz",
      "resume",
      "acc",
    );
    expect(calls.map((c) => c.path.split("/").pop())).toEqual(["stop", "start"]);
  });

  it("forks with PITR and carries the parent's password to the fork", async () => {
    const { store, secrets } = secretsStore();
    store.set("acc:ts-service:rp1pz7uyae/kd9w2xp4mz|tsdbadminPassword", "parent-pw");
    const { calls } = mockFetch({
      ...base,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/forkService": {
        ...SERVICE,
        service_id: "fork123456",
        name: "recovery",
      },
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" }, { secrets });
    await client.executeNoSqlCommand(
      "ts-service",
      "acc:ts-service:rp1pz7uyae/kd9w2xp4mz",
      "acc",
      "fork",
      [JSON.stringify({ strategy: "PITR", targetTime: "2026-10-01T00:00:00Z", name: "recovery" })],
    );
    expect(calls.at(-1)!.body).toEqual({
      fork_strategy: "PITR",
      target_time: "2026-10-01T00:00:00Z",
      name: "recovery",
    });
    expect(store.get("acc:ts-service:rp1pz7uyae/fork123456|tsdbadminPassword")).toBe("parent-pw");
  });

  it("pages logs with the cursor and returns them oldest first", async () => {
    let page = 0;
    mockFetch({
      ...base,
      "GET /projects/rp1pz7uyae/services/kd9w2xp4mz/logs": (url: URL) => {
        page++;
        if (page === 1) {
          expect(url.searchParams.get("cursor")).toBeNull();
          return {
            entries: [{ timestamp: "2026-10-06T10:00:02Z", severity: "LOG", message: "two" }],
            last_cursor: "c1",
          };
        }
        expect(url.searchParams.get("cursor")).toBe("c1");
        return {
          entries: [{ timestamp: "2026-10-06T10:00:01Z", severity: "ERROR", message: "one" }],
        };
      },
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    const logs = await client.getLogs("ts-service", "acc:ts-service:rp1pz7uyae/kd9w2xp4mz", "acc", {
      tailLines: 10,
    });
    expect(logs.text.trim().split("\n")).toEqual([
      "2026-10-06 10:00:01  ERROR    one",
      "2026-10-06 10:00:02  LOG      two",
    ]);
  });

  it("derives CPU utilisation from usage and limit series", async () => {
    mockFetch({
      ...base,
      "POST /projects/rp1pz7uyae/services/kd9w2xp4mz/metrics/series": (
        _u: URL,
        init: RequestInit,
      ) => {
        const { metric_name } = JSON.parse(String(init.body)) as { metric_name: string };
        const v =
          metric_name === "timescale_cloud_system_cpu_usage_millicores"
            ? 500
            : metric_name === "timescale_cloud_system_cpu_total_millicores"
              ? 2000
              : 1;
        return [
          {
            labels: {},
            data: [
              { time: "2026-10-06T10:00:00Z", value: v },
              { time: "2026-10-06T10:01:00Z", value: null },
            ],
          },
        ];
      },
    });
    const client = new TimescaleClient({ accessKey: "pub", secretKey: "sec" });
    const series = await client.fetchMetricSeries(
      "ts-service",
      "acc:ts-service:rp1pz7uyae/kd9w2xp4mz",
      "acc",
    );
    const cpu = series.find((s) => s.label === "CPU utilization");
    expect(cpu?.points).toEqual([{ timestamp: Date.parse("2026-10-06T10:00:00Z"), value: 25 }]);
    expect(series.find((s) => s.label === "Connections")?.points).toHaveLength(1);
  });
});

describe("exporter bodies", () => {
  it("builds a CloudWatch metrics exporter with an IAM role", () => {
    expect(
      exporterCreateBody({
        name: "cw",
        type: "CLOUDWATCH_METRICS",
        region: "us-east-1",
        namespace: "Tiger",
        logGroup: "g",
        logStream: "s",
        awsRegion: "us-east-1",
        awsAuth: "IAM_ROLE",
        roleArn: "arn:aws:iam::123456789012:role/x",
        includePgMetrics: "true",
      }),
    ).toEqual({
      name: "cw",
      type: "CLOUDWATCH_METRICS",
      region_code: "us-east-1",
      config: {
        log_group_name: "g",
        log_stream_name: "s",
        aws_region: "us-east-1",
        credentials: { type: "IAM_ROLE", aws_role_arn: "arn:aws:iam::123456789012:role/x" },
        namespace: "Tiger",
        include_pg_metrics: true,
      },
    });
  });

  it("rebuilds a full config on update and keeps omitted secrets", () => {
    expect(
      configUpdateFrom(
        {
          exporter_id: "e",
          type: "DATADOG_METRICS",
          config: { site: "datadoghq.eu", include_pg_metrics: true },
        },
        {},
      ),
    ).toEqual({ site: "datadoghq.eu", include_pg_metrics: true });
    expect(
      configUpdateFrom(
        {
          exporter_id: "e",
          type: "CLOUDWATCH_LOGS",
          config: {
            log_group_name: "g",
            log_stream_name: "s",
            aws_region: "eu-west-1",
            credentials: { type: "ACCESS_KEY", aws_access_key: "AKIA" },
          },
        },
        {},
      ),
    ).toEqual({
      log_group_name: "g",
      log_stream_name: "s",
      aws_region: "eu-west-1",
      credentials: { type: "ACCESS_KEY" },
    });
  });
});
