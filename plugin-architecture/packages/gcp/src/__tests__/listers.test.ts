import { describe, it, expect, vi } from "vitest";
import * as listers from "../resource-listers.js";
import { paginateAggregated, type ListerContext } from "../resource-listers/shared.js";

const ACCT = "acct1";
const PROJ = "proj1";

/**
 * Build a ListerContext whose `get`/`paginate` return values are looked up by
 * URL substring. `paginateMap` keys map onto the array each paginate() returns.
 */
function makeCtx(opts: {
  get?: (url: string) => unknown;
  paginate?: (url: string, key: string, params?: Record<string, string>) => unknown[];
}): ListerContext {
  return {
    get: vi.fn(async (url: string) => (opts.get ? opts.get(url) : {})) as ListerContext["get"],
    paginate: vi.fn(async (url: string, key: string, params?: Record<string, string>) =>
      opts.paginate ? opts.paginate(url, key, params) : [],
    ) as ListerContext["paginate"],
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

function aggregated(items: Record<string, unknown[]>): unknown {
  // shape paginateAggregated expects: { items: { scope: { innerKey: [...] } } }
  const inner: Record<string, Record<string, unknown[]>> = {};
  let i = 0;
  for (const [innerKey, arr] of Object.entries(items)) {
    inner[`scope-${i++}`] = { [innerKey]: arr };
  }
  return { items: inner };
}

describe("paginateAggregated", () => {
  it("flattens scoped items and follows nextPageToken", async () => {
    let call = 0;
    const ctx = makeCtx({
      get: () => {
        call++;
        if (call === 1)
          return { items: { "zones/a": { instances: [{ name: "x" }] } }, nextPageToken: "t2" };
        return { items: { "zones/b": { instances: [{ name: "y" }] } } };
      },
    });
    const out = await paginateAggregated<{ name: string }>(ctx, "https://x/agg", "instances");
    expect(out.map((o) => o.name)).toEqual(["x", "y"]);
  });
  it("ignores scopes without the inner array", async () => {
    const ctx = makeCtx({ get: () => ({ items: { "zones/a": { warning: {} } } }) });
    const out = await paginateAggregated(ctx, "https://x/agg", "instances");
    expect(out).toEqual([]);
  });
});

describe("compute listers", () => {
  it("listGceInstances maps fields, IPs, and ssh username", async () => {
    const ctx = makeCtx({
      get: () =>
        aggregated({
          instances: [
            {
              name: "vm1",
              id: "123",
              zone: "https://x/zones/us-central1-a",
              machineType: "https://x/machineTypes/e2-medium",
              status: "RUNNING",
              networkInterfaces: [{ networkIP: "10.0.0.2", accessConfigs: [{ natIP: "1.2.3.4" }] }],
              metadata: { items: [{ key: "ssh-keys", value: "alice:ssh-rsa AAAA\nbob:x" }] },
              creationTimestamp: "2025-01-01T00:00:00Z",
            },
          ],
        }),
    });
    const [r] = await listers.listGceInstances(ctx, ACCT, PROJ);
    expect(r!.fields.name).toBe("vm1");
    expect(r!.fields.zone).toBe("us-central1-a");
    expect(r!.fields.machineType).toBe("e2-medium");
    expect(r!.fields.sshUsername).toBe("alice");
    expect(r!.resolvedOutputs.externalIp).toBe("1.2.3.4");
    expect(r!.resolvedOutputs.internalIp).toBe("10.0.0.2");
    expect(r!.externalId).toBe(`${PROJ}/us-central1-a/vm1`);
  });

  it("listGceDisks maps", async () => {
    const ctx = makeCtx({
      get: () =>
        aggregated({
          disks: [
            {
              name: "d1",
              zone: "https://x/zones/z1",
              type: "https://x/pd-ssd",
              sizeGb: "10",
              status: "READY",
            },
          ],
        }),
    });
    const [r] = await listers.listGceDisks(ctx, ACCT, PROJ);
    expect(r!.fields.type).toBe("pd-ssd");
    expect(r!.fields.sizeGb).toBe(10);
  });

  it("listGkeClusters reads nodePool config", async () => {
    const ctx = makeCtx({
      get: () => ({
        clusters: [
          {
            name: "c1",
            location: "us-central1",
            currentMasterVersion: "1.30",
            endpoint: "1.1.1.1",
            nodePools: [
              { initialNodeCount: 3, config: { machineType: "e2-standard-2", diskSizeGb: 50 } },
            ],
            status: "RUNNING",
          },
        ],
      }),
    });
    const [r] = await listers.listGkeClusters(ctx, ACCT, PROJ);
    expect(r!.fields.nodeCount).toBe(3);
    expect(r!.fields.machineType).toBe("e2-standard-2");
    expect(r!.resolvedOutputs.clusterEndpoint).toBe("1.1.1.1");
  });

  it("listInstanceTemplates picks boot disk", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "tpl1",
          selfLink: "https://x/tpl1",
          properties: {
            machineType: "e2-medium",
            disks: [
              {
                boot: true,
                initializeParams: { sourceImage: "https://x/family/debian-12", diskSizeGb: 20 },
              },
            ],
          },
        },
      ],
    });
    const [r] = await listers.listInstanceTemplates(ctx, ACCT, PROJ);
    expect(r!.fields.sourceImage).toBe("debian-12");
    expect(r!.fields.diskSizeGb).toBe(20);
    expect(r!.resolvedOutputs.selfLink).toBe("https://x/tpl1");
  });

  it("listInstanceGroups derives stable status", async () => {
    const ctx = makeCtx({
      get: () =>
        aggregated({
          instanceGroupManagers: [
            {
              name: "ig1",
              zone: "https://x/zones/z1",
              instanceGroup:
                "https://www.googleapis.com/compute/v1/projects/proj1/zones/z1/instanceGroups/ig1",
              instanceTemplate: "https://x/tpl1",
              targetSize: 2,
              status: { isStable: false },
            },
          ],
        }),
    });
    const [r] = await listers.listInstanceGroups(ctx, ACCT, PROJ);
    expect(r!.fields.status).toBe("UPDATING");
    expect(r!.fields.instanceTemplate).toBe("tpl1");
    expect(r!.resolvedOutputs.selfLink).toContain("/instanceGroups/ig1");
  });

  it("listHealthChecks classifies http/https/tcp", async () => {
    const ctx = makeCtx({
      paginate: () => [
        { name: "hc-http", httpHealthCheck: { port: 8080 } },
        { name: "hc-https", httpsHealthCheck: {} },
        { name: "hc-tcp", tcpHealthCheck: { port: 22 } },
      ],
    });
    const rs = await listers.listHealthChecks(ctx, ACCT, PROJ);
    expect(rs.map((r) => r.fields.type)).toEqual(["HTTP", "HTTPS", "TCP"]);
    expect(rs[0]!.fields.port).toBe(8080);
    expect(rs[1]!.fields.port).toBe(443);
  });

  it("listBackendServices + listForwardingRules", async () => {
    const bsCtx = makeCtx({
      get: () =>
        aggregated({
          backendServices: [
            {
              name: "bs1",
              region: "https://x/regions/us-central1",
              selfLink:
                "https://www.googleapis.com/compute/v1/projects/proj1/regions/us-central1/backendServices/bs1",
              protocol: "HTTP",
              backends: [{}, {}],
              healthChecks: ["x"],
              enableCDN: true,
            },
          ],
        }),
    });
    const [bs] = await listers.listBackendServices(bsCtx, ACCT, PROJ);
    expect(bs!.fields.backendCount).toBe(2);
    expect(bs!.fields.region).toBe("us-central1");
    expect(bs!.externalId).toBe("us-central1/bs1");
    expect(bs!.resolvedOutputs.selfLink).toContain("/regions/us-central1/backendServices/bs1");
    expect(bs!.fields.healthCheckCount).toBe(1);
    expect(bs!.fields.enableCDN).toBe(true);

    const frCtx = makeCtx({
      get: () =>
        aggregated({
          forwardingRules: [{ name: "fr1", IPAddress: "9.9.9.9", target: "https://x/target/t1" }],
        }),
    });
    const [fr] = await listers.listForwardingRules(frCtx, ACCT, PROJ);
    expect(fr!.fields.region).toBe("");
    expect(fr!.fields.target).toBe("t1");
    expect(fr!.resolvedOutputs.IPAddress).toBe("9.9.9.9");
  });
});

