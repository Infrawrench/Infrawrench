import { describe, expect, it, vi } from "vitest";
import {
  capacityDeclarations,
  resolveCapacityLimit,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import type { GcpClientContext } from "../shared.js";
import { fetchMetricSeries } from "../monitoring-client.js";
import { plugin } from "../plugin.js";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers/shared.js";

const ACCT = "acct1";
const PROJ = "proj1";

function listerCtx(opts: {
  get?: (url: string) => unknown;
  paginate?: (url: string) => unknown[];
}): ListerContext {
  return {
    get: vi.fn(async (url: string) => {
      const out = opts.get ? opts.get(url) : {};
      if (out instanceof Error) throw out;
      return out;
    }) as ListerContext["get"],
    paginate: vi.fn(async (url: string) =>
      opts.paginate ? opts.paginate(url) : [],
    ) as ListerContext["paginate"],
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

function typeOf(id: string) {
  const type = plugin.resourceTypes.find((t) => t.id === id);
  if (!type) throw new Error(`no type ${id}`);
  return type;
}

/** The limit each declaration resolves to against a listed resource's fields. */
function limits(row: ResourceInstance): Record<string, number | null> {
  const values = { ...row.resolvedOutputs, ...row.fields };
  return Object.fromEntries(
    capacityDeclarations(typeOf(row.resourceTypeId)).map((d) => [
      d.key,
      resolveCapacityLimit(d.declaration.limit, values)?.limit ?? null,
    ]),
  );
}

describe("Cloud SQL", () => {
  it("stores the max_connections flag and resolves PostgreSQL connections against it", async () => {
    const ctx = listerCtx({
      paginate: () => [
        {
          name: "pg",
          databaseVersion: "POSTGRES_16",
          region: "us-central1",
          state: "RUNNABLE",
          settings: {
            tier: "db-custom-2-7680",
            databaseFlags: [
              { name: "log_min_duration_statement", value: "500" },
              { name: "max_connections", value: "400" },
            ],
          },
        },
        { name: "mysql", databaseVersion: "MYSQL_8_0", settings: { tier: "db-f1-micro" } },
      ],
    });
    const [pg, mysql] = await listers.listCloudSqlInstances(ctx, ACCT, PROJ);
    expect(pg!.fields["maxConnections"]).toBe(400);
    expect(limits(pg!)["metric:PostgreSQL Connections"]).toBe(400);
    // On the engine default the instance reports no number, so no row.
    expect(mysql!.fields["maxConnections"]).toBeUndefined();
    expect(limits(mysql!)["metric:PostgreSQL Connections"]).toBeNull();
  });
});

describe("GKE", () => {
  it("sums per-zone and pool-wide autoscaler maximums", async () => {
    const ctx = listerCtx({
      get: () => ({
        clusters: [
          {
            name: "prod",
            location: "us-central1",
            locations: ["us-central1-a", "us-central1-b", "us-central1-c"],
            nodePools: [
              // Per zone, over the cluster's three zones: 3 * 5.
              { name: "default", autoscaling: { enabled: true, minNodeCount: 1, maxNodeCount: 5 } },
              // Its own two zones: 2 * 4.
              {
                name: "gpu",
                locations: ["us-central1-a", "us-central1-b"],
                autoscaling: { enabled: true, maxNodeCount: 4 },
              },
              // Pool-wide.
              { name: "batch", autoscaling: { enabled: true, totalMaxNodeCount: 20 } },
            ],
          },
          {
            name: "fixed",
            location: "us-east1-b",
            nodePools: [{ name: "default", initialNodeCount: 3 }],
          },
          { name: "auto", location: "europe-west1", autopilot: { enabled: true }, nodePools: [] },
        ],
      }),
    });
    const [prod, fixed, auto] = await listers.listGkeClusters(ctx, ACCT, PROJ);
    expect(prod!.fields["maxNodeCount"]).toBe(15 + 8 + 20);
    expect(limits(prod!)["metric:Node Count"]).toBe(43);
    expect(fixed!.fields["maxNodeCount"]).toBeUndefined();
    expect(auto!.fields["maxNodeCount"]).toBeUndefined();
  });

  it("states no ceiling when node auto-provisioning can add pools", () => {
    expect(
      listers.gkeAutoscalerMaxNodes({
        autoscaling: { enableNodeAutoprovisioning: true },
        nodePools: [{ autoscaling: { enabled: true, maxNodeCount: 3 } }],
      }),
    ).toBeUndefined();
  });
});

describe("Cloud Run", () => {
  it("takes the lower of the service and revision maximums", () => {
    expect(
      listers.cloudRunMaxInstances({
        scaling: { maxInstanceCount: 50 },
        template: { scaling: { maxInstanceCount: 100 } },
      }),
    ).toBe(50);
    expect(listers.cloudRunMaxInstances({ template: { scaling: { maxInstanceCount: 100 } } })).toBe(
      100,
    );
    expect(
      listers.cloudRunMaxInstances({
        scaling: { scalingMode: "MANUAL", manualInstanceCount: 3 },
        template: { scaling: { maxInstanceCount: 100 } },
      }),
    ).toBeUndefined();
  });

  it("stores it on the listed service and resolves the instance count against it", async () => {
    const ctx = listerCtx({
      paginate: () => [
        {
          name: "projects/proj1/locations/us-central1/services/api",
          template: { scaling: { maxInstanceCount: 20 }, containers: [{ image: "img" }] },
        },
      ],
    });
    const [svc] = await listers.listCloudRunServices(ctx, ACCT, PROJ);
    expect(svc!.fields["maxInstances"]).toBe(20);
    expect(limits(svc!)["metric:Container Instances"]).toBe(20);
    expect(limits(svc!)["metric:Memory Utilization (p95)"]).toBe(100);
  });

  it("resolves a function's instance count against its max instances", async () => {
    const ctx = listerCtx({
      paginate: () => [
        {
          name: "projects/proj1/locations/us-central1/functions/hook",
          serviceConfig: { maxInstanceCount: 30 },
        },
        {
          name: "projects/proj1/locations/us-central1/functions/open",
          serviceConfig: { maxInstanceCount: 0 },
        },
      ],
    });
    const [hook, open] = await listers.listCloudFunctions(ctx, ACCT, PROJ);
    expect(limits(hook!)["metric:Container Instances"]).toBe(30);
    expect(limits(open!)["metric:Container Instances"]).toBeNull();
  });
});

describe("Pub/Sub subscription", () => {
  it("stores the retention in seconds for the backlog age to run out against", async () => {
    const ctx = listerCtx({
      paginate: () => [
        {
          name: "projects/proj1/subscriptions/orders",
          topic: "projects/proj1/topics/orders",
          ackDeadlineSeconds: 10,
          messageRetentionDuration: "604800s",
        },
        { name: "projects/proj1/subscriptions/bare", topic: "projects/proj1/topics/orders" },
      ],
    });
    const [orders, bare] = await listers.listPubSubSubscriptions(ctx, ACCT, PROJ);
    expect(orders!.fields["messageRetentionSeconds"]).toBe(604800);
    expect(limits(orders!)["metric:Oldest Unacked Age"]).toBe(604800);
    expect(bare!.fields["messageRetentionSeconds"]).toBeUndefined();
  });
});

describe("Cloud NAT", () => {
  it("derives the ports each VM gets", () => {
    expect(listers.natPortsPerVm({})).toBe(64);
    expect(listers.natPortsPerVm({ minPortsPerVm: 1000 })).toBe(1024);
    expect(listers.natPortsPerVm({ minPortsPerVm: 4096 })).toBe(4096);
    expect(listers.natPortsPerVm({ enableDynamicPortAllocation: true })).toBe(65536);
    expect(
      listers.natPortsPerVm({
        enableDynamicPortAllocation: true,
        minPortsPerVm: 32,
        maxPortsPerVm: 2048,
      }),
    ).toBe(2048);
  });

  it("stores it on the listed NAT and resolves port usage against it", async () => {
    const ctx = listerCtx({
      get: () => ({
        items: {
          "regions/us-central1": {
            routers: [
              {
                name: "r1",
                region: "https://x/regions/us-central1",
                nats: [{ name: "nat1", minPortsPerVm: 128 }],
              },
            ],
          },
        },
      }),
    });
    const [nat] = await listers.listCloudNats(ctx, ACCT, PROJ);
    expect(nat!.fields["portsPerVm"]).toBe(128);
    expect(limits(nat!)["metric:Port usage (max per VM)"]).toBe(128);
  });
});

describe("instance groups", () => {
  const groups = {
    items: {
      "zones/us-central1-a": {
        instanceGroupManagers: [
          { name: "web", zone: "https://x/zones/us-central1-a", targetSize: 6 },
          { name: "off", zone: "https://x/zones/us-central1-a", targetSize: 2 },
        ],
      },
      "regions/us-east1": {
        instanceGroupManagers: [
          { name: "api", region: "https://x/regions/us-east1", targetSize: 3 },
        ],
      },
    },
  };
  const autoscalers = {
    items: {
      "zones/us-central1-a": {
        autoscalers: [
          {
            name: "web-as",
            target:
              "https://www.googleapis.com/compute/v1/projects/proj1/zones/us-central1-a/instanceGroupManagers/web",
            autoscalingPolicy: { minNumReplicas: 2, maxNumReplicas: 10, mode: "ON" },
          },
          {
            name: "off-as",
            target:
              "https://www.googleapis.com/compute/v1/projects/proj1/zones/us-central1-a/instanceGroupManagers/off",
            autoscalingPolicy: { maxNumReplicas: 10, mode: "OFF" },
          },
        ],
      },
      "regions/us-east1": {
        autoscalers: [
          {
            name: "api-as",
            target:
              "https://www.googleapis.com/compute/v1/projects/proj1/regions/us-east1/instanceGroupManagers/api",
            autoscalingPolicy: { maxNumReplicas: 5 },
          },
        ],
      },
    },
  };

  it("reads each group's autoscaler maximum from one aggregated call", async () => {
    const ctx = listerCtx({
      get: (url) => (url.includes("/aggregated/autoscalers") ? autoscalers : groups),
    });
    const rows = await listers.listInstanceGroups(ctx, ACCT, PROJ);
    const byName = Object.fromEntries(rows.map((r) => [r.fields["name"], r]));
    expect(byName["web"]!.fields["autoscalerMaxSize"]).toBe(10);
    expect(limits(byName["web"]!)["targetSize"]).toBe(10);
    expect(byName["api"]!.fields["autoscalerMaxSize"]).toBe(5);
    // An autoscaler switched off leaves the group at a fixed size.
    expect(byName["off"]!.fields["autoscalerMaxSize"]).toBeUndefined();
  });

  it("still lists every group when the autoscaler call fails", async () => {
    const ctx = listerCtx({
      get: (url) => (url.includes("/aggregated/autoscalers") ? new Error("403") : groups),
    });
    const rows = await listers.listInstanceGroups(ctx, ACCT, PROJ);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.fields["autoscalerMaxSize"] === undefined)).toBe(true);
  });
});

function metricsCtx(fields: ResourceInstance["fields"], values: (metric: string) => number[]) {
  const filters: string[] = [];
  const get = vi.fn(async (url: string) => {
    const filter = new URL(url).searchParams.get("filter") ?? "";
    filters.push(filter);
    const metric = /metric\.type="([^"]+)"/.exec(filter)?.[1] ?? "";
    // Newest first, one minute apart, as Cloud Monitoring returns them.
    const points = values(metric)
      .map((v, i) => ({
        interval: { endTime: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() },
        value: { doubleValue: v },
      }))
      .reverse();
    return { timeSeries: points.length > 0 ? [{ points }] : [] };
  });
  const ctx = {
    project: "proj",
    get,
    getResource: vi.fn(async () => ({ fields, resolvedOutputs: {}, externalId: "ext" })),
  } as unknown as GcpClientContext;
  return { ctx, filters };
}

