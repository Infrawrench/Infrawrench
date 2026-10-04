import { beforeEach, describe, expect, it } from "vitest";
import { resetAuthCaches } from "../api.js";
import { MongoDBAtlasClient, withCredentials } from "../client.js";
import { parseRoles, rolesToString } from "../mappers.js";
import { processesForCluster } from "../metrics.js";
import { plugin } from "../plugin.js";
import type { Call } from "./helpers.js";
import { CREDS, makeHttp, reply } from "./helpers.js";

beforeEach(() => resetAuthCaches());

const ACCOUNT = "acct";

const cluster = {
  id: "c1",
  name: "main",
  groupId: "g1",
  clusterType: "REPLICASET",
  stateName: "IDLE",
  paused: false,
  mongoDBVersion: "8.0.4",
  backupEnabled: true,
  terminationProtectionEnabled: false,
  connectionStrings: {
    standardSrv: "mongodb+srv://main.ab1cd.mongodb.net",
    standard: "mongodb://main-shard-00-00.ab1cd.mongodb.net:27017",
  },
  replicationSpecs: [
    {
      id: "rs1",
      zoneName: "Zone 1",
      regionConfigs: [
        {
          providerName: "AWS",
          regionName: "US_EAST_1",
          priority: 7,
          electableSpecs: { instanceSize: "M30", nodeCount: 3, diskSizeGB: 40 },
          effectiveElectableSpecs: { instanceSize: "M30", nodeCount: 3, diskSizeGB: 40 },
          readOnlySpecs: { instanceSize: "M30", nodeCount: 0, diskSizeGB: 40 },
          autoScaling: { compute: { enabled: false }, diskGB: { enabled: true } },
        },
      ],
    },
  ],
};

const flexInClusters = {
  name: "flexy",
  replicationSpecs: [{ regionConfigs: [{ providerName: "FLEX", regionName: "US_EAST_1" }] }],
};

function atlas(extra: (call: Call) => unknown = () => undefined) {
  return makeHttp((call) => {
    const p = call.path.split("?")[0]!;
    const custom = extra(call);
    if (custom !== undefined) return custom;
    if (p === "/api/atlas/v2/orgs/org1") return { id: "org1", name: "Acme" };
    if (p === "/api/atlas/v2/orgs/org1/groups")
      return { results: [{ id: "g1", name: "Prod", orgId: "org1" }] };
    if (p === "/api/atlas/v2/groups/g1/clusters") return { results: [cluster, flexInClusters] };
    if (p === "/api/atlas/v2/groups/g1/clusters/main" && call.method === "GET") return cluster;
    if (p === "/api/atlas/v2/groups/g1/clusters/provider/regions") {
      return {
        results: [
          {
            provider: "AWS",
            instanceSizes: [
              { name: "M10", availableRegions: [{ name: "US_EAST_1" }] },
              { name: "M30", availableRegions: [{ name: "US_EAST_1" }] },
              { name: "M40", availableRegions: [{ name: "EU_WEST_1" }] },
            ],
          },
        ],
      };
    }
    return { results: [] };
  });
}

function secretStore() {
  const store = new Map<string, string>();
  return {
    store,
    secrets: {
      async getPlaintext(resourceId: string, fieldKey: string) {
        return store.get(`${resourceId}|${fieldKey}`) ?? null;
      },
      async setPlaintext(resourceId: string, fieldKey: string, value: string) {
        store.set(`${resourceId}|${fieldKey}`, value);
      },
    },
  };
}