describe("database listers", () => {
  it("listCloudSqlInstances picks primary/private IPs and engine", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "db1",
          databaseVersion: "POSTGRES_15",
          region: "us-central1",
          settings: { tier: "db-f1-micro", availabilityType: "ZONAL" },
          state: "RUNNABLE",
          connectionName: "proj:region:db1",
          ipAddresses: [
            { type: "PRIMARY", ipAddress: "1.1.1.1" },
            { type: "PRIVATE", ipAddress: "10.0.0.1" },
          ],
        },
      ],
    });
    const [r] = await listers.listCloudSqlInstances(ctx, ACCT, PROJ);
    expect(r!.fields.publicIpAddress).toBe("1.1.1.1");
    expect(r!.fields.privateIpAddress).toBe("10.0.0.1");
    expect(r!.resolvedOutputs.username).toBe("postgres");
    expect(r!.resolvedOutputs.ipAddress).toBe("1.1.1.1");
  });

  it("listSpannerInstances", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "projects/p/instances/s1",
          displayName: "Spanner 1",
          config: "projects/p/instanceConfigs/regional",
          nodeCount: 1,
          state: "READY",
        },
      ],
    });
    const [r] = await listers.listSpannerInstances(ctx, ACCT, PROJ);
    expect(r!.fields.name).toBe("s1");
    expect(r!.fields.config).toBe("regional");
  });

  it("listSpannerDatabases with instance filter", async () => {
    const ctx = makeCtx({
      paginate: (url) => {
        if (url.includes("/databases"))
          return [
            {
              name: "projects/p/instances/s1/databases/d1",
              state: "READY",
              databaseDialect: "POSTGRESQL",
            },
          ];
        return [];
      },
    });
    const rs = await listers.listSpannerDatabases(ctx, ACCT, PROJ, "s1");
    expect(rs[0]!.fields.dialect).toBe("POSTGRESQL");
    expect(rs[0]!.externalId).toBe("s1/d1");
    expect(rs[0]!.parentResourceId).toBe(`${ACCT}:spanner-instance:s1`);
  });

  it("listSpannerDatabases swallows per-instance errors", async () => {
    const ctx = makeCtx({
      paginate: (url) => {
        if (url.includes("/databases")) throw new Error("403");
        return [];
      },
    });
    const rs = await listers.listSpannerDatabases(ctx, ACCT, PROJ, "s1");
    expect(rs).toEqual([]);
  });

  it("listSpannerBackups discovers instances then backups", async () => {
    const ctx = makeCtx({
      paginate: (url) => {
        if (url.endsWith("/instances")) return [{ name: "projects/p/instances/s1" }];
        if (url.includes("/backups"))
          return [
            {
              name: "projects/p/instances/s1/backups/b1",
              database: "projects/p/instances/s1/databases/d1",
              sizeBytes: "1024",
              backupSchedules: ["projects/p/schedules/sch1"],
            },
          ];
        return [];
      },
    });
    const rs = await listers.listSpannerBackups(ctx, ACCT, PROJ);
    expect(rs[0]!.fields.database).toBe("d1");
    expect(rs[0]!.fields.backupSchedules).toBe("sch1");
  });

  it("listBigtableInstances / listFirestoreDatabases default-name", async () => {
    const bt = makeCtx({
      get: () => ({
        instances: [{ name: "projects/p/instances/bt1", type: "PRODUCTION", state: "READY" }],
      }),
    });
    const [b] = await listers.listBigtableInstances(bt, ACCT, PROJ);
    expect(b!.fields.name).toBe("bt1");

    const fs = makeCtx({
      get: () => ({
        databases: [
          {
            name: "projects/p/databases/(default)",
            locationId: "us",
            type: "FIRESTORE_NATIVE",
            state: "ACTIVE",
          },
        ],
      }),
    });
    const [f] = await listers.listFirestoreDatabases(fs, ACCT, PROJ);
    expect(f!.displayName).toBe(`${PROJ} (default)`);
  });

  it("listMemorystoreRedis + memcached", async () => {
    const redis = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1/instances/r1",
          tier: "BASIC",
          memorySizeGb: 1,
          host: "10.0.0.5",
          port: 6379,
          state: "READY",
        },
      ],
    });
    const [r] = await listers.listMemorystoreRedis(redis, ACCT, PROJ);
    expect(r!.fields.region).toBe("us-central1");
    expect(r!.resolvedOutputs.host).toBe("10.0.0.5");

    const mem = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-east1/instances/m1",
          state: "READY",
          nodeConfig: { cpuCount: 1, memorySizeMb: 1024 },
          discoveryEndpoint: { address: "1.2.3.4", port: "11211" },
        },
      ],
    });
    const [m] = await listers.listMemorystoreMemcached(mem, ACCT, PROJ);
    expect(m!.fields.discoveryEndpoint).toBe("1.2.3.4:11211");
    expect(m!.fields.location).toBe("us-east1");
  });

  it("listAlloyDbClusters + instances", async () => {
    const clusterUrl = "projects/p/locations/us-central1/clusters/cl1";
    const cl = makeCtx({
      paginate: () => [
        { name: clusterUrl, displayName: "Cl1", databaseVersion: "POSTGRES_15", state: "READY" },
      ],
    });
    const [c] = await listers.listAlloyDbClusters(cl, ACCT, PROJ);
    expect(c!.fields.location).toBe("us-central1");

    const inst = makeCtx({
      paginate: (url) => {
        if (url.endsWith("/clusters")) return [{ name: clusterUrl }];
        if (url.includes("/instances"))
          return [
            {
              name: `${clusterUrl}/instances/i1`,
              ipAddress: "10.1.1.1",
              machineConfig: { cpuCount: 2 },
              instanceType: "PRIMARY",
              state: "READY",
            },
          ];
        return [];
      },
    });
    const [i] = await listers.listAlloyDbInstances(inst, ACCT, PROJ);
    expect(i!.fields.cpuCount).toBe(2);
    expect(i!.parentResourceId).toBe(`${ACCT}:alloydb-cluster:${clusterUrl}`);
  });
});

