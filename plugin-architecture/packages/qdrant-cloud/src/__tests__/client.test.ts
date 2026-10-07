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
  const c = new QdrantCloudClient({ apiKey: "mk", accountId: ACC }, RESOURCE_TYPES, http.services);
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
