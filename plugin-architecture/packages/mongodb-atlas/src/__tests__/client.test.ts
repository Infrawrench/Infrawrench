import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAuthCaches } from "../api.js";
import { MongoDBAtlasClient, withCredentials } from "../client.js";
import { parseRoles, rolesToString } from "../mappers.js";
import { processesForCluster, type AtlasProcess } from "../metrics.js";
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
    const client = hostClient(new MongoDBAtlasClient(CREDS, { http }));
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
    const [org] = await hostClient(new MongoDBAtlasClient(CREDS, { http })).listResources(
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
    const users = await hostClient(new MongoDBAtlasClient(CREDS, { http })).listResources(
      "database-user",
      ACCOUNT,
    );
    expect(users).toEqual([]);
  });

  it("fetches backup snapshots for running dedicated clusters and skips flex entries", async () => {
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
    const snaps = await hostClient(new MongoDBAtlasClient(CREDS, { http })).listResources(
      "backup-snapshot",
      ACCOUNT,
    );
    expect(snaps.map((s) => s.id)).toEqual(["acct:backup-snapshot:g1/main/s1"]);
    expect(snaps[0]!.parentResourceId).toBe("acct:cluster:g1/main");
    expect(calls.some((c) => c.path.includes("/clusters/flexy/"))).toBe(false);
  });
});

