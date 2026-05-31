import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gcpGetCreateConfig, gcpCreateResource } from "../create-handlers.js";
import type { GcpCreateContext } from "../create-context.js";

type CtxOver = Partial<Omit<GcpCreateContext, "get" | "paginate">> & {
  get?: (url: string) => Promise<unknown>;
  paginate?: (baseUrl: string, key: string, params?: Record<string, string>) => Promise<unknown[]>;
};

function ctx(over: CtxOver = {}): GcpCreateContext {
  return {
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => []),
    token: vi.fn(async () => "tok"),
    project: "proj",
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
    machineTypeSpecCache: new Map(),
    ...(over as Partial<GcpCreateContext>),
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

function ok(body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
}
function err(status = 500, body = "boom"): Response {
  return new Response(body, { status });
}
function lastBody(): Record<string, unknown> {
  const init = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]![1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("dns create", () => {
  it("zone config has name/dnsName fields", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "cloud-dns-zone");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "dnsName", "description"]);
  });

  it("record-set config lists zones when no parent, hides when parent", async () => {
    const c = ctx({
      paginate: vi.fn(async () => [{ name: "z1", dnsName: "ex.com." }]),
    });
    const cfg = await gcpGetCreateConfig(c, "cloud-dns-record-set");
    const zoneField = cfg.fields.find((f) => f.key === "managedZone");
    expect((zoneField as { options?: unknown[] }).options).toHaveLength(1);
    const withParent = await gcpGetCreateConfig(
      ctx(),
      "cloud-dns-record-set",
      "acct:cloud-dns-zone:z1",
    );
    expect(withParent.fields.find((f) => f.key === "managedZone")).toBeUndefined();
  });

  it("creates zone with nameservers", async () => {
    fetchSpy.mockResolvedValue(ok({ nameServers: ["ns1", "ns2"], creationTime: "2026" }));
    const out = await gcpCreateResource(ctx(), "cloud-dns-zone", "acct", {
      name: "z1",
      dnsName: "ex.com.",
    });
    expect(out.fields.nameservers).toBe("ns1, ns2");
    expect(out.resolvedOutputs.nameservers).toBe("ns1, ns2");
    expect(out.createdAt).toBe("2026");
  });

  it("creates record-set, recovers zone from parent", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(
      ctx(),
      "cloud-dns-record-set",
      "acct",
      { name: "www.ex.com.", type: "A", rrdatas: "1.2.3.4, 5.6.7.8", ttl: "60" },
      "acct:cloud-dns-zone:z1",
    );
    expect(out.fields.zoneName).toBe("z1");
    expect(out.fields.name).toBe("www.ex.com");
    expect(lastBody().additions).toEqual([
      { name: "www.ex.com.", type: "A", ttl: 60, rrdatas: ["1.2.3.4", "5.6.7.8"] },
    ]);
  });

  it("record-set throws without zone", async () => {
    await expect(gcpCreateResource(ctx(), "cloud-dns-record-set", "acct", {})).rejects.toThrow(
      "requires a managed zone",
    );
  });

  it("zone throws on API error", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "cloud-dns-zone", "acct", {})).rejects.toThrow(
      "Cloud DNS API 500",
    );
  });
});

