import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { QdrantApiError, millicents, durationToDays } from "../api.js";
import {
  buildClusterUpdate,
  checkCron,
  parseIpRanges,
  QdrantCloudClient,
  usageSeries,
} from "../client.js";
import { aggregateRows, spreadItem } from "../cost-data.js";
import { mapCluster, parseQuantity } from "../mappers.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { parseStatusFeed } from "../status-feed.js";
import { qdrantTerraformExport } from "../terraform.js";
import type { QcCluster } from "../types.js";
import { fakeHttp, respond } from "./helpers.js";

const ACC = "acct-uuid";
const HOST_ACCOUNT = "host";
const BASE = `api.cloud.qdrant.io/api/cluster/v1/accounts/${ACC}`;

function client() {
  const http = fakeHttp();
  const c = hostClient(
    new QdrantCloudClient({ apiKey: "mk", accountId: ACC }, RESOURCE_TYPES, http.services),
  );
  return { http, c };
}

const cluster: QcCluster = {
  id: "c1",
  name: "search",
  accountId: ACC,
  cloudProviderId: "aws",
  cloudProviderRegionId: "us-east-1",
  labels: [{ key: "env", value: "prod" }],
  configuration: {
    numberOfNodes: 3,
    version: "v1.15.0",
    packageId: "pkg-small",
    additionalResources: { disk: 10 },
    clusterStorageConfiguration: { storageTierType: "STORAGE_TIER_TYPE_BALANCED" },
    restartPolicy: "CLUSTER_CONFIGURATION_RESTART_POLICY_ROLLING",
  },
  state: {
    phase: "CLUSTER_PHASE_HEALTHY",
    nodesUp: 3,
    endpoint: {
      url: "https://abc.us-east-1-0.aws.cloud.qdrant.io",
      restPort: 6333,
      grpcPort: 6334,
    },
    resources: { cpu: { available: 1.6 }, ram: { available: 6.4 } },
  },
};

describe("transport", () => {
  it("authenticates with apikey and paginates clusters", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, (call: { url: URL }) =>
      call.url.searchParams.get("pageToken") === "t2"
        ? { items: [{ ...cluster, id: "c2", name: "two" }] }
        : { items: [cluster], nextPageToken: "t2" },
    );
    const list = await c.listResources("cluster", HOST_ACCOUNT);
    expect(list.map((r) => r.externalId)).toEqual(["c1", "c2"]);
    expect(http.calls[0]!.headers["Authorization"]).toBe("apikey mk");
    const f = list[0]!.fields;
    expect(f["status"]).toBe("HEALTHY");
    expect(f["storageTier"]).toBe("BALANCED");
    expect(f["restartPolicy"]).toBe("ROLLING");
    expect(f["labels"]).toBe("env=prod");
    expect(list[0]!.resolvedOutputs["url"]).toBe(
      "https://abc.us-east-1-0.aws.cloud.qdrant.io:6333",
    );
  });

  it("maps gRPC error bodies and keeps the HTTP status", async () => {
    const { http, c } = client();
    http.route(
      "GET",
      `${BASE}/clusters/nope`,
      respond(404, { code: 5, message: "cluster not found" }),
    );
    const err = await c
      .getResource("cluster", `${HOST_ACCOUNT}:cluster:nope`, HOST_ACCOUNT)
      .catch((e) => e);
    expect(err).toBeInstanceOf(QdrantApiError);
    expect((err as QdrantApiError).status).toBe(404);
    expect((err as Error).message).toContain("cluster not found");
  });

  it("lists collections only with a stored database key, using the api-key header", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    expect(await c.listResources("collection", HOST_ACCOUNT)).toEqual([]);
    await http.services.secrets!.setPlaintext!(
      `${HOST_ACCOUNT}:cluster:c1`,
      "databaseApiKey",
      "dbk",
    );
    http.route("GET", "abc.us-east-1-0.aws.cloud.qdrant.io:6333/collections", {
      result: { collections: [{ name: "docs" }] },
    });
    http.route("GET", "abc.us-east-1-0.aws.cloud.qdrant.io:6333/collections/docs", {
      result: {
        status: "green",
        points_count: 42,
        config: { params: { vectors: { size: 768, distance: "Cosine" }, replication_factor: 2 } },
      },
    });
    const cols = await c.listResources("collection", HOST_ACCOUNT);
    expect(cols[0]!.externalId).toBe("c1/docs");
    expect(cols[0]!.fields).toMatchObject({
      pointsCount: 42,
      vectorSize: 768,
      replicationFactor: 2,
    });
    const dbCall = http.calls.find((x) => x.url.pathname === "/collections")!;
    expect(dbCall.url.port).toBe("6333");
    expect(dbCall.headers["api-key"]).toBe("dbk");
  });

  it("mints and stores a database key for Connect Infrawrench", async () => {
    const { http, c } = client();
    http.route(
      "POST",
      `api.cloud.qdrant.io/api/cluster/auth/v2/accounts/${ACC}/database-api-keys`,
      (call: { body: unknown }) => {
        expect(call.body).toMatchObject({
          databaseApiKey: {
            clusterId: "c1",
            accessRules: [
              { globalAccess: { accessType: "GLOBAL_ACCESS_RULE_ACCESS_TYPE_MANAGE" } },
            ],
          },
        });
        return { databaseApiKey: { id: "k1", key: "secret-key" } };
      },
    );
    await c.invokeAction("cluster", `${HOST_ACCOUNT}:cluster:c1`, "mint-db-key", HOST_ACCOUNT);
    expect(
      await c.resolveOutput("cluster", `${HOST_ACCOUNT}:cluster:c1`, "apiKey", HOST_ACCOUNT),
    ).toBe("secret-key");
  });
});