describe("usage over a limit series", () => {
  it("charts Cloud SQL disk against its auto-increase limit, dropping unset instants", async () => {
    const { ctx } = metricsCtx({ name: "db" }, (metric) => {
      if (metric.endsWith("disk/bytes_used")) return [50, 60, 70];
      if (metric.endsWith("disk/storage_auto_increase_limit")) return [200, 0, 280];
      return [];
    });
    const series = await fetchMetricSeries(ctx, "cloudsql-instance", "rid", "acct");
    const limited = series.find((s) => s.label === "Disk Used of Auto-Increase Limit")!;
    expect(limited.unit).toBe("%");
    expect(limited.points.map((p) => p.value)).toEqual([25, 25]);
  });

  it("yields no series when the limit is never set", async () => {
    const { ctx } = metricsCtx({ name: "db" }, (metric) =>
      metric.endsWith("disk/bytes_used") ? [50] : metric.endsWith("increase_limit") ? [0] : [],
    );
    const series = await fetchMetricSeries(ctx, "cloudsql-instance", "rid", "acct");
    expect(series.map((s) => s.label)).toEqual(["Disk Used"]);
  });

  it("compares AlloyDB's mean connections per node with the per-node limit", async () => {
    const { ctx } = metricsCtx({ name: "primary" }, (metric) => {
      if (metric.endsWith("postgres/average_connections")) return [250];
      if (metric.endsWith("postgres/connections_limit")) return [1000];
      return [];
    });
    const series = await fetchMetricSeries(ctx, "alloydb-instance", "rid", "acct");
    expect(series.find((s) => s.label === "Connections Used (per node)")!.points[0]!.value).toBe(
      25,
    );
  });

  it("reads the fullest Ops Agent partition, skipping loop devices", async () => {
    const { ctx, filters } = metricsCtx({ name: "vm", numericId: "42" }, (metric) =>
      metric === "agent.googleapis.com/disk/percent_used" ? [81.5] : [],
    );
    const series = await fetchMetricSeries(ctx, "gce-instance", "rid", "acct");
    expect(series.find((s) => s.label === "Disk Used (fullest volume)")!.points[0]!.value).toBe(
      81.5,
    );
    const filter = filters.find((f) => f.includes("disk/percent_used"))!;
    expect(filter).toContain('metric.labels.state="used"');
    expect(filter).toContain('metric.labels.device!=starts_with("/dev/loop")');
    expect(filter).toContain('resource.labels.instance_id="42"');
  });
});