describe("alloydb create", () => {
  it("cluster + instance configs", async () => {
    expect((await gcpGetCreateConfig(ctx(), "alloydb-cluster")).fields[0]!.key).toBe("clusterId");
    expect((await gcpGetCreateConfig(ctx(), "alloydb-instance")).fields[0]!.key).toBe("instanceId");
  });

  it("creates cluster with network path + secret state", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "alloydb-cluster", "acct", {
      clusterId: "c1",
      location: "us-central1",
      network: "projects/proj/global/networks/vpc1",
      rootPassword: "pw",
    });
    expect(lastBody().network).toBe("projects/proj/global/networks/vpc1");
    expect(out.secretStates[0]).toEqual({
      fieldKey: "rootPassword",
      resolution: { kind: "plaintext", value: "pw" },
    });
  });

  it("cluster falls back to bare network name", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "alloydb-cluster", "acct", {
      clusterId: "c1",
      location: "us-central1",
      network: "vpc1",
      rootPassword: "pw",
    });
    expect(lastBody().network).toBe("projects/proj/global/networks/vpc1");
  });

  it("instance requires parent + valid ref", async () => {
    await expect(
      gcpCreateResource(ctx(), "alloydb-instance", "acct", { instanceId: "i1" }),
    ).rejects.toThrow("requires a parent cluster");
    await expect(
      gcpCreateResource(
        ctx(),
        "alloydb-instance",
        "acct",
        { instanceId: "i1" },
        "acct:alloydb-cluster:bad",
      ),
    ).rejects.toThrow("Invalid AlloyDB cluster reference");
  });

  it("creates instance under parent cluster", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const parent = "acct:alloydb-cluster:projects/proj/locations/us-central1/clusters/c1";
    const out = await gcpCreateResource(
      ctx(),
      "alloydb-instance",
      "acct",
      { instanceId: "i1", instanceType: "READ_POOL", cpuCount: "4" },
      parent,
    );
    expect(out.parentResourceId).toBe(parent);
    expect(lastBody().machineConfig).toEqual({ cpuCount: 4 });
    expect(out.fields.cpuCount).toBe(4);
  });
});

describe("memorystore create", () => {
  it("redis + memcached configs", async () => {
    expect((await gcpGetCreateConfig(ctx(), "memorystore-redis")).fields[0]!.key).toBe("name");
    expect((await gcpGetCreateConfig(ctx(), "memorystore-memcached")).fields[0]!.key).toBe("name");
  });

  it("creates redis", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "memorystore-redis", "acct", {
      name: "r1",
      location: "us-central1",
      tier: "STANDARD_HA",
      memorySizeGb: "5",
    });
    expect(lastBody()).toEqual({ tier: "STANDARD_HA", memorySizeGb: 5 });
    expect(out.resolvedOutputs.port).toBe("6379");
  });

  it("creates memcached", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "memorystore-memcached", "acct", {
      name: "m1",
      location: "us-east1",
      nodeCount: "2",
      cpuCount: "2",
      memorySizeMb: "2048",
    });
    expect(lastBody()).toEqual({
      nodeCount: 2,
      nodeConfig: { cpuCount: 2, memorySizeMb: 2048 },
      memcacheVersion: "MEMCACHE_1_5",
    });
    expect(out.externalId).toBe("proj/us-east1/m1");
  });

  it("redis + memcached error branches", async () => {
    fetchSpy.mockImplementation(async () => err());
    await expect(gcpCreateResource(ctx(), "memorystore-redis", "acct", {})).rejects.toThrow(
      "Memorystore Redis API 500",
    );
    await expect(gcpCreateResource(ctx(), "memorystore-memcached", "acct", {})).rejects.toThrow(
      "Memorystore Memcached create failed: 500",
    );
  });
});