describe("networking listers", () => {
  it("listVpcNetworks default selfLink", async () => {
    const ctx = makeCtx({ paginate: () => [{ name: "vpc1", subnetworks: ["a", "b"] }] });
    const [r] = await listers.listVpcNetworks(ctx, ACCT, PROJ);
    expect(r!.fields.subnetCount).toBe(2);
    expect(r!.resolvedOutputs.selfLink).toContain("/networks/vpc1");
  });

  it("listFirewallRules allow/deny", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "fw-allow",
          network: "https://x/networks/vpc1",
          direction: "INGRESS",
          sourceRanges: ["0.0.0.0/0"],
          allowed: [{ IPProtocol: "tcp", ports: ["22", "80"] }],
        },
        { name: "fw-deny", denied: [{ IPProtocol: "udp" }] },
      ],
    });
    const rs = await listers.listFirewallRules(ctx, ACCT, PROJ);
    expect(rs[0]!.fields.action).toBe("ALLOW");
    expect(rs[0]!.fields.allowed).toBe("tcp:22,80");
    expect(rs[1]!.fields.action).toBe("DENY");
    expect(rs[1]!.fields.denied).toBe("udp");
  });

  it("listSubnets / listStaticIps / listCloudRouters", async () => {
    const sub = makeCtx({
      get: () =>
        aggregated({
          subnetworks: [
            {
              name: "sn1",
              region: "https://x/regions/us-central1",
              network: "https://x/networks/vpc1",
              ipCidrRange: "10.0.0.0/24",
              privateIpGoogleAccess: true,
            },
          ],
        }),
    });
    const [s] = await listers.listSubnets(sub, ACCT, PROJ);
    expect(s!.fields.privateIpGoogleAccess).toBe(true);

    const ip = makeCtx({
      get: () =>
        aggregated({
          addresses: [
            {
              name: "ip1",
              region: "https://x/regions/us-west1",
              address: "8.8.8.8",
              status: "RESERVED",
            },
          ],
        }),
    });
    const [i] = await listers.listStaticIps(ip, ACCT, PROJ);
    expect(i!.resolvedOutputs.address).toBe("8.8.8.8");

    const rt = makeCtx({
      get: () =>
        aggregated({
          routers: [
            {
              name: "rt1",
              region: "https://x/regions/us-central1",
              network: "https://x/networks/vpc1",
              bgp: { asn: 64512 },
              nats: [{}],
            },
          ],
        }),
    });
    const [r] = await listers.listCloudRouters(rt, ACCT, PROJ);
    expect(r!.fields.bgpAsn).toBe(64512);
    expect(r!.fields.natCount).toBe(1);
  });

  it("listCloudNats flattens NATs on routers", async () => {
    const ctx = makeCtx({
      get: () =>
        aggregated({
          routers: [
            {
              name: "rt1",
              region: "https://x/regions/us-central1",
              nats: [{ name: "nat1", natIpAllocateOption: "AUTO_ONLY" }],
            },
            { name: "rt2", region: "https://x/regions/eu" },
          ],
        }),
    });
    const rs = await listers.listCloudNats(ctx, ACCT, PROJ);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.externalId).toBe("us-central1/rt1/nat1");
  });

  it("listSslCertificates managed defaults", async () => {
    const ctx = makeCtx({
      paginate: () => [
        { name: "cert1", managed: { domains: ["a.com", "b.com"], status: "ACTIVE" } },
      ],
    });
    const [r] = await listers.listSslCertificates(ctx, ACCT, PROJ);
    expect(r!.fields.domains).toBe("a.com, b.com");
  });
});