describe("listing", () => {
  it("maps dedicated clusters under their project and skips flex entries", async () => {
    const { http } = atlas();
    const client = new MongoDBAtlasClient(CREDS, { http });
    const clusters = await client.listResources("cluster", ACCOUNT);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.id).toBe("acct:cluster:g1/main");
    expect(c.parentResourceId).toBe("acct:project:g1");
    expect(c.fields).toMatchObject({
      instanceSize: "M30",
      provider: "AWS",
      region: "US_EAST_1",
      nodeCount: 3,
      diskSizeGB: 40,
      autoScalingCompute: false,
      autoScalingDisk: true,
      projectName: "Prod",
      vcpus: 2,
      cloudRegion: "us-east-1",
      dedicated: true,
    });
    expect(c.resolvedOutputs["standardSrv"]).toBe("mongodb+srv://main.ab1cd.mongodb.net");
  });

  it("lists the organization with its project count", async () => {
    const { http } = atlas();
    const [org] = await new MongoDBAtlasClient(CREDS, { http }).listResources(
      "organization",
      ACCOUNT,
    );
    expect(org).toMatchObject({ displayName: "Acme", fields: { orgId: "org1", projectCount: 1 } });
  });

  it("lists a project's resources empty when the credential cannot see it", async () => {
    const { http } = atlas((call) =>
      call.path.startsWith("/api/atlas/v2/groups/g1/databaseUsers")
        ? reply({ status: 403, body: {} })
        : undefined,
    );
    const users = await new MongoDBAtlasClient(CREDS, { http }).listResources(
      "database-user",
      ACCOUNT,
    );
    expect(users).toEqual([]);
  });

  it("fetches backup snapshots only for running dedicated clusters with backup on", async () => {
    const { http, calls } = atlas((call) =>
      call.path.startsWith("/api/atlas/v2/groups/g1/clusters/main/backup/snapshots")
        ? {
            results: [
              {
                id: "s1",
                createdAt: "2026-10-01T03:00:00Z",
                status: "completed",
                storageSizeBytes: 1024,
              },
            ],
          }
        : undefined,
    );
    const snaps = await new MongoDBAtlasClient(CREDS, { http }).listResources(
      "backup-snapshot",
      ACCOUNT,
    );
    expect(snaps.map((s) => s.id)).toEqual(["acct:backup-snapshot:g1/main/s1"]);
    expect(snaps[0]!.parentResourceId).toBe("acct:cluster:g1/main");
    expect(calls.some((c) => c.path.includes("/clusters/flexy/"))).toBe(false);
  });
});

describe("cluster detail", () => {
  it("offers only the tiers Atlas sells in the cluster's region", async () => {
    const { http } = atlas();
    const client = new MongoDBAtlasClient(CREDS, { http });
    const r = await client.getResource("cluster", "acct:cluster:g1/main", ACCOUNT);
    const detail = client.renderDetail(r);
    const scale = detail.headerActions?.find((a) => a.label === "Scale tier");
    expect(scale?.action.type).toBe("prompt-nosql-command");
    const fields = scale?.action.type === "prompt-nosql-command" ? scale.action.fields : [];
    expect(fields[0]!.options?.map((o) => o.id)).toEqual(["M10", "M30"]);
    expect(detail.metricsCapability).toBeDefined();
  });
});

describe("cluster writes", () => {
  it("scales every electable and read-only spec in one PATCH without effective fields", async () => {
    const { http, calls } = atlas((call) => (call.method === "PATCH" ? {} : undefined));
    const client = new MongoDBAtlasClient(CREDS, { http });
    await client.executeNoSqlCommand("cluster", "acct:cluster:g1/main", ACCOUNT, "scale-tier", [
      JSON.stringify({ instanceSize: "M40" }),
    ]);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/api/atlas/v2/groups/g1/clusters/main");
    expect(patch.headers["Content-Type"]).toBe("application/vnd.atlas.2024-08-05+json");
    const rc = (
      patch.body as { replicationSpecs: Array<{ regionConfigs: Array<Record<string, unknown>> }> }
    ).replicationSpecs[0]!.regionConfigs[0]!;
    expect(rc["electableSpecs"]).toMatchObject({ instanceSize: "M40", nodeCount: 3 });
    expect(rc["readOnlySpecs"]).toMatchObject({ instanceSize: "M40" });
    expect(rc["effectiveElectableSpecs"]).toBeUndefined();
  });

  it("enables compute auto-scaling with bounds around the current tier", async () => {
    const { http, calls } = atlas((call) => (call.method === "PATCH" ? {} : undefined));
    await new MongoDBAtlasClient(CREDS, { http }).updateResource(
      "cluster",
      "acct:cluster:g1/main",
      ACCOUNT,
      {
        autoScalingCompute: "true",
      },
    );
    const patch = calls.find((c) => c.method === "PATCH")!;
    const rc = (
      patch.body as { replicationSpecs: Array<{ regionConfigs: Array<Record<string, unknown>> }> }
    ).replicationSpecs[0]!.regionConfigs[0]!;
    expect(rc["autoScaling"]).toMatchObject({
      compute: {
        enabled: true,
        minInstanceSize: "M30",
        maxInstanceSize: "M50",
        scaleDownEnabled: true,
      },
    });
  });

  it("pauses and resumes", async () => {
    const { http, calls } = atlas((call) => (call.method === "PATCH" ? {} : undefined));
    const client = new MongoDBAtlasClient(CREDS, { http });
    await client.invokeAction("cluster", "acct:cluster:g1/main", "pause", ACCOUNT);
    await client.invokeAction("cluster", "acct:cluster:g1/main", "resume", ACCOUNT);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
      { paused: true },
      { paused: false },
    ]);
  });

  it("takes an on-demand snapshot with the requested retention", async () => {
    const { http, calls } = atlas((call) => (call.method === "POST" ? { id: "s9" } : undefined));
    await new MongoDBAtlasClient(CREDS, { http }).executeNoSqlCommand(
      "cluster",
      "acct:cluster:g1/main",
      ACCOUNT,
      "take-snapshot",
      [JSON.stringify({ description: "before migration", retentionInDays: "3" })],
    );
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/atlas/v2/groups/g1/clusters/main/backup/snapshots");
    expect(post.body).toEqual({ description: "before migration", retentionInDays: 3 });
  });

  it("adds an IP access entry from the project, as a temporary entry when asked", async () => {
    const { http, calls } = atlas((call) =>
      call.method === "POST"
        ? { results: [{ cidrBlock: "203.0.113.7/32", comment: "vpn" }] }
        : undefined,
    );
    await new MongoDBAtlasClient(CREDS, { http }).executeNoSqlCommand(
      "project",
      "acct:project:g1",
      ACCOUNT,
      "add-ip-access-entry",
      [JSON.stringify({ entry: "203.0.113.7", comment: "vpn", expiresInHours: "6" })],
    );
    const body = calls.find((c) => c.method === "POST")!.body as Array<Record<string, string>>;
    expect(body[0]).toMatchObject({ ipAddress: "203.0.113.7", comment: "vpn" });
    expect(body[0]!["deleteAfterDate"]).toMatch(/Z$/);
  });
});