describe("bigquery create", () => {
  it("dataset + table configs", async () => {
    expect((await gcpGetCreateConfig(ctx(), "bigquery-dataset")).fields[0]!.key).toBe("datasetId");
    expect((await gcpGetCreateConfig(ctx(), "bigquery-table")).fields[1]!.key).toBe("tableId");
  });

  it("creates dataset", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "bigquery-dataset", "acct", {
      datasetId: "ds",
      location: "EU",
    });
    expect(out.externalId).toBe("proj:ds");
    expect(lastBody().datasetReference).toEqual({ projectId: "proj", datasetId: "ds" });
  });

  it("creates table with schema", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "bigquery-table", "acct", {
      datasetId: "ds",
      tableId: "t1",
      description: "d",
      schemaJson: '[{"name":"id","type":"STRING"}]',
      expirationMs: "123",
    });
    expect(out.externalId).toBe("proj:ds/t1");
    const body = lastBody();
    expect(body.schema).toEqual({ fields: [{ name: "id", type: "STRING" }] });
    expect(body.expirationTime).toBe("123");
  });

  it("table validation branches", async () => {
    await expect(
      gcpCreateResource(ctx(), "bigquery-table", "acct", { datasetId: "ds" }),
    ).rejects.toThrow("requires datasetId and tableId");
    await expect(
      gcpCreateResource(ctx(), "bigquery-table", "acct", {
        datasetId: "ds",
        tableId: "t",
        schemaJson: "{not json",
      }),
    ).rejects.toThrow("not valid JSON");
    await expect(
      gcpCreateResource(ctx(), "bigquery-table", "acct", {
        datasetId: "ds",
        tableId: "t",
        schemaJson: '{"a":1}',
      }),
    ).rejects.toThrow("must be an array");
  });

  it("dataset error", async () => {
    fetchSpy.mockResolvedValue(err(403));
    await expect(gcpCreateResource(ctx(), "bigquery-dataset", "acct", {})).rejects.toThrow(
      "BigQuery API 403",
    );
  });
});

describe("bigtable create", () => {
  it("config + production serveNodes", async () => {
    expect((await gcpGetCreateConfig(ctx(), "bigtable-instance")).fields[0]!.key).toBe(
      "instanceId",
    );
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "bigtable-instance", "acct", {
      instanceId: "bt1",
      displayName: "BT",
      instanceType: "PRODUCTION",
      clusterLocation: "us-central1-b",
    });
    const cluster = (lastBody().clusters as Record<string, { serveNodes?: number }>)["bt1-cluster"];
    expect(cluster!.serveNodes).toBe(3);
  });

  it("development omits serveNodes + error", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "bigtable-instance", "acct", {
      instanceId: "bt2",
      displayName: "BT2",
      instanceType: "DEVELOPMENT",
    });
    const cluster = (lastBody().clusters as Record<string, { serveNodes?: number }>)["bt2-cluster"];
    expect(cluster!.serveNodes).toBeUndefined();
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "bigtable-instance", "acct", {})).rejects.toThrow(
      "Bigtable API 500",
    );
  });
});

describe("firestore create", () => {
  it("config", async () => {
    expect((await gcpGetCreateConfig(ctx(), "firestore-database")).fields[0]!.key).toBe("name");
  });

  it("standard datastore mode", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "firestore-database", "acct", {
      name: "db1",
      locationId: "nam5",
      databaseEdition: "STANDARD",
      type: "DATASTORE_MODE",
    });
    expect(lastBody().type).toBe("DATASTORE_MODE");
    expect(out.fields.type).toBe("DATASTORE_MODE");
  });

  it("enterprise native mode flips access modes + default name", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "firestore-database", "acct", {
      name: "(default)",
      locationId: "nam5",
      databaseEdition: "ENTERPRISE",
      enterpriseMode: "native",
    });
    const body = lastBody();
    expect(body.databaseEdition).toBe("ENTERPRISE");
    expect(body.firestoreDataAccessMode).toBe("DATA_ACCESS_MODE_ENABLED");
    expect(out.displayName).toBe("proj (default)");
  });

  it("error", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "firestore-database", "acct", {})).rejects.toThrow(
      "Firestore API 500",
    );
  });
});