describe("calls that name the cluster", () => {
  const KEYS = `api.cloud.qdrant.io/api/cluster/auth/v2/accounts/${ACC}/database-api-keys`;
  const SCHEDULES = `api.cloud.qdrant.io/api/cluster/backup/v1/accounts/${ACC}/backup_schedules`;
  const schedule = {
    id: "s1",
    accountId: ACC,
    clusterId: "c1",
    schedule: "0 2 * * *",
    retentionPeriod: "604800s",
    status: "BACKUP_SCHEDULE_STATUS_ACTIVE",
  };

  it("deletes a database key with the cluster the list says it belongs to", async () => {
    const { http, c } = client();
    http.route("GET", KEYS, {
      items: [
        { id: "k9", clusterId: "c9" },
        { id: "k1", clusterId: "c1" },
      ],
    });
    http.route("DELETE", `${KEYS}/k1`, {});
    await c.deleteResource("database-api-key", `${HOST_ACCOUNT}:database-api-key:k1`, HOST_ACCOUNT);
    const del = http.calls.find((x) => x.method === "DELETE")!;
    expect(del.url.pathname).toMatch(/\/database-api-keys\/k1$/);
    expect(del.url.searchParams.get("clusterId")).toBe("c1");
  });

  it("answers 404 for a key the list no longer has, and deletes nothing", async () => {
    const { http, c } = client();
    http.route("GET", KEYS, { items: [{ id: "k9", clusterId: "c9" }] });
    const err = await c
      .deleteResource("database-api-key", `${HOST_ACCOUNT}:database-api-key:k1`, HOST_ACCOUNT)
      .catch((e) => e);
    expect(err).toBeInstanceOf(QdrantApiError);
    expect((err as QdrantApiError).status).toBe(404);
    expect(http.calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("refuses to delete a key whose row names no cluster", async () => {
    const { http, c } = client();
    http.route("GET", KEYS, { items: [{ id: "k1" }] });
    await expect(
      c.deleteResource("database-api-key", `${HOST_ACCOUNT}:database-api-key:k1`, HOST_ACCOUNT),
    ).rejects.toThrow(/cluster/);
    expect(http.calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("refuses a blank id on every delete", async () => {
    const { http, c } = client();
    for (const type of ["cluster", "database-api-key", "backup", "backup-schedule"]) {
      await expect(
        c.deleteResource(type, `${HOST_ACCOUNT}:${type}:`, HOST_ACCOUNT),
      ).rejects.toThrow(/no id/);
    }
    expect(http.calls).toEqual([]);
  });

  it("reads a backup schedule with its cluster", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    http.route("GET", SCHEDULES, { items: [{ ...schedule, id: "s9", clusterId: "c9" }, schedule] });
    http.route("GET", `${SCHEDULES}/s1`, { backupSchedule: schedule });
    const r = await c.getResource(
      "backup-schedule",
      `${HOST_ACCOUNT}:backup-schedule:s1`,
      HOST_ACCOUNT,
    );
    expect(r.fields).toMatchObject({ clusterId: "c1", clusterName: "search" });
    const read = http.calls.find((x) => x.url.pathname.endsWith("/backup_schedules/s1"))!;
    expect(read.url.searchParams.get("clusterId")).toBe("c1");
  });

  it("answers 404 for a schedule the list no longer has", async () => {
    const { http, c } = client();
    http.route("GET", SCHEDULES, {});
    http.route("GET", `${SCHEDULES}/s1`, { backupSchedule: schedule });
    const err = await c
      .getResource("backup-schedule", `${HOST_ACCOUNT}:backup-schedule:s1`, HOST_ACCOUNT)
      .catch((e) => e);
    expect((err as QdrantApiError).status).toBe(404);
  });

  it("edits a schedule on top of what the read with its cluster returned", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    http.route("GET", SCHEDULES, { items: [schedule] });
    http.route("GET", `${SCHEDULES}/s1`, { backupSchedule: schedule });
    http.route("PUT", `${SCHEDULES}/s1`, { backupSchedule: schedule });
    await c.updateResource("backup-schedule", `${HOST_ACCOUNT}:backup-schedule:s1`, HOST_ACCOUNT, {
      retentionDays: "14",
    });
    const reads = http.calls.filter(
      (x) => x.url.pathname.endsWith("/backup_schedules/s1") && x.method === "GET",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.url.searchParams.get("clusterId")).toBe("c1");
    const put = http.calls.find((x) => x.method === "PUT")!;
    expect(put.body).toEqual({
      backupSchedule: {
        id: "s1",
        accountId: ACC,
        clusterId: "c1",
        schedule: "0 2 * * *",
        retentionPeriod: "1209600s",
      },
    });
  });
});

describe("lists that feed the sync", () => {
  const MGMT = `api.cloud.qdrant.io`;
  const DB = "abc.us-east-1-0.aws.cloud.qdrant.io:6333";
  const paged: Array<[string, string]> = [
    ["cluster", `${BASE}/clusters`],
    ["backup", `${MGMT}/api/cluster/backup/v1/accounts/${ACC}/backups`],
    ["backup-schedule", `${MGMT}/api/cluster/backup/v1/accounts/${ACC}/backup_schedules`],
    ["backup-restore", `${MGMT}/api/cluster/backup/v1/accounts/${ACC}/backup_restores`],
  ];
  const whole: Array<[string, string]> = [
    ["database-api-key", `${MGMT}/api/cluster/auth/v2/accounts/${ACC}/database-api-keys`],
    ["hybrid-environment", `${MGMT}/api/hybrid/v1/accounts/${ACC}/hybrid-cloud-environments`],
  ];

  async function connected(http: ReturnType<typeof fakeHttp>) {
    await http.services.secrets!.setPlaintext!(`${HOST_ACCOUNT}:cluster:c1`, "databaseApiKey", "k");
  }

  function collections(http: ReturnType<typeof fakeHttp>, count: number) {
    const names = Array.from({ length: count }, (_, i) => `c${i}`);
    http.route("GET", `${DB}/collections`, {
      result: { collections: names.map((name) => ({ name })) },
    });
    for (const name of names) {
      http.route("GET", `${DB}/collections/${name}`, { result: { status: "green" } });
    }
  }

  it.each(paged)("%s throws at the page cap rather than prune the rest", async (type, route) => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    http.route("GET", route, (call: { url: URL }) => ({
      items: [{ ...cluster, id: `r${call.url.searchParams.get("pageToken") ?? ""}` }],
      nextPageToken: `t${http.calls.length}`,
    }));
    await expect(c.listResources(type, HOST_ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(http.calls.filter((x) => `${x.url.host}${x.url.pathname}` === route)).toHaveLength(500);
  });

  it("reads past the old cap of 50 pages", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, (call: { url: URL }) => {
      const page = Number(call.url.searchParams.get("pageToken") ?? 0);
      return {
        items: [{ ...cluster, id: `c${page}` }],
        ...(page < 59 ? { nextPageToken: String(page + 1) } : {}),
      };
    });
    expect(await c.listResources("cluster", HOST_ACCOUNT)).toHaveLength(60);
  });

  it("follows the token past an empty page, since only a missing token ends a list", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, (call: { url: URL }) => {
      const token = call.url.searchParams.get("pageToken");
      if (!token) return { nextPageToken: "t2" };
      return { items: [cluster] };
    });
    const list = await c.listResources("cluster", HOST_ACCOUNT);
    expect(list.map((r) => r.externalId)).toEqual(["c1"]);
  });

  it.each(paged)("%s rejects a non-list on the first and a later page", async (type, route) => {
    const first = client();
    first.http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    first.http.route("GET", route, { items: "oops" });
    await expect(first.c.listResources(type, HOST_ACCOUNT)).rejects.toThrow("is not a list");

    const later = client();
    if (route !== `${BASE}/clusters`) {
      later.http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    }
    later.http.route("GET", route, (call: { url: URL }) =>
      call.url.searchParams.get("pageToken")
        ? { items: { error: "oops" } }
        : { items: [{ ...cluster }], nextPageToken: "t2" },
    );
    await expect(later.c.listResources(type, HOST_ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each([...paged, ...whole])("%s reads an empty proto3 answer as empty", async (type, route) => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, {});
    http.route("GET", route, {});
    expect(await c.listResources(type, HOST_ACCOUNT)).toEqual([]);
  });

  it.each([...paged, ...whole])("%s rejects an answer with no body", async (type, route) => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    http.route("GET", route, undefined);
    await expect(c.listResources(type, HOST_ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each(whole)("%s rejects a non-list", async (type, route) => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    http.route("GET", route, { items: { error: "oops" } });
    await expect(c.listResources(type, HOST_ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads every collection of a cluster, past the old cap of 100", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    await connected(http);
    collections(http, 1000);
    expect(await c.listResources("collection", HOST_ACCOUNT)).toHaveLength(1000);
  });

  it("throws past 1,000 collections on a cluster rather than drop the rest", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    await connected(http);
    collections(http, 1001);
    await expect(c.listResources("collection", HOST_ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(http.calls.filter((x) => x.url.pathname.startsWith("/collections/"))).toEqual([]);
  });

  it("keeps a cluster detail view to its first 100 collections", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters/c1`, { cluster });
    await connected(http);
    collections(http, 150);
    const inst = mapCluster(cluster, HOST_ACCOUNT);
    const out = await c.enrichDetail(inst);
    expect(JSON.parse(String(out.fields["__collections"]))).toHaveLength(100);
  });

  it("does not read a failed collection list as none", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    await connected(http);
    http.route("GET", `${DB}/collections`, respond(500, { status: { error: "down" } }));
    await expect(c.listResources("collection", HOST_ACCOUNT)).rejects.toThrow("down");
  });

  it("does not read a rejected database key as no collections", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    await connected(http);
    http.route("GET", `${DB}/collections`, respond(403, { status: { error: "bad key" } }));
    await expect(c.listResources("collection", HOST_ACCOUNT)).rejects.toThrow("bad key");
  });

  it("does not read a page of collections with no list as none", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    await connected(http);
    http.route("GET", `${DB}/collections`, { status: "ok" });
    await expect(c.listResources("collection", HOST_ACCOUNT)).rejects.toThrow("is not a list");
  });

  const inPhase = (phase: NonNullable<NonNullable<QcCluster["state"]>["phase"]>): QcCluster => ({
    ...cluster,
    state: { ...cluster.state, phase },
  });

  it("does not prune a connected cluster's collections while it is suspended", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [inPhase("CLUSTER_PHASE_SUSPENDED")] });
    await connected(http);
    await expect(c.listResources("collection", HOST_ACCOUNT)).rejects.toThrow(/suspended/);
    expect(http.calls.some((x) => x.url.pathname === "/collections")).toBe(false);
  });

  it("does not prune a connected cluster's collections when it has no endpoint", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, {
      items: [{ ...cluster, state: { phase: "CLUSTER_PHASE_NOT_READY" } }],
    });
    await connected(http);
    await expect(c.listResources("collection", HOST_ACCOUNT)).rejects.toThrow(/no endpoint/);
  });

  it("reads a connected cluster that is mid-update instead of pruning it", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [inPhase("CLUSTER_PHASE_UPDATING")] });
    await connected(http);
    collections(http, 2);
    expect(await c.listResources("collection", HOST_ACCOUNT)).toHaveLength(2);
  });

  it("lets the collections of a cluster being deleted go", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [inPhase("CLUSTER_PHASE_DELETING")] });
    await connected(http);
    expect(await c.listResources("collection", HOST_ACCOUNT)).toEqual([]);
    expect(http.calls.some((x) => x.url.pathname === "/collections")).toBe(false);
  });

  it("has nothing to read on a suspended cluster Infrawrench never connected to", async () => {
    const { http, c } = client();
    http.route("GET", `${BASE}/clusters`, { items: [inPhase("CLUSTER_PHASE_SUSPENDED")] });
    expect(await c.listResources("collection", HOST_ACCOUNT)).toEqual([]);
  });

  it("does not read a bad metering answer as no spend", async () => {
    const { http, c } = client();
    const route = `${MGMT}/api/metering/v1/accounts/${ACC}/meterings/2026/10`;
    const range = { fromDate: "2026-10-01", toDate: "2026-10-31" };
    http.route("GET", route, { items: { error: "oops" } });
    await expect(c.fetchCostData(HOST_ACCOUNT, range)).rejects.toThrow("is not a list");
    http.route("GET", route, undefined);
    await expect(c.fetchCostData(HOST_ACCOUNT, range)).rejects.toThrow("is not a list");
    http.route("GET", route, {});
    expect(await c.fetchCostData(HOST_ACCOUNT, range)).toEqual([]);
  });

  it("does not read a bad credit answer as no credits", async () => {
    const { http, c } = client();
    const route = `${MGMT}/api/billing/v1/accounts/${ACC}/credit-contracts`;
    http.route("GET", route, { items: "oops" });
    await expect(c.fetchCreditBalance()).rejects.toThrow("is not a list");
    http.route("GET", route, {});
    expect(await c.fetchCreditBalance()).toEqual([]);
  });

  it("finds a schedule to edit through the same complete list", async () => {
    const { http, c } = client();
    http.route("GET", paged[2]![1], { items: "oops" });
    await expect(
      c.getResource("backup-schedule", `${HOST_ACCOUNT}:backup-schedule:s1`, HOST_ACCOUNT),
    ).rejects.toThrow("is not a list");
  });
});

describe("cluster updates", () => {
  it("applies edits on top of the current cluster and strips state", () => {
    const body = buildClusterUpdate(
      cluster,
      {
        nodes: "4",
        storageTier: "PERFORMANCE",
        labels: "env=dev",
        allowedIpSourceRanges: "10.0.0.0/8",
      },
      [],
    )!;
    expect(body.state).toBeUndefined();
    expect(body.configuration?.numberOfNodes).toBe(4);
    expect(body.configuration?.clusterStorageConfiguration?.storageTierType).toBe(
      "STORAGE_TIER_TYPE_PERFORMANCE",
    );
    expect(body.labels).toEqual([{ key: "env", value: "dev" }]);
    expect(body.configuration?.allowedIpSourceRanges).toEqual(["10.0.0.0/8"]);
    expect(body.configuration?.packageId).toBe("pkg-small");
  });

  it("refuses to shrink disk and unknown versions", () => {
    expect(() => buildClusterUpdate(cluster, { additionalDiskGib: "5" }, [])).toThrow(/grow/);
    expect(() => buildClusterUpdate(cluster, { version: "v9" }, [{ version: "v1.16.0" }])).toThrow(
      /not available/,
    );
    expect(buildClusterUpdate(cluster, {}, [])).toBeNull();
  });

  it("validates cron and IP ranges", () => {
    expect(() => checkCron("0 2 * * *")).not.toThrow();
    expect(() => checkCron("daily")).toThrow();
    expect(() => parseIpRanges("10.0.0.0")).toThrow(/CIDR/);
  });
});

describe("helpers", () => {
  it("converts units", () => {
    expect(millicents("499900")).toBeCloseTo(4.999);
    expect(durationToDays("604800s")).toBe(7);
    expect(parseQuantity("500m")).toBe(0.5);
    expect(parseQuantity("8GiB")).toBe(8);
    expect(parseQuantity("512Mi")).toBe(0.5);
  });

  it("charts usage metrics", () => {
    const series = usageSeries({
      cpu: [{ timestamp: "2026-10-01T00:00:00Z", value: 0.4 }],
      rps: [{ timestamp: "2026-10-01T00:00:00Z", value: 12 }],
    });
    expect(series.map((s) => s.label)).toEqual(["CPU", "Requests per Second"]);
  });
});

describe("costs", () => {
  it("spreads a metering window over the days it covers, net of discount", () => {
    const rows = spreadItem({
      clusterId: "c1",
      startTime: "2026-10-01T12:00:00Z",
      endTime: "2026-10-02T12:00:00Z",
      billableEntityType: "cluster_booking",
      amountMillicents: "200000",
      discountAmountMillicents: "100000",
      currency: "USD",
      usageHours: 24,
      clusterLabels: { team: "search" },
    });
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ["2026-10-01", 0.5],
      ["2026-10-02", 0.5],
    ]);
    expect(rows[0]).toMatchObject({
      service: "Clusters",
      resourceId: "c1",
      tags: { team: "search" },
    });
    expect(aggregateRows([...rows, ...rows])[0]!.amount).toBe(1);
  });

  it("reads each month in the range", async () => {
    const { http, c } = client();
    for (const m of [9, 10]) {
      http.route("GET", `api.cloud.qdrant.io/api/metering/v1/accounts/${ACC}/meterings/2026/${m}`, {
        items: [
          {
            clusterId: "c1",
            startTime: `2026-${String(m).padStart(2, "0")}-15T00:00:00Z`,
            endTime: `2026-${String(m).padStart(2, "0")}-15T01:00:00Z`,
            amountMillicents: "100000",
            billableEntityType: "Backup",
          },
        ],
      });
    }
    const rows = await c.fetchCostData(HOST_ACCOUNT, {
      fromDate: "2026-09-01",
      toDate: "2026-10-31",
    });
    expect(rows.map((r) => [r.date, r.service, r.amount])).toEqual([
      ["2026-09-15", "Backups", 1],
      ["2026-10-15", "Backups", 1],
    ]);
  });
});

describe("quotas", () => {
  it("reports clusters and keys against the account quota", async () => {
    const { http, c } = client();
    http.route("GET", `api.cloud.qdrant.io/api/quota/v1/accounts/${ACC}/quotas`, {
      maxClusters: 5,
      maxClusterDatabaseApiKeys: 10,
    });
    http.route("GET", `${BASE}/clusters`, { items: [cluster] });
    http.route("GET", `api.cloud.qdrant.io/api/cluster/auth/v2/accounts/${ACC}/database-api-keys`, {
      items: [
        { id: "k1", clusterId: "c1" },
        { id: "k2", clusterId: "c1" },
      ],
    });
    const q = await c.fetchQuotas();
    expect(q.map((x) => [x.id, x.used, x.limit])).toEqual([
      ["clusters", 1, 5],
      ["database-api-keys/c1", 2, 10],
    ]);
  });
});

describe("status feed", () => {
  it("parses Better Stack reports and maps regions", () => {
    const body = JSON.stringify({
      included: [
        { id: "r1", type: "status_page_resource", attributes: { public_name: "AWS us-east-1" } },
        {
          id: "r2",
          type: "status_page_resource",
          attributes: { public_name: "Cloud API (extern)" },
        },
        {
          id: "u1",
          type: "status_update",
          attributes: { message: "Investigating", published_at: "2026-10-01T10:05:00Z" },
        },
        {
          id: "42",
          type: "status_report",
          attributes: {
            title: "Elevated latency",
            report_type: "manual",
            starts_at: "2026-10-01T10:00:00Z",
            aggregate_state: "degraded",
            affected_resources: [{ status_page_resource_id: "r1", status: "degraded" }],
          },
          relationships: { status_updates: { data: [{ id: "u1", type: "status_update" }] } },
        },
        {
          id: "43",
          type: "status_report",
          attributes: {
            title: "API down",
            report_type: "manual",
            starts_at: "2026-10-01T10:00:00Z",
            ends_at: "2026-10-01T11:00:00Z",
            aggregate_state: "resolved",
            affected_resources: [{ status_page_resource_id: "r2" }],
          },
        },
      ],
    });
    const [a, b] = parseStatusFeed(body);
    expect(a).toMatchObject({
      state: "investigating",
      impact: "minor",
      regions: ["us-east-1"],
      lastUpdateText: "Investigating",
    });
    expect(b).toMatchObject({
      state: "resolved",
      resolvedAt: "2026-10-01T11:00:00Z",
      providerWide: true,
    });
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});

describe("terraform", () => {
  it("maps a cluster with nested configuration blocks", () => {
    const out = qdrantTerraformExport.mapResource(mapCluster(cluster, HOST_ACCOUNT))!;
    expect(out.resource.type).toBe("qdrant-cloud_accounts_cluster");
    expect(out.resource.importId).toBe("c1");
    const conf = out.resource.attributes["configuration"] as {
      kind: string;
      attributes: Record<string, unknown>;
    };
    expect(conf.kind).toBe("block");
    expect(conf.attributes["node_configuration"]).toEqual({
      kind: "block",
      attributes: { package_id: { kind: "string", value: "pkg-small" } },
    });
    expect(conf.attributes["restart_policy"]).toEqual({
      kind: "string",
      value: "CLUSTER_CONFIGURATION_RESTART_POLICY_ROLLING",
    });
  });
});