describe("MongoDB console hand-off", () => {
  it("creates a cluster-scoped connection user and builds the connection string from it", async () => {
    const { http, calls } = atlas((call) => (call.method === "POST" ? {} : undefined));
    const { secrets, store } = secretStore();
    const client = new MongoDBAtlasClient(CREDS, { http, secrets });
    await expect(
      client.resolveOutput("cluster", "acct:cluster:g1/main", "connectionString", ACCOUNT),
    ).rejects.toThrow(/Create connection user/);
    await client.executeNoSqlCommand(
      "cluster",
      "acct:cluster:g1/main",
      ACCOUNT,
      "create-connection-user",
      [JSON.stringify({ role: "readAnyDatabase" })],
    );
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      databaseName: "admin",
      roles: [{ roleName: "readAnyDatabase", databaseName: "admin" }],
      scopes: [{ name: "main", type: "CLUSTER" }],
    });
    const user = store.get("acct:cluster:g1/main|connectionUser")!;
    const password = store.get("acct:cluster:g1/main|connectionPassword")!;
    expect(user).toMatch(/^infrawrench-main-/);
    const uri = await client.resolveOutput(
      "cluster",
      "acct:cluster:g1/main",
      "connectionString",
      ACCOUNT,
    );
    expect(uri).toBe(`mongodb+srv://${user}:${password}@main.ab1cd.mongodb.net/`);
  });

  it("declares the mongodb plugin as the cluster's console", () => {
    const type = plugin.resourceTypes.find((t) => t.id === "cluster")!;
    expect(type.peerIntegrations?.[0]).toMatchObject({
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
    });
  });

  it("injects credentials into SRV strings", () => {
    expect(withCredentials("mongodb+srv://h.example.net", "u@x", "p/w")).toBe(
      "mongodb+srv://u%40x:p%2Fw@h.example.net/",
    );
  });
});

describe("helpers", () => {
  it("round-trips database user roles", () => {
    const roles = [
      { roleName: "readWrite", databaseName: "app" },
      { roleName: "read", databaseName: "logs", collectionName: "events" },
      { roleName: "readAnyDatabase", databaseName: "admin" },
    ];
    expect(parseRoles(rolesToString(roles))).toEqual(roles);
    expect(parseRoles("atlasAdmin")).toEqual([{ roleName: "atlasAdmin", databaseName: "admin" }]);
  });

  it("matches processes to a cluster by SRV label and project subdomain", () => {
    const procs = [
      {
        id: "a:27017",
        userAlias: "main-shard-00-00.ab1cd.mongodb.net",
        typeName: "REPLICA_PRIMARY",
      },
      { id: "b:27017", hostname: "main-shard-00-01.ab1cd.mongodb.net" },
      { id: "c:27017", userAlias: "mainline-shard-00-00.ab1cd.mongodb.net" },
      { id: "d:27017", userAlias: "main-shard-00-00.zz9zz.mongodb.net" },
    ];
    expect(
      processesForCluster(procs, "mongodb+srv://main.ab1cd.mongodb.net").map((p) => p.id),
    ).toEqual(["a:27017", "b:27017"]);
  });
});