describe("cloud-run create", () => {
  it("config uses dynamic regions, falls back on error", async () => {
    const c = ctx({
      get: vi.fn(async () => ({ items: [{ name: "x/us-central1", status: "UP" }] })),
    });
    const cfg = await gcpGetCreateConfig(c, "cloud-run-service");
    expect(
      (cfg.fields.find((f) => f.key === "region") as { regions?: unknown[] }).regions,
    ).toHaveLength(1);
    const c2 = ctx({
      get: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    const cfg2 = await gcpGetCreateConfig(c2, "cloud-run-service");
    expect(
      ((cfg2.fields.find((f) => f.key === "region") as { regions?: unknown[] }).regions ?? [])
        .length,
    ).toBeGreaterThan(1);
  });

  it("creates service with vpc access", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "cloud-run-service", "acct", {
      name: "svc",
      region: "us-central1",
      image: "gcr.io/p/i:1",
      port: "3000",
      network: "vpc1",
    });
    const template = lastBody().template as {
      vpcAccess?: { network: string };
      containers: unknown[];
    };
    expect(template.vpcAccess!.network).toBe("projects/proj/global/networks/vpc1");
    expect(out.externalId).toBe("projects/proj/locations/us-central1/services/svc");
  });

  it("error", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "cloud-run-service", "acct", { name: "s", image: "i" }),
    ).rejects.toThrow("Cloud Run create failed: 500");
  });
});

describe("cloud-armor create", () => {
  it("config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "cloud-armor-policy")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "cloud-armor-policy", "acct", {
      name: "pol",
      type: "CLOUD_ARMOR_EDGE",
    });
    expect(out.externalId).toBe("proj/pol");
    expect(lastBody().type).toBe("CLOUD_ARMOR_EDGE");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "cloud-armor-policy", "acct", {})).rejects.toThrow(
      "Cloud Armor create failed: 500",
    );
  });
});

describe("spanner create", () => {
  it("instance config + create clamps node count", async () => {
    expect((await gcpGetCreateConfig(ctx(), "spanner-instance")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "spanner-instance", "acct", {
      name: "s1",
      displayName: "S1",
      config: "regional-us-central1",
      nodeCount: "-3",
    });
    expect((lastBody().instance as { nodeCount: number }).nodeCount).toBe(1);
    expect(out.displayName).toBe("S1");
  });

  it("database config hides instance with parent", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "spanner-database");
    expect(cfg.fields.find((f) => f.key === "instance")).toBeDefined();
    const withParent = await gcpGetCreateConfig(
      ctx(),
      "spanner-database",
      "acct:spanner-instance:s1",
    );
    expect(withParent.fields.find((f) => f.key === "instance")).toBeUndefined();
  });

  it("database create with ddl + postgres dialect", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(
      ctx(),
      "spanner-database",
      "acct",
      { name: "db1", dialect: "POSTGRESQL", ddl: "CREATE TABLE T (id INT); " },
      "acct:spanner-instance:s1",
    );
    const body = lastBody();
    expect(body.createStatement).toBe('CREATE DATABASE "db1"');
    expect(body.extraStatements).toEqual(["CREATE TABLE T (id INT)"]);
    expect(out.parentResourceId).toBe("acct:spanner-instance:s1");
  });

  it("database requires instance + name", async () => {
    await expect(
      gcpCreateResource(ctx(), "spanner-database", "acct", { name: "db" }),
    ).rejects.toThrow("requires an instance and a name");
  });

  it("backup config + create + validation", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "spanner-backup");
    expect(cfg.fields.some((f) => f.key === "expireTime")).toBe(true);
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(
      ctx(),
      "spanner-backup",
      "acct",
      { name: "b1", database: "db1", expireTime: "2026-06-01T00:00:00Z" },
      "acct:spanner-instance:s1",
    );
    expect(out.externalId).toBe("s1/b1");
    expect(lastBody().database).toBe("projects/proj/instances/s1/databases/db1");
    await expect(
      gcpCreateResource(ctx(), "spanner-backup", "acct", { name: "b1" }),
    ).rejects.toThrow("requires instance, name, source database, and expire time");
  });

  it("error branches", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "spanner-instance", "acct", {})).rejects.toThrow(
      "Spanner API 500",
    );
  });
});