describe("storage listers", () => {
  it("listGcsBuckets passes project param", async () => {
    const ctx = makeCtx({
      paginate: () => [{ name: "bk1", location: "US", versioning: { enabled: true } }],
    });
    const [r] = await listers.listGcsBuckets(ctx, ACCT, PROJ);
    expect(r!.fields.versioning).toBe(true);
    expect(r!.resolvedOutputs.endpoint).toBe("https://storage.googleapis.com/bk1");
    expect(ctx.paginate).toHaveBeenCalledWith(expect.any(String), "items", { project: PROJ });
  });

  it("listArtifactRegistryRepos enumerates locations + size label", async () => {
    const ctx = makeCtx({
      paginate: (url) => {
        if (url.endsWith("/locations")) return [{ locationId: "us" }];
        if (url.includes("/repositories"))
          return [
            {
              name: "projects/p/locations/us/repositories/repo1",
              format: "DOCKER",
              sizeBytes: 2 * 1_073_741_824,
            },
          ];
        return [];
      },
    });
    const [r] = await listers.listArtifactRegistryRepos(ctx, ACCT, PROJ);
    expect(r!.fields.sizeBytes).toBe("2.0 GB");
    expect(r!.fields.location).toBe("us");
  });

  it("listFilestoreInstances", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1-a/instances/fs1",
          tier: "BASIC_HDD",
          state: "READY",
          networks: [{ network: "https://x/networks/vpc1", ipAddresses: ["10.0.0.9"] }],
          fileShares: [{ name: "share1", capacityGb: 1024 }],
        },
      ],
    });
    const [r] = await listers.listFilestoreInstances(ctx, ACCT, PROJ);
    expect(r!.fields.ipAddress).toBe("10.0.0.9");
    expect(r!.fields.network).toBe("vpc1");
    expect(r!.resolvedOutputs.ipAddress).toBe("10.0.0.9");
  });
});

