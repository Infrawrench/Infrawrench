import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpClientContext } from "../shared.js";
import { deleteResource } from "../delete-client.js";

function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:type:ext",
    pluginId: "gcp",
    resourceTypeId: "x",
    accountId: "acct",
    displayName: "name",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "ext",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  } as ResourceInstance;
}

function makeCtx(
  resource: Partial<ResourceInstance>,
  over: Partial<GcpClientContext> = {},
): GcpClientContext {
  return {
    project: "proj",
    serviceAccountKey: {} as never,
    hostServices: undefined,
    token: vi.fn(async () => "tok"),
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => []),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "t",
    getResource: vi.fn(async () => makeResource(resource)),
    ...over,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

interface Case {
  type: string;
  resource: Partial<ResourceInstance>;
  rid?: string;
  urlContains: string;
  method?: string;
  errorMsg: string;
}

const cases: Case[] = [
  {
    type: "gke-cluster",
    resource: { fields: { location: "us-central1" }, externalId: "k1" },
    urlContains: "/locations/us-central1/clusters/k1",
    errorMsg: "GKE API",
  },
  {
    type: "gce-disk",
    resource: { fields: { zone: "z1", name: "d1" } },
    urlContains: "/zones/z1/disks/d1",
    errorMsg: "GCP Compute API",
  },
  {
    type: "cloud-run-service",
    resource: { externalId: "projects/p/locations/l/services/s" },
    urlContains: "run.googleapis.com/v2/projects/p/locations/l/services/s",
    errorMsg: "Cloud Run API",
  },
  {
    type: "cloud-function",
    resource: { externalId: "projects/p/locations/l/functions/f" },
    urlContains: "cloudfunctions.googleapis.com/v2/projects/p/locations/l/functions/f",
    errorMsg: "Cloud Functions API",
  },
  {
    type: "pubsub-topic",
    resource: { externalId: "projects/p/topics/t" },
    urlContains: "pubsub.googleapis.com/v1/projects/p/topics/t",
    errorMsg: "Pub/Sub API",
  },
  {
    type: "pubsub-subscription",
    resource: { externalId: "projects/p/subscriptions/s" },
    urlContains: "pubsub.googleapis.com/v1/projects/p/subscriptions/s",
    errorMsg: "Pub/Sub API",
  },
  {
    type: "secret-manager-secret",
    resource: { externalId: "projects/p/secrets/s" },
    urlContains: "secretmanager.googleapis.com/v1/projects/p/secrets/s",
    errorMsg: "Secret Manager API",
  },
  {
    type: "firewall-rule",
    resource: { fields: { name: "fw" } },
    urlContains: "/global/firewalls/fw",
    errorMsg: "GCP Compute API",
  },
  {
    type: "static-ip",
    resource: { fields: { name: "ip", region: "us-central1" } },
    urlContains: "/regions/us-central1/addresses/ip",
    errorMsg: "GCP Compute API",
  },
  {
    type: "cloud-scheduler-job",
    resource: { externalId: "projects/p/locations/l/jobs/j" },
    urlContains: "cloudscheduler.googleapis.com/v1/projects/p/locations/l/jobs/j",
    errorMsg: "Cloud Scheduler API",
  },
  {
    type: "cloud-tasks-queue",
    resource: { externalId: "projects/p/locations/l/queues/q" },
    urlContains: "cloudtasks.googleapis.com/v2/projects/p/locations/l/queues/q",
    errorMsg: "Cloud Tasks API",
  },
  {
    type: "artifact-registry-repo",
    resource: { externalId: "projects/p/locations/l/repositories/r" },
    urlContains: "artifactregistry.googleapis.com/v1/projects/p/locations/l/repositories/r",
    errorMsg: "Artifact Registry API",
  },
  {
    type: "workflow",
    resource: { externalId: "projects/p/locations/l/workflows/w" },
    urlContains: "workflows.googleapis.com/v1/projects/p/locations/l/workflows/w",
    errorMsg: "Workflows API",
  },
  {
    type: "filestore-instance",
    resource: { externalId: "projects/p/locations/l/instances/i" },
    urlContains: "file.googleapis.com/v1/projects/p/locations/l/instances/i",
    errorMsg: "Filestore API",
  },
  {
    type: "gcs-bucket",
    resource: { externalId: "bk1" },
    urlContains: "storage/v1/b/bk1",
    errorMsg: "GCS API",
  },
  {
    type: "spanner-instance",
    resource: { externalId: "s1" },
    urlContains: "spanner.googleapis.com/v1/projects/proj/instances/s1",
    errorMsg: "Spanner API",
  },
  {
    type: "spanner-database",
    resource: { externalId: "s1/db1" },
    urlContains: "/instances/s1/databases/db1",
    errorMsg: "Spanner API",
  },
  {
    type: "spanner-backup",
    resource: { externalId: "s1/b1" },
    urlContains: "/instances/s1/backups/b1",
    errorMsg: "Spanner API",
  },
  {
    type: "bigtable-instance",
    resource: { externalId: "bt1" },
    urlContains: "/projects/proj/instances/bt1",
    errorMsg: "Bigtable API",
  },
  {
    type: "firestore-database",
    resource: { externalId: "db1" },
    urlContains: "firestore.googleapis.com/v1/projects/proj/databases/db1",
    errorMsg: "Firestore API",
  },
  {
    type: "memorystore-redis",
    resource: { externalId: "projects/p/locations/l/instances/r" },
    urlContains: "redis.googleapis.com/v1/projects/p/locations/l/instances/r",
    errorMsg: "Memorystore Redis API",
  },
  {
    type: "alloydb-cluster",
    resource: { externalId: "projects/p/locations/l/clusters/c" },
    urlContains: "alloydb.googleapis.com/v1/projects/p/locations/l/clusters/c?force=true",
    errorMsg: "AlloyDB API",
  },
  {
    type: "alloydb-instance",
    resource: { externalId: "projects/p/locations/l/clusters/c/instances/i" },
    urlContains: "/clusters/c/instances/i",
    errorMsg: "AlloyDB API",
  },
  {
    type: "memorystore-memcached",
    resource: { externalId: "projects/p/locations/l/instances/m" },
    urlContains: "memcache.googleapis.com/v1/projects/p/locations/l/instances/m",
    errorMsg: "Memorystore Memcached API",
  },
  {
    type: "vpc-network",
    resource: { externalId: "proj/vpc1", fields: { name: "vpc1" } },
    urlContains: "/global/networks/vpc1",
    errorMsg: "GCP Compute API",
  },
  {
    type: "subnet",
    resource: { externalId: "us-central1/s", fields: { name: "s", region: "us-central1" } },
    urlContains: "/regions/us-central1/subnetworks/s",
    errorMsg: "GCP Compute API",
  },
  {
    type: "cloud-router",
    resource: { fields: { name: "r", region: "us-central1" } },
    urlContains: "/regions/us-central1/routers/r",
    errorMsg: "GCP Compute API",
  },
  {
    type: "cloud-armor-policy",
    resource: { fields: { name: "pol" } },
    urlContains: "/global/securityPolicies/pol",
    errorMsg: "GCP Compute API",
  },
  {
    type: "backend-service",
    resource: { fields: { name: "bs" } },
    urlContains: "/global/backendServices/bs",
    errorMsg: "GCP Compute API",
  },
  {
    type: "health-check",
    resource: { fields: { name: "hc" } },
    urlContains: "/global/healthChecks/hc",
    errorMsg: "GCP Compute API",
  },
  {
    type: "ssl-certificate",
    resource: { fields: { name: "cert" } },
    urlContains: "/global/sslCertificates/cert",
    errorMsg: "GCP Compute API",
  },
  {
    type: "cloud-dns-zone",
    resource: { externalId: "z1" },
    urlContains: "/managedZones/z1",
    errorMsg: "Cloud DNS API",
  },
  {
    type: "cloud-dns-record-set",
    resource: { externalId: "z1/A:www.ex.com" },
    urlContains: "/managedZones/z1/rrsets/www.ex.com./A",
    errorMsg: "Cloud DNS API",
  },
  {
    type: "bigquery-dataset",
    resource: { externalId: "proj:ds" },
    urlContains: "/datasets/ds?deleteContents=true",
    errorMsg: "BigQuery API",
  },
  {
    type: "bigquery-table",
    resource: { externalId: "proj:ds/tbl" },
    urlContains: "/datasets/ds/tables/tbl",
    errorMsg: "BigQuery API",
  },
  {
    type: "cloud-deploy-pipeline",
    resource: { externalId: "projects/p/locations/l/deliveryPipelines/dp" },
    urlContains:
      "clouddeploy.googleapis.com/v1/projects/p/locations/l/deliveryPipelines/dp?force=true",
    errorMsg: "Cloud Deploy API",
  },
  {
    type: "composer-environment",
    resource: { externalId: "projects/p/locations/l/environments/e" },
    urlContains: "composer.googleapis.com/v1/projects/p/locations/l/environments/e",
    errorMsg: "Composer API",
  },
  {
    type: "vertex-ai-endpoint",
    resource: { externalId: "projects/p/locations/us-west1/endpoints/e" },
    urlContains: "us-west1-aiplatform.googleapis.com/v1/projects/p/locations/us-west1/endpoints/e",
    errorMsg: "Vertex AI API",
  },
  {
    type: "gcp-service-account",
    resource: { externalId: "sa@p.iam" },
    urlContains: "/serviceAccounts/sa@p.iam",
    errorMsg: "IAM API",
  },
  {
    type: "log-sink",
    resource: { externalId: "sink1" },
    urlContains: "logging.googleapis.com/v2/projects/proj/sinks/sink1",
    errorMsg: "Logging API",
  },
  {
    type: "alert-policy",
    resource: { externalId: "projects/p/alertPolicies/123" },
    urlContains: "monitoring.googleapis.com/v3/projects/p/alertPolicies/123",
    errorMsg: "Monitoring API",
  },
  {
    type: "instance-group",
    resource: { fields: { name: "ig", zone: "z1" } },
    urlContains: "/zones/z1/instanceGroupManagers/ig",
    errorMsg: "GCP Compute API",
  },
  {
    type: "instance-template",
    resource: { externalId: "tpl1" },
    urlContains: "/global/instanceTemplates/tpl1",
    errorMsg: "GCP Compute API",
  },
  {
    type: "cloud-build-trigger",
    resource: { externalId: "us-central1/trig1" },
    urlContains: "/locations/us-central1/triggers/trig1",
    errorMsg: "Cloud Build API",
  },
];

describe("deleteResource dispatcher", () => {
  for (const c of cases) {
    it(`${c.type} issues delete + propagates error`, async () => {
      const ctx = makeCtx(c.resource);
      await deleteResource(ctx, c.type, c.rid ?? "rid", "acct");
      const url = String(fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]![0]);
      expect(url).toContain(c.urlContains);

      const errCtx = makeCtx(c.resource);
      fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 }));
      await expect(deleteResource(errCtx, c.type, c.rid ?? "rid", "acct")).rejects.toThrow(
        c.errorMsg,
      );
      fetchSpy.mockImplementation(async () => new Response("{}", { status: 200 }));
    });
  }

  it("gce-instance deletes by zone/name (covered baseline) + missing fields throws", async () => {
    await deleteResource(
      makeCtx({ fields: { zone: "z", name: "vm" } }),
      "gce-instance",
      "rid",
      "acct",
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/zones/z/instances/vm");
    await expect(
      deleteResource(
        makeCtx({ fields: {}, externalId: "", displayName: "" }),
        "gce-instance",
        "rid",
        "acct",
      ),
    ).rejects.toThrow("Cannot determine zone");
  });

  it("cloudsql-instance deletes by id; non-ok throws", async () => {
    await deleteResource(makeCtx({}), "cloudsql-instance", "acct:cloudsql-instance:db1", "acct");
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/instances/db1");
    fetchSpy.mockImplementation(async () => new Response("boom", { status: 409 }));
    await expect(
      deleteResource(makeCtx({}), "cloudsql-instance", "acct:cloudsql-instance:db1", "acct"),
    ).rejects.toThrow("Cloud SQL API 409");
  });

  it("cloud-nat fetches router then patches without the NAT", async () => {
    const ctx = makeCtx({ fields: { region: "us-central1", router: "r1", name: "nat1" } }, {});
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ nats: [{ name: "nat1" }, { name: "other" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await deleteResource(ctx, "cloud-nat", "rid", "acct");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("GET");
    const patch = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(patch.nats).toEqual([{ name: "other" }]);
  });

  it("cloud-nat throws when router fetch fails", async () => {
    const ctx = makeCtx({ fields: { region: "us-central1", router: "r1", name: "nat1" } });
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(deleteResource(ctx, "cloud-nat", "rid", "acct")).rejects.toThrow(
      "GCP Compute API 500",
    );
  });

  it("dataflow-job uses PUT cancel with region + without region", async () => {
    await deleteResource(
      makeCtx({ externalId: "job1", fields: { region: "us-central1" } }),
      "dataflow-job",
      "rid",
      "acct",
    );
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/locations/us-central1/jobs/job1");
    fetchSpy.mockClear();
    await deleteResource(
      makeCtx({ externalId: "job2", fields: {} }),
      "dataflow-job",
      "rid",
      "acct",
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/projects/proj/jobs/job2");
  });

  it("forwarding-rule regional vs global", async () => {
    await deleteResource(
      makeCtx({ fields: { name: "fr", region: "us-central1" } }),
      "forwarding-rule",
      "rid",
      "acct",
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/regions/us-central1/forwardingRules/fr");
    fetchSpy.mockClear();
    await deleteResource(
      makeCtx({ fields: { name: "fr2", region: "global" } }),
      "forwarding-rule",
      "rid",
      "acct",
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/global/forwardingRules/fr2");
  });

  it("cloud-build-trigger global fallback for non-regional externalId", async () => {
    await deleteResource(makeCtx({ externalId: "trigOnly" }), "cloud-build-trigger", "rid", "acct");
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/projects/proj/triggers/trigOnly");
  });

  it("instance-group regional + missing zone/region throws", async () => {
    await deleteResource(
      makeCtx({ fields: { name: "ig", region: "us-central1" } }),
      "instance-group",
      "rid",
      "acct",
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(
      "/regions/us-central1/instanceGroupManagers/ig",
    );
    await expect(
      deleteResource(makeCtx({ fields: { name: "ig" } }), "instance-group", "rid", "acct"),
    ).rejects.toThrow("Cannot determine zone or region");
  });

  it("kms-key destroys active versions only", async () => {
    const ctx = makeCtx(
      { externalId: "projects/p/.../cryptoKeys/k1" },
      {
        paginate: vi.fn(async () => [
          { name: "v1", state: "ENABLED" },
          { name: "v2", state: "DESTROYED" },
          { name: "v3", state: "DESTROY_SCHEDULED" },
        ]),
      },
    );
    await deleteResource(ctx, "kms-key", "rid", "acct");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("v1:destroy");
  });

  it("kms-key returns early when no active versions; propagates destroy errors", async () => {
    const noActive = makeCtx(
      { externalId: "k" },
      { paginate: vi.fn(async () => [{ name: "v", state: "DESTROYED" }]) },
    );
    await deleteResource(noActive, "kms-key", "rid", "acct");
    expect(fetchSpy).not.toHaveBeenCalled();
    const ctx = makeCtx(
      { externalId: "k" },
      { paginate: vi.fn(async () => [{ name: "v1", state: "ENABLED" }]) },
    );
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(deleteResource(ctx, "kms-key", "rid", "acct")).rejects.toThrow("KMS API 500");
  });

  it("kms-key-ring is unsupported", async () => {
    await expect(deleteResource(makeCtx({}), "kms-key-ring", "rid", "acct")).rejects.toThrow(
      "does not support deleting key rings",
    );
  });

  it("unknown type throws", async () => {
    await expect(deleteResource(makeCtx({}), "totally-unknown", "rid", "acct")).rejects.toThrow(
      "not supported for type",
    );
  });
});