describe("a cluster whose children cannot be read", () => {
  const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
  const CHILD_TYPES = ["backup-snapshot", "backup-policy", "search-index", "online-archive"];
  const SNAPSHOTS = "/api/atlas/v2/groups/g1/clusters/main/backup/snapshots";
  const paused = { ...cluster, name: "asleep", paused: true };
  const running = { ...cluster, name: "main" };
  let unread: Array<{ parentResourceIds?: readonly string[] }>;

  beforeEach(() => {
    unread = [];
    Reflect.set(globalThis, UNREAD_HOOK, (part: { parentResourceIds?: readonly string[] }) =>
      unread.push(part),
    );
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  });

  const namedParents = () => unread.flatMap((part) => part.parentResourceIds ?? []);
  const withClusters = (rows: unknown[], extra: (call: Call) => unknown = () => undefined) =>
    atlas((call) =>
      call.path.split("?")[0] === "/api/atlas/v2/groups/g1/clusters"
        ? { results: rows }
        : extra(call),
    );
  const listing = (http: ReturnType<typeof atlas>["http"], type: string) =>
    hostClient(new MongoDBAtlasClient(CREDS, { http })).listResources(type, ACCOUNT);

  it.each(CHILD_TYPES)(
    "keeps the %s rows of a paused cluster and still reads the running one",
    async (type) => {
      const { http, calls } = withClusters([paused, running], (call) =>
        call.path.endsWith("/search/indexes") || call.path.endsWith("/backup/schedule")
          ? type === "backup-policy"
            ? { restoreWindowDays: 7 }
            : []
          : undefined,
      );
      await listing(http, type);
      expect(namedParents()).toEqual(["acct:cluster:g1/asleep"]);
      expect(calls.some((c) => c.path.includes("/clusters/asleep/"))).toBe(false);
      expect(calls.some((c) => c.path.includes("/clusters/main/"))).toBe(true);
    },
  );

  it.each(CHILD_TYPES)("names no cluster for %s when none is paused", async (type) => {
    const { http } = withClusters([running], (call) =>
      call.path.endsWith("/search/indexes")
        ? []
        : call.path.endsWith("/backup/schedule")
          ? { restoreWindowDays: 7 }
          : undefined,
    );
    await listing(http, type);
    expect(unread).toEqual([]);
  });

  it("names a paused free-tier cluster, whose search indexes are read when it runs", async () => {
    const free = {
      ...paused,
      replicationSpecs: [
        {
          regionConfigs: [
            {
              providerName: "TENANT",
              regionName: "US_EAST_1",
              electableSpecs: { instanceSize: "M0" },
            },
          ],
        },
      ],
    };
    const { http } = withClusters([free]);
    expect(await listing(http, "search-index")).toEqual([]);
    expect(namedParents()).toEqual(["acct:cluster:g1/asleep"]);
  });

  it("names a paused cluster whose answer gives no tier", async () => {
    const { http } = withClusters([{ ...paused, replicationSpecs: [] }]);
    await listing(http, "backup-snapshot");
    expect(namedParents()).toEqual(["acct:cluster:g1/asleep"]);
  });

  it("lists a paused cluster's children as none where the host keeps no track", async () => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    const { http } = withClusters([paused]);
    expect(await listing(http, "backup-snapshot")).toEqual([]);
  });

  describe("a refused read", () => {
    const CLUSTERS = "/api/atlas/v2/groups/g1/clusters";
    const USERS = "/api/atlas/v2/groups/g1/databaseUsers";
    const refuse = (status: number) => reply({ status, body: { detail: "refused" } });

    it.each([401, 403])("keeps a project's rows when its list answers %i", async (status) => {
      const { http } = atlas((call) => (call.path.startsWith(USERS) ? refuse(status) : undefined));
      expect(await listing(http, "database-user")).toEqual([]);
      expect(namedParents()).toEqual(["acct:project:g1"]);
    });

    it("reads a 404 on a project's list as a project that is gone", async () => {
      const { http } = atlas((call) => (call.path.startsWith(USERS) ? refuse(404) : undefined));
      expect(await listing(http, "database-user")).toEqual([]);
      expect(unread).toEqual([]);
    });

    it("still fails the type on a server error", async () => {
      const { http } = atlas((call) => (call.path.startsWith(USERS) ? refuse(500) : undefined));
      await expect(listing(http, "database-user")).rejects.toThrow("500");
      expect(unread).toEqual([]);
    });

    it("fails the type when the credential cannot read the project list", async () => {
      const { http } = atlas((call) =>
        call.path.startsWith("/api/atlas/v2/orgs/org1/groups") ? refuse(401) : undefined,
      );
      await expect(listing(http, "database-user")).rejects.toThrow("401");
      expect(unread).toEqual([]);
    });

    it.each([401, 403])("keeps a cluster's rows when its child list answers %i", async (status) => {
      const { http } = withClusters([running], (call) =>
        call.path.startsWith(SNAPSHOTS) ? refuse(status) : undefined,
      );
      expect(await listing(http, "backup-snapshot")).toEqual([]);
      expect(namedParents()).toEqual(["acct:cluster:g1/main"]);
    });

    it("names the project for one refused provider of its endpoint services", async () => {
      const { http } = atlas((call) =>
        call.path.endsWith("/privateEndpoint/AWS/endpointService")
          ? refuse(403)
          : call.path.includes("/endpointService")
            ? []
            : undefined,
      );
      expect(await listing(http, "private-endpoint-service")).toEqual([]);
      expect(namedParents()).toEqual(["acct:project:g1"]);
    });

    it("names a project whose clusters were refused for every type on one client", async () => {
      const { http, calls } = atlas((call) =>
        call.path.split("?")[0] === CLUSTERS ? refuse(403) : undefined,
      );
      const client = hostClient(new MongoDBAtlasClient(CREDS, { http }));
      expect(await client.listResources("cluster", ACCOUNT)).toEqual([]);
      expect(namedParents()).toEqual(["acct:project:g1"]);

      unread = [];
      expect(await client.listResources("backup-snapshot", ACCOUNT)).toEqual([]);
      expect(namedParents()).toEqual(["acct:project:g1"]);
      expect(calls.filter((c) => c.path.split("?")[0] === CLUSTERS)).toHaveLength(1);
    });
  });

  describe("with backups turned off", () => {
    const off = { ...cluster, backupEnabled: false };

    it("lists the snapshots Atlas kept", async () => {
      const { http } = withClusters([off], (call) =>
        call.path.startsWith(SNAPSHOTS)
          ? { results: [{ id: "s1", status: "completed" }] }
          : undefined,
      );
      const snaps = await listing(http, "backup-snapshot");
      expect(snaps.map((s) => s.id)).toEqual(["acct:backup-snapshot:g1/main/s1"]);
      expect(unread).toEqual([]);
    });

    it("reads an empty answer as Atlas having deleted them", async () => {
      const { http } = withClusters([off], (call) =>
        call.path.startsWith(SNAPSHOTS) ? { results: [] } : undefined,
      );
      expect(await listing(http, "backup-snapshot")).toEqual([]);
      expect(unread).toEqual([]);
    });

    it.each([400, 404, 409])("keeps the rows when the route answers %i", async (status) => {
      const { http } = withClusters([off], (call) =>
        call.path.startsWith(SNAPSHOTS)
          ? reply({ status, body: { detail: "no backups", errorCode: "X" } })
          : undefined,
      );
      expect(await listing(http, "backup-snapshot")).toEqual([]);
      expect(namedParents()).toEqual(["acct:cluster:g1/main"]);
    });

    it("still fails the type on a server error", async () => {
      const { http } = withClusters([off], (call) =>
        call.path.startsWith(SNAPSHOTS) ? reply({ status: 500, body: {} }) : undefined,
      );
      await expect(listing(http, "backup-snapshot")).rejects.toThrow("500");
      expect(unread).toEqual([]);
    });

    it("has no backup policy to read or keep", async () => {
      const { http, calls } = withClusters([off]);
      expect(await listing(http, "backup-policy")).toEqual([]);
      expect(unread).toEqual([]);
      expect(calls.some((c) => c.path.endsWith("/backup/schedule"))).toBe(false);
    });
  });
});