describe("serverless + messaging listers", () => {
  it("listCloudRunServices maps terminalCondition state", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1/services/svc1",
          terminalCondition: { state: "CONDITION_SUCCEEDED" },
          template: { containers: [{ image: "gcr.io/p/img" }] },
          uri: "https://svc",
          traffic: [{ percent: 100 }],
        },
      ],
    });
    const [r] = await listers.listCloudRunServices(ctx, ACCT, PROJ);
    expect(r!.fields.state).toBe("READY");
    expect(r!.fields.image).toBe("gcr.io/p/img");
    expect(r!.resolvedOutputs.url).toBe("https://svc");
  });

  it("listCloudFunctions extracts source + cloud run service", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1/functions/fn1",
          state: "ACTIVE",
          buildConfig: {
            runtime: "nodejs20",
            source: { storageSource: { bucket: "b", object: "o.zip" } },
            entryPoint: "main",
          },
          serviceConfig: {
            service: "projects/p/locations/us-central1/services/fn1-svc",
            uri: "https://fn",
            availableMemory: "256Mi",
          },
          stateMessages: [{ severity: "WARNING", type: "T", message: "m" }],
        },
      ],
    });
    const [r] = await listers.listCloudFunctions(ctx, ACCT, PROJ);
    expect(r!.fields.sourceLocation).toBe("gs://b/o.zip");
    expect(r!.fields.stateMessage).toContain("WARNING");
    expect(r!.resolvedOutputs.cloudRunServiceName).toContain("fn1-svc");
  });

  it("listAppEngineServices builds url + traffic split", async () => {
    const ctx = makeCtx({
      get: () => ({
        services: [
          { id: "default", servingStatus: "SERVING", split: { allocations: { v1: 1 } } },
          { id: "api", split: { allocations: { v2: 0.5, v3: 0.5 } } },
        ],
      }),
    });
    const rs = await listers.listAppEngineServices(ctx, ACCT, PROJ);
    expect(rs[0]!.resolvedOutputs.url).toBe(`https://${PROJ}.appspot.com`);
    expect(rs[1]!.resolvedOutputs.url).toBe(`https://api-dot-${PROJ}.appspot.com`);
    expect(rs[1]!.fields.trafficSplit).toContain("v2: 50%");
  });

  it("listPubSubTopics + subscriptions parent linkage", async () => {
    const topics = makeCtx({ paginate: () => [{ name: `projects/${PROJ}/topics/t1` }] });
    const [t] = await listers.listPubSubTopics(topics, ACCT, PROJ);
    expect(t!.fields.name).toBe("t1");

    const subs = makeCtx({
      paginate: () => [
        { name: `projects/${PROJ}/subscriptions/s1`, topic: `projects/${PROJ}/topics/t1` },
        { name: `projects/${PROJ}/subscriptions/s2`, topic: `projects/other/topics/t9` },
      ],
    });
    const rs = await listers.listPubSubSubscriptions(subs, ACCT, PROJ);
    expect(rs[0]!.parentResourceId).toBe(`${ACCT}:pubsub-topic:projects/${PROJ}/topics/t1`);
    expect(rs[1]!.parentResourceId).toBeUndefined();
  });

  it("listCloudTasksQueues / SchedulerJobs fan out over locations", async () => {
    const tasks = makeCtx({
      get: () => ({
        locations: [{ name: `projects/${PROJ}/locations/us-central1`, locationId: "us-central1" }],
      }),
      paginate: () => [
        {
          name: `projects/${PROJ}/locations/us-central1/queues/q1`,
          state: "RUNNING",
          rateLimits: { maxDispatchesPerSecond: 5 },
        },
      ],
    });
    const rs = await listers.listCloudTasksQueues(tasks, ACCT, PROJ);
    expect(rs[0]!.fields.region).toBe("us-central1");
    expect(rs[0]!.fields.maxDispatchesPerSecond).toBe(5);

    const sched = makeCtx({
      get: () => ({
        locations: [{ name: `projects/${PROJ}/locations/us-central1`, locationId: "us-central1" }],
      }),
      paginate: () => [
        {
          name: `projects/${PROJ}/locations/us-central1/jobs/j1`,
          schedule: "* * * * *",
          pubsubTarget: { topicName: "projects/p/topics/t1" },
          state: "ENABLED",
        },
      ],
    });
    const sj = await listers.listCloudSchedulerJobs(sched, ACCT, PROJ);
    expect(sj[0]!.fields.targetType).toBe("Pub/Sub");
    expect(sj[0]!.fields.targetUri).toBe("t1");
  });

  it("listCloudTasksQueues swallows per-location errors", async () => {
    const ctx = makeCtx({
      get: () => ({ locations: [{ name: "loc1", locationId: "l1" }] }),
      paginate: () => {
        throw new Error("denied");
      },
    });
    expect(await listers.listCloudTasksQueues(ctx, ACCT, PROJ)).toEqual([]);
  });
});