describe("gke create", () => {
  it("config builds locations/sizes/versions + caches specs", async () => {
    const c = ctx({
      get: vi.fn(async (url: string) => {
        if (url.includes("/zones/us-central1-a/machineTypes"))
          return {
            items: [
              { name: "e2-medium", guestCpus: 2, memoryMb: 4096 },
              { name: "custom-1", guestCpus: 1, memoryMb: 1024 },
            ],
          };
        if (url.includes("/zones"))
          return {
            items: [
              { name: "us-central1-a", status: "UP", region: "x/us-central1" },
              { name: "down", status: "DOWN", region: "x/us-east1" },
            ],
          };
        return { defaultClusterVersion: "1.30", validMasterVersions: ["1.30", "1.29"] };
      }),
    });
    const cfg = await gcpGetCreateConfig(c, "gke-cluster");
    const sizes = (cfg.fields.find((f) => f.key === "machineType") as { sizes: unknown[] }).sizes;
    expect(sizes).toHaveLength(1); // custom filtered out
    expect(c.machineTypeSpecCache.get("e2-medium")).toEqual({ guestCpus: 2, memoryMb: 4096 });
  });

  it("creates cluster + error", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "gke-cluster", "acct", {
      name: "k1",
      location: "us-central1",
      version: "1.30",
      machineType: "e2-medium",
      diskSizeGb: "50",
      nodeCount: "2",
      network: "projects/proj/global/networks/vpc1",
    });
    expect(out.fields.nodeCount).toBe(2);
    const cluster = lastBody().cluster as { initialNodeCount: number; network: string };
    expect(cluster.initialNodeCount).toBe(2);
    expect(cluster.network).toBe("projects/proj/global/networks/vpc1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "gke-cluster", "acct", {})).rejects.toThrow(
      "GKE API 500",
    );
  });
});

describe("observability create", () => {
  it("log-sink config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "log-sink")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({ writerIdentity: "sa@x" }));
    const out = await gcpCreateResource(ctx(), "log-sink", "acct", {
      name: "sink1",
      destination: "storage.googleapis.com/b",
    });
    expect(out.fields.writerIdentity).toBe("sa@x");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "log-sink", "acct", {})).rejects.toThrow(
      "Logging API 500",
    );
  });

  it("alert-policy config builds metric/resource options", async () => {
    let call = 0;
    const c = ctx({
      paginate: vi.fn(async () => {
        call++;
        return call === 1
          ? [
              { type: "compute.googleapis.com/instance/cpu/utilization", displayName: "CPU" },
              { type: "" },
            ]
          : [{ type: "gce_instance", displayName: "GCE Instance" }];
      }),
    });
    const cfg = await gcpGetCreateConfig(c, "alert-policy");
    const metricOpts = (cfg.fields.find((f) => f.key === "metricType") as { options: unknown[] })
      .options;
    expect(metricOpts).toHaveLength(1);
  });

  it("alert-policy create + error", async () => {
    fetchSpy.mockResolvedValue(ok({ name: "projects/p/alertPolicies/123" }));
    const out = await gcpCreateResource(ctx(), "alert-policy", "acct", {
      displayName: "Alert",
      conditionDisplayName: "Cond",
      metricType: "m",
      thresholdValue: "0.9",
    });
    expect(out.externalId).toBe("projects/p/alertPolicies/123");
    const cond = (
      lastBody().conditions as Array<{ conditionThreshold: { thresholdValue: number } }>
    )[0];
    expect(cond!.conditionThreshold.thresholdValue).toBe(0.9);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "alert-policy", "acct", {})).rejects.toThrow(
      "Monitoring API 500",
    );
  });
});