describe("capacity declarations", () => {
  it("name only series the type's metric plan emits", async () => {
    const fields = {
      name: "thing",
      numericId: "123",
      region: "us-central1",
      location: "us-central1",
    };
    for (const type of plugin.resourceTypes) {
      const declared = (type.capacityMetrics ?? []).map((m) => m.seriesLabel);
      if (declared.length === 0) continue;
      const { ctx } = metricsCtx(fields, () => [1, 2]);
      const emitted = (await fetchMetricSeries(ctx, type.id, "rid", "acct")).map((s) => s.label);
      for (const label of declared) expect(emitted, `${type.id}: ${label}`).toContain(label);
    }
  });

  it("put a usage only on the types listed here", () => {
    const declaring = plugin.resourceTypes
      .filter((t) => capacityDeclarations(t).length > 0)
      .map((t) => t.id)
      .sort();
    expect(declaring).toEqual(
      [
        "alloydb-instance",
        "bigtable-instance",
        "cloud-function",
        "cloud-nat",
        "cloud-run-service",
        "cloudsql-instance",
        "composer-environment",
        "filestore-instance",
        "gce-instance",
        "gke-cluster",
        "instance-group",
        "memorystore-redis",
        "memorystore-valkey",
        "pubsub-subscription",
        "spanner-instance",
      ].sort(),
    );
  });
});