describe("analytics listers", () => {
  it("listBigQueryDatasets hydrates + formats", async () => {
    const ctx = makeCtx({
      paginate: () => [{ datasetReference: { datasetId: "ds1" } }],
      get: () => ({
        location: "US",
        labels: { env: "prod" },
        creationTime: "1700000000000",
        isCaseInsensitive: true,
      }),
    });
    const [r] = await listers.listBigQueryDatasets(ctx, ACCT, PROJ);
    expect(r!.fields.labels).toBe("env=prod");
    expect(r!.fields.isCaseInsensitive).toBe(true);
    expect(r!.fields.creationTime).toContain("2023");
    expect(r!.externalId).toBe(`${PROJ}:ds1`);
  });

  it("listBigQueryDatasets falls back on hydrate error", async () => {
    const ctx = makeCtx({
      paginate: () => [{ datasetReference: { datasetId: "ds1" }, location: "EU" }],
      get: () => {
        throw new Error("403");
      },
    });
    const [r] = await listers.listBigQueryDatasets(ctx, ACCT, PROJ);
    expect(r!.fields.location).toBe("EU");
  });

  it("listBigQueryTables with dataset filter", async () => {
    const ctx = makeCtx({
      paginate: (url) => {
        if (url.endsWith("/tables")) return [{ tableReference: { tableId: "tbl1" } }];
        return [];
      },
      get: () => ({
        type: "TABLE",
        numRows: "100",
        numBytes: "1048576",
        schema: { fields: [{ name: "id", type: "INT64" }] },
        timePartitioning: { type: "DAY", field: "ts" },
        clustering: { fields: ["id"] },
      }),
    });
    const rs = await listers.listBigQueryTables(ctx, ACCT, PROJ, "ds1");
    expect(rs[0]!.fields.numRows).toBe("100");
    expect(rs[0]!.fields.numBytes).toBe("1.00 MB");
    expect(rs[0]!.fields.partitioning).toBe("DAY on ts");
    expect(rs[0]!.fields.clusteringFields).toBe("id");
  });

  it("listDataflowJobs / VertexAiEndpoints / ComposerEnvironments", async () => {
    const df = makeCtx({
      paginate: () => [
        {
          id: "job1",
          name: "myjob",
          location: "us-central1",
          type: "JOB_TYPE_STREAMING",
          currentState: "JOB_STATE_RUNNING",
          jobMetadata: { sdkVersion: { version: "2.0" } },
        },
      ],
    });
    const [d] = await listers.listDataflowJobs(df, ACCT, PROJ);
    expect(d!.fields.sdkVersion).toBe("2.0");
    expect(d!.externalId).toBe("job1");

    const vx = makeCtx({
      paginate: (url) =>
        url.includes("us-central1")
          ? [
              {
                name: "projects/p/locations/us-central1/endpoints/e1",
                displayName: "EP",
                deployedModels: [{}],
                trafficSplit: { e1: 100 },
              },
            ]
          : [],
    });
    const vr = await listers.listVertexAiEndpoints(vx, ACCT, PROJ);
    expect(vr[0]!.fields.deployedModelCount).toBe(1);

    const cp = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1/environments/env1",
          state: "RUNNING",
          config: { airflowUri: "https://airflow", softwareConfig: { imageVersion: "composer-2" } },
        },
      ],
    });
    const [c] = await listers.listComposerEnvironments(cp, ACCT, PROJ);
    expect(c!.resolvedOutputs.airflowUri).toBe("https://airflow");
  });
});