describe("a list that cannot be read whole", () => {
  const GROUPS = "/api/atlas/v2/orgs/org1/groups";
  const USERS = "/api/atlas/v2/groups/g1/databaseUsers";
  const fullPage = { results: Array.from({ length: 500 }, (_, i) => ({ id: `g${i}` })) };
  const listing = (http: ReturnType<typeof atlas>["http"], type: string) =>
    hostClient(new MongoDBAtlasClient(CREDS, { http })).listResources(type, ACCOUNT);

  it("throws at the page cap, after exactly 100 full pages of the largest size", async () => {
    const { http, calls } = atlas((call) => (call.path.startsWith(GROUPS) ? fullPage : undefined));
    await expect(listing(http, "project")).rejects.toThrow("has more than Infrawrench reads");
    const pages = calls.filter((c) => c.path.startsWith(GROUPS));
    expect(pages).toHaveLength(100);
    expect(new URL(pages[0]!.url).searchParams.get("itemsPerPage")).toBe("500");
  });

  it("refuses a page whose list key was renamed, on the first page and on a later one", async () => {
    const first = atlas((call) => (call.path.startsWith(USERS) ? { items: [] } : undefined));
    await expect(listing(first.http, "database-user")).rejects.toThrow("is not a list");

    const later = atlas((call) => {
      if (!call.path.startsWith(USERS)) return undefined;
      return new URL(call.url).searchParams.get("pageNum") === "1" ? fullPage : { items: [] };
    });
    await expect(listing(later.http, "database-user")).rejects.toThrow("is not a list");
  });

  it("refuses an empty answer where a list belongs", async () => {
    const { http } = atlas((call) => (call.path.startsWith(USERS) ? reply({}) : undefined));
    await expect(listing(http, "database-user")).rejects.toThrow("is not a list");
  });

  it("refuses an answer that is not an array on the lists with no paging", async () => {
    const endpoints = atlas((call) =>
      call.path.endsWith("/privateEndpoint/AWS/endpointService")
        ? { detail: "not what the document says" }
        : call.path.includes("/endpointService")
          ? []
          : undefined,
    );
    await expect(listing(endpoints.http, "private-endpoint-service")).rejects.toThrow(
      "is not a list",
    );

    const indexes = atlas((call) =>
      call.path.endsWith("/search/indexes") ? { detail: "not what the document says" } : undefined,
    );
    await expect(listing(indexes.http, "search-index")).rejects.toThrow("is not a list");
  });

  it("still lists those two when Atlas answers with the documented array", async () => {
    const { http } = atlas((call) =>
      call.path.endsWith("/search/indexes")
        ? [{ indexID: "i1", name: "default", database: "app", collectionName: "c" }]
        : call.path.includes("/endpointService")
          ? []
          : undefined,
    );
    expect(await listing(http, "search-index")).toHaveLength(1);
    expect(await listing(http, "private-endpoint-service")).toEqual([]);
  });

  it("does not hide a cut-off project list behind the organization's project count", async () => {
    const { http } = atlas((call) => (call.path.startsWith(GROUPS) ? fullPage : undefined));
    await expect(listing(http, "organization")).rejects.toThrow("has more than Infrawrench reads");
  });

  it("does not read a backup schedule answered with no body as a cluster with no policy", async () => {
    const { http } = atlas((call) =>
      call.path.endsWith("/backup/schedule") ? reply({}) : undefined,
    );
    await expect(listing(http, "backup-policy")).rejects.toThrow(/schedule/);
  });
});