describe("storage create", () => {
  it("gcs-bucket config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "gcs-bucket")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(
      ok({ location: "US", storageClass: "STANDARD", timeCreated: "2026" }),
    );
    const out = await gcpCreateResource(ctx(), "gcs-bucket", "acct", { name: "b1" });
    expect(out.resolvedOutputs.endpoint).toBe("https://storage.googleapis.com/b1");
    expect(out.createdAt).toBe("2026");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "gcs-bucket", "acct", {})).rejects.toThrow("GCS API 500");
  });

  it("artifact-registry-repo config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "artifact-registry-repo")).fields[2]!.key).toBe(
      "format",
    );
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "artifact-registry-repo", "acct", {
      name: "repo1",
      location: "us-central1",
      format: "NPM",
    });
    expect(out.externalId).toBe("projects/proj/locations/us-central1/repositories/repo1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "artifact-registry-repo", "acct", {})).rejects.toThrow(
      "Artifact Registry API 500",
    );
  });

  it("filestore-instance config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "filestore-instance")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "filestore-instance", "acct", {
      name: "fs1",
      location: "us-central1-a",
      tier: "BASIC_SSD",
      fileShareName: "vol1",
      capacityGb: "2048",
    });
    expect(out.fields.capacityGb).toBe(2048);
    expect((lastBody().fileShares as Array<{ capacityGb: number }>)[0]!.capacityGb).toBe(2048);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "filestore-instance", "acct", {})).rejects.toThrow(
      "Filestore API 500",
    );
  });
});

describe("tasks-scheduler create", () => {
  it("queue config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "cloud-tasks-queue")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "cloud-tasks-queue", "acct", {
      name: "q1",
      location: "us-central1",
    });
    expect(out.externalId).toBe("projects/proj/locations/us-central1/queues/q1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "cloud-tasks-queue", "acct", {})).rejects.toThrow(
      "Cloud Tasks API 500",
    );
  });

  it("scheduler-job config + create + error", async () => {
    expect(
      (await gcpGetCreateConfig(ctx(), "cloud-scheduler-job")).fields.some(
        (f) => f.key === "schedule",
      ),
    ).toBe(true);
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "cloud-scheduler-job", "acct", {
      name: "j1",
      location: "us-central1",
      schedule: "* * * * *",
      httpUri: "https://x",
    });
    expect((lastBody().httpTarget as { uri: string }).uri).toBe("https://x");
    expect(out.fields.targetUri).toBe("https://x");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "cloud-scheduler-job", "acct", {})).rejects.toThrow(
      "Cloud Scheduler API 500",
    );
  });

  it("workflow config + create + error", async () => {
    expect(
      (await gcpGetCreateConfig(ctx(), "workflow")).fields.some((f) => f.key === "sourceContents"),
    ).toBe(true);
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "workflow", "acct", {
      name: "w1",
      region: "us-central1",
      sourceContents: "main:\n  steps: []",
    });
    expect(out.externalId).toBe("projects/proj/locations/us-central1/workflows/w1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "workflow", "acct", {})).rejects.toThrow(
      "Workflow create failed: 500",
    );
  });
});