describe("security listers", () => {
  it("listServiceAccounts / CloudArmor / Secrets", async () => {
    const sa = makeCtx({
      paginate: () => [
        {
          name: "projects/p/serviceAccounts/sa1",
          email: "sa@p.iam.gserviceaccount.com",
          disabled: false,
        },
      ],
    });
    const [a] = await listers.listServiceAccounts(sa, ACCT, PROJ);
    expect(a!.externalId).toBe("sa@p.iam.gserviceaccount.com");
    expect(a!.displayName).toBe("sa");

    const ca = makeCtx({ paginate: () => [{ name: "pol1", rules: [{}, {}, {}] }] });
    const [c] = await listers.listCloudArmorPolicies(ca, ACCT, PROJ);
    expect(c!.fields.ruleCount).toBe(3);
    expect(c!.externalId).toBe(`${PROJ}/pol1`);

    const sec = makeCtx({
      paginate: () => [{ name: "projects/p/secrets/s1", replication: { userManaged: {} } }],
    });
    const [s] = await listers.listSecretManagerSecrets(sec, ACCT, PROJ);
    expect(s!.fields.replicationType).toBe("user-managed");
  });

  it("listKmsKeyRings / listKmsKeys nest locations", async () => {
    const kr = makeCtx({
      paginate: (url) => {
        if (url.endsWith("/locations"))
          return [{ name: `projects/${PROJ}/locations/us`, locationId: "us" }];
        if (url.endsWith("/keyRings"))
          return [{ name: `projects/${PROJ}/locations/us/keyRings/kr1` }];
        return [];
      },
    });
    const [r] = await listers.listKmsKeyRings(kr, ACCT, PROJ);
    expect(r!.fields.location).toBe("us");

    const keys = makeCtx({
      paginate: (url) => {
        if (url.endsWith("/locations"))
          return [{ name: `projects/${PROJ}/locations/us`, locationId: "us" }];
        if (url.endsWith("/keyRings"))
          return [{ name: `projects/${PROJ}/locations/us/keyRings/kr1` }];
        if (url.endsWith("/cryptoKeys"))
          return [
            {
              name: `projects/${PROJ}/locations/us/keyRings/kr1/cryptoKeys/k1`,
              purpose: "ENCRYPT_DECRYPT",
              primary: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION", state: "ENABLED" },
            },
          ];
        return [];
      },
    });
    const [k] = await listers.listKmsKeys(keys, ACCT, PROJ);
    expect(k!.fields.keyRing).toBe("kr1");
    expect(k!.fields.algorithm).toBe("GOOGLE_SYMMETRIC_ENCRYPTION");
    expect(k!.parentResourceId).toContain("kms-key-ring");
  });
});