describe("snapshots of sharded clusters", () => {
  const CLUSTERS = "/api/atlas/v2/groups/g1/clusters";
  const REPLICA = `${CLUSTERS}/main/backup/snapshots`;
  const SHARDED_LIST = `${REPLICA}/shardedClusters`;
  const SHARDED_ONE = `${REPLICA}/shardedCluster/s1`;
  const snapshot = { id: "s1", type: "shardedCluster", status: "completed" };

  /** Atlas with `main` as this type of cluster, answering `extra` before anything else. */
  function shardedAtlas(extra: (call: Call) => unknown, clusterType = "SHARDED") {
    return atlas((call) => {
      const custom = extra(call);
      if (custom !== undefined) return custom;
      const p = call.path.split("?")[0]!;
      if (p === CLUSTERS) return { results: [{ ...cluster, clusterType }] };
      if (p === `${CLUSTERS}/main`) return { ...cluster, clusterType };
      return undefined;
    });
  }
  const clientOf = (http: ReturnType<typeof atlas>["http"]) =>
    hostClient(new MongoDBAtlasClient(CREDS, { http }));

  it.each(["SHARDED", "GEOSHARDED"])("lists a %s cluster's from its own route", async (type) => {
    const { http, calls } = shardedAtlas(
      (call) => (call.path === SHARDED_LIST ? { results: [snapshot] } : undefined),
      type,
    );
    const snaps = await clientOf(http).listResources("backup-snapshot", ACCOUNT);
    expect(snaps.map((s) => s.id)).toEqual(["acct:backup-snapshot:g1/main/s1"]);
    expect(calls.some((c) => c.path.startsWith(`${REPLICA}?`))).toBe(false);
  });

  it("follows the next link the answer names, since the route takes no paging parameters", async () => {
    const second = `https://cloud.mongodb.com${SHARDED_LIST}?pageNum=2&itemsPerPage=100`;
    const { http } = shardedAtlas((call) => {
      if (call.url === second) return { results: [{ ...snapshot, id: "s2" }], links: [] };
      if (call.path === SHARDED_LIST) {
        return { results: [snapshot], links: [{ rel: "next", href: second }] };
      }
      return undefined;
    });
    const snaps = await clientOf(http).listResources("backup-snapshot", ACCOUNT);
    expect(snaps.map((s) => s.fields["snapshotId"])).toEqual(["s1", "s2"]);
  });

  it("refuses a next link to another host, past the catch around each cluster", async () => {
    const { http, calls } = shardedAtlas((call) =>
      call.path === SHARDED_LIST
        ? { results: [snapshot], links: [{ rel: "next", href: "https://evil.example/x" }] }
        : undefined,
    );
    await expect(clientOf(http).listResources("backup-snapshot", ACCOUNT)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("throws when the total says there is more and no link leads to it", async () => {
    const { http } = shardedAtlas((call) =>
      call.path === SHARDED_LIST ? { results: [snapshot], totalCount: 2, links: [] } : undefined,
    );
    await expect(clientOf(http).listResources("backup-snapshot", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("refuses an answer that is not a list", async () => {
    const { http } = shardedAtlas((call) =>
      call.path === SHARDED_LIST ? { snapshots: [] } : undefined,
    );
    await expect(clientOf(http).listResources("backup-snapshot", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads and deletes one through the sharded routes", async () => {
    const { http, calls } = shardedAtlas((call) => {
      if (call.path !== SHARDED_ONE) return undefined;
      return call.method === "DELETE" ? reply({ status: 204 }) : snapshot;
    });
    const client = clientOf(http);
    const id = "acct:backup-snapshot:g1/main/s1";
    expect((await client.getResource("backup-snapshot", id, ACCOUNT)).fields["status"]).toBe(
      "completed",
    );
    await client.deleteResource("backup-snapshot", id, ACCOUNT);
    expect(calls.filter((c) => c.path === SHARDED_ONE).map((c) => c.method)).toEqual([
      "GET",
      "DELETE",
    ]);
    expect(calls.some((c) => c.path === `${REPLICA}/s1`)).toBe(false);
  });

  it("keeps a replica set's reads and deletes on the replica set routes", async () => {
    const { http, calls } = shardedAtlas((call) => {
      if (call.path !== `${REPLICA}/s1`) return undefined;
      return call.method === "DELETE" ? reply({ status: 204 }) : snapshot;
    }, "REPLICASET");
    const client = clientOf(http);
    const id = "acct:backup-snapshot:g1/main/s1";
    await client.getResource("backup-snapshot", id, ACCOUNT);
    await client.deleteResource("backup-snapshot", id, ACCOUNT);
    expect(calls.filter((c) => c.path === `${REPLICA}/s1`).map((c) => c.method)).toEqual([
      "GET",
      "DELETE",
    ]);
    expect(calls.some((c) => c.path.includes("/shardedCluster"))).toBe(false);
  });

  it.each([404, 403])(
    "uses the replica set route when reading the cluster answers %i",
    async (status) => {
      const { http, calls } = atlas((call) => {
        const p = call.path.split("?")[0]!;
        if (p === `${CLUSTERS}/main`) return reply({ status, body: {} });
        return p === `${REPLICA}/s1` ? reply({ status: 204 }) : undefined;
      });
      await clientOf(http).deleteResource(
        "backup-snapshot",
        "acct:backup-snapshot:g1/main/s1",
        ACCOUNT,
      );
      expect(calls.some((c) => c.method === "DELETE" && c.path === `${REPLICA}/s1`)).toBe(true);
    },
  );

  it("does not pick a delete route when reading the cluster fails for another reason", async () => {
    const { http, calls } = atlas((call) =>
      call.path === `${CLUSTERS}/main` ? reply({ status: 500, body: {} }) : undefined,
    );
    await expect(
      clientOf(http).deleteResource("backup-snapshot", "acct:backup-snapshot:g1/main/s1", ACCOUNT),
    ).rejects.toThrow(/500/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses to delete with a blank snapshot id", async () => {
    const { http, calls } = shardedAtlas(() => undefined);
    await expect(
      clientOf(http).deleteResource("backup-snapshot", "acct:backup-snapshot:g1/main/", ACCOUNT),
    ).rejects.toThrow(/snapshot/i);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("serverless instances", () => {
  it("are retired: no type, and nothing asks for the routes Atlas is removing", async () => {
    expect(plugin.resourceTypes.some((t) => t.id === "serverless-instance")).toBe(false);
    const { http, calls } = atlas();
    await expect(
      hostClient(new MongoDBAtlasClient(CREDS, { http })).listResources(
        "serverless-instance",
        ACCOUNT,
      ),
    ).rejects.toThrow(/unknown resource type/);
    expect(calls.some((c) => c.path.includes("/serverless"))).toBe(false);
  });
});

describe("cluster detail", () => {
  it("offers only the tiers Atlas sells in the cluster's region", async () => {
    const { http } = atlas();
    const client = hostClient(new MongoDBAtlasClient(CREDS, { http }));
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
    const client = hostClient(new MongoDBAtlasClient(CREDS, { http }));
    await client.executeNoSqlCommand("cluster", "acct:cluster:g1/main", ACCOUNT, "scale-tier", [
      JSON.stringify({ instanceSize: "M40" }),
    ]);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/api/atlas/v2/groups/g1/clusters/main");
    expect(patch.headers["Content-Type"]).toBe("application/vnd.atlas.2024-10-23+json");
    const rc = (
      patch.body as { replicationSpecs: Array<{ regionConfigs: Array<Record<string, unknown>> }> }
    ).replicationSpecs[0]!.regionConfigs[0]!;
    expect(rc["electableSpecs"]).toMatchObject({ instanceSize: "M40", nodeCount: 3 });
    expect(rc["readOnlySpecs"]).toMatchObject({ instanceSize: "M40" });
    expect(rc["effectiveElectableSpecs"]).toBeUndefined();
  });

  it("writes on the current version and keeps reading on the one with no sunset", async () => {
    const { http, calls } = atlas((call) => (call.method === "PATCH" ? {} : undefined));
    const client = hostClient(new MongoDBAtlasClient(CREDS, { http }));
    const id = "acct:cluster:g1/main";
    await client.invokeAction("cluster", id, "pause", ACCOUNT);
    await client.invokeAction("cluster", id, "resume", ACCOUNT);
    await client.updateResource("cluster", id, ACCOUNT, { diskSizeGB: "80" });
    await client.updateResource("cluster", id, ACCOUNT, { terminationProtectionEnabled: "true" });
    const writes = calls.filter((c) => c.method === "PATCH");
    expect(writes).toHaveLength(4);
    for (const write of writes) {
      expect(write.headers["Accept"]).toBe("application/vnd.atlas.2024-10-23+json");
      expect(write.headers["Content-Type"]).toBe("application/vnd.atlas.2024-10-23+json");
    }
    const read = calls.find((c) => c.method === "GET" && c.path.endsWith("/clusters/main"))!;
    expect(read.headers["Accept"]).toBe("application/vnd.atlas.2024-08-05+json");
  });

  it("enables compute auto-scaling with bounds around the current tier", async () => {
    const { http, calls } = atlas((call) => (call.method === "PATCH" ? {} : undefined));
    await hostClient(new MongoDBAtlasClient(CREDS, { http })).updateResource(
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
    const client = hostClient(new MongoDBAtlasClient(CREDS, { http }));
    await client.invokeAction("cluster", "acct:cluster:g1/main", "pause", ACCOUNT);
    await client.invokeAction("cluster", "acct:cluster:g1/main", "resume", ACCOUNT);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
      { paused: true },
      { paused: false },
    ]);
  });

  it("takes an on-demand snapshot with the requested retention", async () => {
    const { http, calls } = atlas((call) => (call.method === "POST" ? { id: "s9" } : undefined));
    await hostClient(new MongoDBAtlasClient(CREDS, { http })).executeNoSqlCommand(
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
    await hostClient(new MongoDBAtlasClient(CREDS, { http })).executeNoSqlCommand(
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
    const client = hostClient(new MongoDBAtlasClient(CREDS, { http, secrets }));
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
    const procs: AtlasProcess[] = [
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