describe("security create", () => {
  it("secret-manager config + create without/with initial value", async () => {
    expect((await gcpGetCreateConfig(ctx(), "secret-manager-secret")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "secret-manager-secret", "acct", { name: "s1" });
    expect(out.fields.versionCount).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(ok({}));
    const out2 = await gcpCreateResource(ctx(), "secret-manager-secret", "acct", {
      name: "s2",
      initialValue: "hello",
    });
    expect(out2.fields.versionCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("secret-manager error branches", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "secret-manager-secret", "acct", {})).rejects.toThrow(
      "Secret Manager API 500",
    );
    fetchSpy.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(err());
    await expect(
      gcpCreateResource(ctx(), "secret-manager-secret", "acct", { name: "s", initialValue: "v" }),
    ).rejects.toThrow("Secret Manager API 500");
  });

  it("kms-key-ring config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "kms-key-ring")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "kms-key-ring", "acct", {
      name: "kr1",
      location: "global",
    });
    expect(out.externalId).toBe("projects/proj/locations/global/keyRings/kr1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "kms-key-ring", "acct", {})).rejects.toThrow(
      "KMS API 500",
    );
  });

  it("kms-key config shows ring fields without parent", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "kms-key");
    expect(cfg.fields.some((f) => f.key === "keyRing")).toBe(true);
    const withParent = await gcpGetCreateConfig(
      ctx(),
      "kms-key",
      "acct:kms-key-ring:projects/proj/locations/us-east1/keyRings/kr1",
    );
    expect(withParent.fields.some((f) => f.key === "keyRing")).toBe(false);
  });

  it("kms-key create recovers ring from parent, picks algorithm", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(
      ctx(),
      "kms-key",
      "acct",
      { name: "k1", purpose: "ASYMMETRIC_SIGN" },
      "acct:kms-key-ring:projects/proj/locations/us-east1/keyRings/kr1",
    );
    expect(out.fields.algorithm).toBe("RSA_SIGN_PSS_2048_SHA256");
    expect(out.fields.location).toBe("us-east1");
    expect(out.parentResourceId).toBe(
      "acct:kms-key-ring:projects/proj/locations/us-east1/keyRings/kr1",
    );
  });

  it("kms-key requires a key ring + error", async () => {
    await expect(gcpCreateResource(ctx(), "kms-key", "acct", { name: "k1" })).rejects.toThrow(
      "requires a key ring",
    );
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "kms-key", "acct", { name: "k1", keyRing: "kr1" }),
    ).rejects.toThrow("KMS API 500");
  });

  it("service-account config builds role options", async () => {
    let call = 0;
    const c = ctx({
      paginate: vi.fn(async () => {
        call++;
        return call === 1
          ? [
              { name: "roles/viewer", title: "Viewer", stage: "GA" },
              { name: "roles/old", stage: "DEPRECATED" },
            ]
          : [{ name: "projects/p/roles/custom", title: "Custom", description: "d", stage: "BETA" }];
      }),
    });
    const cfg = await gcpGetCreateConfig(c, "gcp-service-account");
    const policies = (cfg.fields.find((f) => f.key === "grantedRoles") as { policies: unknown[] })
      .policies;
    expect(policies).toHaveLength(2); // deprecated filtered out
  });

  it("service-account create without roles", async () => {
    fetchSpy.mockResolvedValue(ok({ email: "sa@proj.iam.gserviceaccount.com" }));
    const out = await gcpCreateResource(ctx(), "gcp-service-account", "acct", {
      accountId: "sa",
      displayName: "SA",
    });
    expect(out.externalId).toBe("sa@proj.iam.gserviceaccount.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("service-account create with roles modifies IAM policy", async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ email: "sa@proj.iam.gserviceaccount.com" }))
      .mockResolvedValueOnce(
        ok({ bindings: [{ role: "roles/viewer", members: ["user:a"] }], etag: "e" }),
      )
      .mockResolvedValueOnce(ok({}));
    await gcpCreateResource(ctx(), "gcp-service-account", "acct", {
      accountId: "sa",
      grantedRoles: JSON.stringify(["roles/viewer", "roles/editor"]),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const setBody = JSON.parse((fetchSpy.mock.calls[2]![1] as RequestInit).body as string);
    const viewer = setBody.policy.bindings.find((b: { role: string }) => b.role === "roles/viewer");
    expect(viewer.members).toContain("serviceAccount:sa@proj.iam.gserviceaccount.com");
  });

  it("service-account error + bad roles JSON", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "gcp-service-account", "acct", { accountId: "sa" }),
    ).rejects.toThrow("Create service account");
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(ok({ email: "sa@proj.iam.gserviceaccount.com" }));
    const out = await gcpCreateResource(ctx(), "gcp-service-account", "acct", {
      accountId: "sa",
      grantedRoles: "{bad",
    });
    expect(out.externalId).toBe("sa@proj.iam.gserviceaccount.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