describe("devops + observability listers", () => {
  it("listCloudBuildTriggers github / cloud source", async () => {
    const ctx = makeCtx({
      paginate: (url) =>
        url.includes("locations/us-central1")
          ? [
              {
                id: "tg1",
                github: { owner: "o", name: "r", push: { branch: "main" } },
                filename: "cb.yaml",
              },
            ]
          : [],
    });
    const rs = await listers.listCloudBuildTriggers(ctx, ACCT, PROJ);
    const gh = rs.find((r) => r.fields.triggerType === "GitHub");
    expect(gh!.fields.repoName).toBe("o/r");
    expect(gh!.externalId).toBe("us-central1/tg1");
  });

  it("listCloudDeployPipelines + listWorkflows", async () => {
    const dp = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1/deliveryPipelines/dp1",
          serialPipeline: { stages: [{ targetId: "dev" }, { targetId: "prod" }] },
        },
      ],
    });
    const [d] = await listers.listCloudDeployPipelines(dp, ACCT, PROJ);
    expect(d!.fields.stageCount).toBe(2);
    expect(d!.fields.stages).toBe("dev, prod");

    const wf = makeCtx({
      paginate: () => [
        {
          name: "projects/p/locations/us-central1/workflows/w1",
          state: "ACTIVE",
          serviceAccount: "projects/p/serviceAccounts/sa@x",
        },
      ],
    });
    const [w] = await listers.listWorkflows(wf, ACCT, PROJ);
    expect(w!.fields.serviceAccount).toBe("sa@x");
  });

  it("listLogSinks + listAlertPolicies", async () => {
    const ls = makeCtx({
      get: () => ({
        sinks: [{ name: "sink1", destination: "storage.googleapis.com/b", disabled: true }],
      }),
    });
    const [s] = await listers.listLogSinks(ls, ACCT, PROJ);
    expect(s!.fields.disabled).toBe(true);

    const ap = makeCtx({
      paginate: () => [
        {
          name: "projects/p/alertPolicies/ap1",
          displayName: "High CPU",
          enabled: false,
          conditions: [{}],
          notificationChannels: ["c1", "c2"],
        },
      ],
    });
    const [a] = await listers.listAlertPolicies(ap, ACCT, PROJ);
    expect(a!.fields.enabled).toBe(false);
    expect(a!.fields.conditionCount).toBe(1);
    expect(a!.fields.notificationChannelCount).toBe(2);
  });
});

describe("project lister", () => {
  it("listGcpProjects maps rows and requests only ACTIVE projects", async () => {
    const ctx = makeCtx({
      paginate: () => [
        {
          projectId: "proj1",
          name: "My Project",
          projectNumber: "123456",
          lifecycleState: "ACTIVE",
          createTime: "2025-01-01T00:00:00Z",
        },
        { projectId: "unnamed", lifecycleState: "ACTIVE" },
        { projectId: "gone", name: "Gone", lifecycleState: "DELETE_REQUESTED" },
      ],
    });
    const rs = await listers.listGcpProjects(ctx, ACCT, PROJ);
    expect(ctx.paginate).toHaveBeenCalledWith(
      "https://cloudresourcemanager.googleapis.com/v1/projects",
      "projects",
      { filter: "lifecycleState:ACTIVE" },
    );
    expect(rs.map((r) => r.externalId)).toEqual(["proj1", "unnamed"]);
    const [r] = rs;
    expect(r!.displayName).toBe("My Project");
    expect(r!.fields).toEqual({
      projectId: "proj1",
      name: "My Project",
      projectNumber: "123456",
      state: "ACTIVE",
    });
    expect(r!.resolvedOutputs.projectId).toBe("proj1");
    expect(r!.createdAt).toBe("2025-01-01T00:00:00Z");
    // A project without a name falls back to its projectId.
    expect(rs[1]!.displayName).toBe("unnamed");
  });

  it("listGcpProjects falls back to the credential's project on 403", async () => {
    const ctx = makeCtx({
      paginate: () => {
        throw Object.assign(new Error("GCP API 403 for https://x: forbidden"), { status: 403 });
      },
    });
    const rs = await listers.listGcpProjects(ctx, ACCT, PROJ);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.externalId).toBe(PROJ);
    expect(rs[0]!.fields).toEqual({
      projectId: PROJ,
      name: PROJ,
      projectNumber: "",
      state: "ACTIVE",
    });
  });

  it("listGcpProjects propagates non-403 errors", async () => {
    const ctx = makeCtx({
      paginate: () => {
        throw Object.assign(new Error("GCP API 500 for https://x: boom"), { status: 500 });
      },
    });
    await expect(listers.listGcpProjects(ctx, ACCT, PROJ)).rejects.toThrow("GCP API 500");
  });
});
