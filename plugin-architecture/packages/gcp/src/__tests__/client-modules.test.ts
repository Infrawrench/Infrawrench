import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpClientContext } from "../shared.js";
import {
  listStorageObjects,
  deleteStorageObject,
  makeStorageFolder,
  listArtifacts,
} from "../storage-client.js";
import {
  listSecretVersions,
  accessSecretVersion,
  addSecretVersion,
  modifySecretVersion,
} from "../secret-versions-client.js";
import { publishPubsubTopic, publishCloudTasksQueue } from "../publish-handlers.js";
import { resolveOutput, exportCredential } from "../resolve-output-client.js";
import { fetchDashboardStats, fetchMetricSeries, getLogs } from "../monitoring-client.js";
import { executeBigQueryQuery, introspectBigQueryDataset } from "../bigquery-spanner-handlers.js";
import { deleteResource } from "../delete-client.js";
import { listManagedInstances, attachResource } from "../compute-extras-client.js";

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

type CtxOver = Partial<Omit<GcpClientContext, "get" | "paginate">> & {
  get?: (url: string) => Promise<unknown>;
  paginate?: (baseUrl: string, key: string, params?: Record<string, string>) => Promise<unknown[]>;
};

function makeCtx(over: CtxOver = {}): GcpClientContext {
  return {
    project: "proj",
    serviceAccountKey: { client_email: "sa@x", project_id: "proj" } as never,
    hostServices: undefined,
    token: vi.fn(async () => "tok"),
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => []),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
    getResource: vi.fn(async () => makeResource()),
    ...(over as Partial<GcpClientContext>),
  };
}

let fetchSpy: Mock;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

function ok(body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
}
function err(status: number, body = "boom"): Response {
  return new Response(body, { status });
}

describe("storage-client", () => {
  it("listStorageObjects merges prefixes + objects, skips placeholder", async () => {
    const ctx = makeCtx({
      get: vi.fn(async () => ({
        prefixes: ["folder/sub/"],
        items: [
          { name: "folder/", size: "0", updated: "" }, // placeholder, skipped
          { name: "folder/file.txt", size: "10", updated: "2026", contentType: "text/plain" },
        ],
      })),
    });
    const out = await listStorageObjects(ctx, "bk", "folder/");
    expect(out).toHaveLength(2);
    expect(out[0]!.isDirectory).toBe(true);
    expect(out[0]!.name).toBe("sub");
    expect(out[1]!.name).toBe("file.txt");
    expect(out[1]!.size).toBe(10);
    expect(out[1]!.contentType).toBe("text/plain");
  });

  it("deleteStorageObject single object tolerates 404", async () => {
    fetchSpy.mockResolvedValue(err(404));
    await expect(deleteStorageObject(makeCtx(), "bk", "k")).resolves.toBeUndefined();
  });

  it("deleteStorageObject throws on non-404 error", async () => {
    fetchSpy.mockResolvedValue(err(500));
    await expect(deleteStorageObject(makeCtx(), "bk", "k")).rejects.toThrow("Delete failed: 500");
  });

  it("deleteStorageObject folder deletes each listed object", async () => {
    const ctx = makeCtx({
      get: vi.fn(async () => ({ items: [{ name: "f/a" }, { name: "f/b" }] })),
    });
    fetchSpy.mockResolvedValue(ok({}));
    await deleteStorageObject(ctx, "bk", "f/");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("makeStorageFolder appends trailing slash + throws on error", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await makeStorageFolder(makeCtx(), "bk", "newfolder");
    expect(fetchSpy.mock.calls[0]![0]).toContain(encodeURIComponent("newfolder/"));
    fetchSpy.mockResolvedValue(err(403));
    await expect(makeStorageFolder(makeCtx(), "bk", "x")).rejects.toThrow(
      "Make folder failed: 403",
    );
  });

  it("listArtifacts DOCKER format", async () => {
    const ctx = makeCtx({
      get: vi.fn(async (url: string) => {
        if (url.endsWith("/dockerImages?pageSize=50") || url.includes("/dockerImages"))
          return {
            dockerImages: [
              {
                name: "projects/p/locations/us/repositories/r/dockerImages/img@sha256:deadbeef",
                tags: ["v1"],
                imageSizeBytes: "1000",
                updateTime: "2026",
                mediaType: "application/vnd.docker",
              },
            ],
            nextPageToken: "next",
          };
        return { format: "DOCKER" };
      }),
    });
    const out = await listArtifacts(
      ctx,
      "artifact-registry-repo",
      "acct:artifact-registry-repo:projects/p/locations/us/repositories/r",
      "acct",
    );
    expect(out.items[0]!.name).toBe("img");
    expect(out.items[0]!.digest).toBe("sha256:deadbeef");
    expect(out.items[0]!.version).toBe("v1");
    expect(out.nextPageToken).toBe("next");
  });

  it("listArtifacts non-docker packages + prefix filter", async () => {
    const ctx = makeCtx({
      get: vi.fn(async (url: string) => {
        if (url.includes("/packages"))
          return {
            packages: [
              { name: "projects/p/.../packages/foo", updateTime: "2026" },
              { name: "projects/p/.../packages/bar" },
            ],
          };
        return { format: "MAVEN" };
      }),
    });
    const out = await listArtifacts(
      ctx,
      "artifact-registry-repo",
      "acct:artifact-registry-repo:projects/p/locations/us/repositories/r",
      "acct",
      { prefix: "fo" },
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.name).toBe("foo");
  });

  it("listArtifacts rejects wrong type + bad id", async () => {
    await expect(listArtifacts(makeCtx(), "gcs-bucket", "x", "acct")).rejects.toThrow(
      "not supported",
    );
    await expect(
      listArtifacts(makeCtx(), "artifact-registry-repo", "acct:artifact-registry-repo:bad", "acct"),
    ).rejects.toThrow("Invalid");
  });
});

describe("secret-versions-client", () => {
  it("listSecretVersions for secret-manager-secret", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/secrets/s1" })),
      paginate: vi.fn(async () => [
        { name: "projects/p/secrets/s1/versions/1", state: "ENABLED", createTime: "2026" },
        { name: "projects/p/secrets/s1/versions/2", state: "DESTROYED", destroyTime: "2026" },
      ]),
    });
    const out = await listSecretVersions(ctx, "secret-manager-secret", "rid", "acct");
    expect(out[0]!.id).toBe("1");
    expect(out[0]!.state).toBe("enabled");
    expect(out[1]!.state).toBe("destroyed");
    expect(out[1]!.destroyedAt).toBe("2026");
  });

  it("listSecretVersions for kms-key marks primary as latest", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/.../cryptoKeys/k1" })),
      paginate: vi.fn(async () => [
        { name: "projects/p/.../cryptoKeyVersions/3", state: "ENABLED" },
      ]),
      get: vi.fn(async () => ({ primary: { name: "projects/p/.../cryptoKeyVersions/3" } })),
    });
    const out = await listSecretVersions(ctx, "kms-key", "rid", "acct");
    expect(out[0]!.isLatest).toBe(true);
  });

  it("accessSecretVersion decodes base64 / blocks kms", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/secrets/s1" })),
      get: vi.fn(async () => ({ payload: { data: btoa("hello") } })),
    });
    expect(await accessSecretVersion(ctx, "secret-manager-secret", "rid", "acct", "1")).toBe(
      "hello",
    );
    await expect(accessSecretVersion(makeCtx(), "kms-key", "rid", "acct", "1")).rejects.toThrow(
      "cannot be revealed",
    );
  });

  it("addSecretVersion posts payload + handles kms", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/secrets/s1" })),
    });
    fetchSpy.mockResolvedValue(ok({ name: "projects/p/secrets/s1/versions/5", state: "ENABLED" }));
    const v = await addSecretVersion(ctx, "secret-manager-secret", "rid", "acct", "secret-value");
    expect(v.id).toBe("5");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(atob(body.payload.data)).toBe("secret-value");

    const kctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/.../cryptoKeys/k1" })),
    });
    fetchSpy.mockResolvedValue(
      ok({ name: "projects/p/.../cryptoKeyVersions/2", state: "ENABLED" }),
    );
    const kv = await addSecretVersion(kctx, "kms-key", "rid", "acct", "ignored");
    expect(kv.id).toBe("2");
  });

  it("addSecretVersion throws on API error", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/secrets/s1" })),
    });
    fetchSpy.mockResolvedValue(err(500));
    await expect(
      addSecretVersion(ctx, "secret-manager-secret", "rid", "acct", "v"),
    ).rejects.toThrow("Secret Manager API 500");
  });

  it("modifySecretVersion verb selection + kms destroy/enable", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/secrets/s1" })),
    });
    fetchSpy.mockResolvedValue(ok({ name: "projects/p/secrets/s1/versions/1", state: "DISABLED" }));
    await modifySecretVersion(ctx, "secret-manager-secret", "rid", "acct", "1", "disable");
    expect(fetchSpy.mock.calls[0]![0]).toContain(":disable");

    const kctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/.../cryptoKeys/k1" })),
    });
    fetchSpy.mockResolvedValue(ok({ name: "x/cryptoKeyVersions/1", state: "DESTROY_SCHEDULED" }));
    await modifySecretVersion(kctx, "kms-key", "rid", "acct", "1", "destroy");
    expect(fetchSpy.mock.calls[1]![0]).toContain(":destroy");
    expect((fetchSpy.mock.calls[1]![1] as RequestInit).method).toBe("POST");
  });
});

describe("publish-handlers", () => {
  it("publishPubsubTopic encodes body + attributes", async () => {
    fetchSpy.mockResolvedValue(ok({ messageIds: ["m1"] }));
    const res = await publishPubsubTopic({ token: async () => "tok", project: "proj" }, "topic1", {
      body: "hi",
      extras: { attributes: { a: "b", "": "skip" }, orderingKey: "ok" },
    });
    expect(res.id).toBe("m1");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].attributes).toEqual({ a: "b" });
    expect(body.messages[0].orderingKey).toBe("ok");
  });

  it("publishPubsubTopic throws on error", async () => {
    fetchSpy.mockResolvedValue(err(403));
    await expect(
      publishPubsubTopic({ token: async () => "t", project: "p" }, "t1", { body: "x", extras: {} }),
    ).rejects.toThrow("Pub/Sub publish 403");
  });

  it("publishCloudTasksQueue requires url + builds http request", async () => {
    await expect(
      publishCloudTasksQueue(
        { token: async () => "t", project: "p" },
        { fields: {} },
        { body: "", extras: {} },
      ),
    ).rejects.toThrow("Target URL is required");

    fetchSpy.mockResolvedValue(ok({ name: "projects/p/locations/l/queues/q/tasks/t1" }));
    const res = await publishCloudTasksQueue(
      { token: async () => "t", project: "p" },
      { externalId: "projects/p/locations/l/queues/q", fields: {} },
      {
        body: "payload",
        extras: { url: "https://target", method: "post", headers: { "X-H": "1" } },
      },
    );
    expect(res.id).toBe("t1");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.task.httpRequest.httpMethod).toBe("POST");
    expect(body.task.httpRequest.headers).toEqual({ "X-H": "1" });
    expect(atob(body.task.httpRequest.body)).toBe("payload");
  });
});

describe("resolve-output-client", () => {
  it("gke-cluster kubeconfig", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({ externalId: "c1", fields: { location: "us-central1" } }),
      ),
      get: vi.fn(async () => ({
        name: "c1",
        endpoint: "1.2.3.4",
        masterAuth: { clusterCaCertificate: "CA==" },
      })),
    });
    const cfg = await resolveOutput(ctx, "gke-cluster", "rid", "kubeconfig", "acct");
    expect(cfg).toContain("server: https://1.2.3.4");
    expect(cfg).toContain("token: tok");
  });

  it("memorystore-redis authString + redisUrl", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({
          externalId: "projects/p/.../instances/r1",
          resolvedOutputs: { host: "10.0.0.1", port: "6379" },
        }),
      ),
      get: vi.fn(async () => ({ authString: "pw123" })),
    });
    expect(await resolveOutput(ctx, "memorystore-redis", "rid", "authString", "acct")).toBe(
      "pw123",
    );
    expect(await resolveOutput(ctx, "memorystore-redis", "rid", "redisUrl", "acct")).toBe(
      "redis://:pw123@10.0.0.1:6379",
    );
  });

  it("memorystore-redis redisUrl falls back when authString fetch fails", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({ externalId: "n", resolvedOutputs: { host: "h", port: "6379" } }),
      ),
      get: vi.fn(async () => {
        throw new Error("no auth");
      }),
    });
    expect(await resolveOutput(ctx, "memorystore-redis", "rid", "redisUrl", "acct")).toBe(
      "redis://h:6379",
    );
  });

  it("cloudsql-instance connectionUrl + password via hostServices", async () => {
    const ctx = makeCtx({
      hostServices: { secrets: { getPlaintext: vi.fn(async () => "secretpw") } } as never,
      getResource: vi.fn(async () =>
        makeResource({
          fields: { databaseVersion: "POSTGRES_15" },
          resolvedOutputs: { ipAddress: "1.1.1.1" },
        }),
      ),
    });
    expect(await resolveOutput(ctx, "cloudsql-instance", "rid", "password", "acct")).toBe(
      "secretpw",
    );
    expect(await resolveOutput(ctx, "cloudsql-instance", "rid", "connectionUrl", "acct")).toBe(
      "postgres://postgres:secretpw@1.1.1.1:5432/postgres",
    );
    expect(await resolveOutput(ctx, "cloudsql-instance", "rid", "username", "acct")).toBe(
      "postgres",
    );
  });

  it("gcs-bucket serviceAccountKey calls IAM API", async () => {
    const ctx = makeCtx();
    fetchSpy.mockResolvedValue(ok({ privateKeyData: btoa('{"key":"v"}') }));
    const out = await resolveOutput(ctx, "gcs-bucket", "rid", "serviceAccountKey", "acct");
    expect(out).toBe('{"key":"v"}');
  });

  it("ssl-certificate dnsRecords", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({
          externalId: "cert1",
          displayName: "cert1",
          fields: { domains: "a.com, b.com" },
        }),
      ),
    });
    const out = await resolveOutput(ctx, "ssl-certificate", "rid", "dnsRecords", "acct");
    expect(out).toContain("_acme-challenge.a.com.");
  });

  it("secret-manager-secret latestVersion decodes", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "projects/p/secrets/s1" })),
      get: vi.fn(async () => ({ payload: { data: btoa("topsecret") } })),
    });
    expect(await resolveOutput(ctx, "secret-manager-secret", "rid", "latestVersion", "acct")).toBe(
      "topsecret",
    );
  });

  it("generic resolvedOutputs passthrough (vpc-network) + unknown throws", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ resolvedOutputs: { selfLink: "https://x" } })),
    });
    expect(await resolveOutput(ctx, "vpc-network", "rid", "selfLink", "acct")).toBe("https://x");
    await expect(resolveOutput(makeCtx(), "totally-unknown", "rid", "k", "acct")).rejects.toThrow(
      "cannot resolve output",
    );
  });

  it("exportCredential json-key + p12 + unsupported", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ externalId: "sa@p.iam" })),
    });
    fetchSpy.mockResolvedValue(
      ok({
        name: "projects/p/serviceAccounts/sa@p.iam/keys/key1",
        privateKeyData: btoa('{"json":true}'),
      }),
    );
    const json = await exportCredential(ctx, "gcp-service-account", "rid", "acct", "json-key");
    expect(json.filename).toBe("sa.json");
    expect(json.content).toBe('{"json":true}');

    fetchSpy.mockResolvedValue(
      ok({ name: "projects/p/serviceAccounts/sa@p.iam/keys/key2", privateKeyData: "rawp12" }),
    );
    const p12 = await exportCredential(ctx, "gcp-service-account", "rid", "acct", "p12-key");
    expect(p12.mimeType).toBe("application/x-pkcs12");
    expect(p12.content).toBe("rawp12");

    await expect(exportCredential(makeCtx(), "gce-instance", "rid", "acct", "x")).rejects.toThrow(
      "not supported",
    );
  });
});

describe("monitoring-client", () => {
  it("fetchDashboardStats gce-instance + generic fallback", async () => {
    const gce = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({
          fields: { status: "RUNNING", machineType: "e2", zone: "z" },
          resolvedOutputs: { publicIp: "1.1.1.1" },
        }),
      ),
    });
    const stats = await fetchDashboardStats(gce, "gce-instance", "rid", "acct");
    expect(stats[0]!.variant).toBe("status-healthy");
    expect(stats.some((s) => s.label === "Public IP")).toBe(true);

    const generic = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({ fields: { state: "FAILED", tier: "t", region: "r" } }),
      ),
    });
    const g = await fetchDashboardStats(generic, "some-type", "rid", "acct");
    expect(g[0]!.variant).toBe("status-error");
  });

  it("fetchMetricSeries returns series when points present", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ fields: { numericId: "999" } })),
      get: vi.fn(async () => ({
        timeSeries: [
          {
            points: [
              {
                interval: { startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T00:01:00Z" },
                value: { doubleValue: 0.5 },
              },
            ],
          },
        ],
      })),
    });
    const series = await fetchMetricSeries(ctx, "gce-instance", "rid", "acct");
    expect(series.length).toBeGreaterThan(0);
    expect(series[0]!.points[0]!.value).toBe(0.5);
  });

  it("fetchMetricSeries returns [] when no numericId", async () => {
    const ctx = makeCtx({ getResource: vi.fn(async () => makeResource({ fields: {} })) });
    expect(await fetchMetricSeries(ctx, "gce-instance", "rid", "acct")).toEqual([]);
  });

  it("getLogs builds filter + returns lines; unsupported throws", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({ fields: { name: "svc1", region: "us-central1" } }),
      ),
    });
    fetchSpy.mockResolvedValue(
      ok({ entries: [{ timestamp: "2026", severity: "INFO", textPayload: "line1" }] }),
    );
    const res = await getLogs(ctx, "cloud-run-service", "rid", "acct", { tailLines: 50 });
    expect(res.text).toContain("line1");
    expect(res.activeContainer).toBe("service");

    await expect(getLogs(makeCtx(), "gce-instance", "rid", "acct", {})).rejects.toThrow(
      "not supported",
    );
  });

  it("getLogs throws on API error", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ fields: { name: "q1" } })),
    });
    fetchSpy.mockResolvedValue(err(500));
    await expect(getLogs(ctx, "cloud-tasks-queue", "rid", "acct", {})).rejects.toThrow(
      "Cloud Logging API 500",
    );
  });
});

describe("bigquery-spanner-handlers", () => {
  it("executeBigQueryQuery submits + polls + maps rows", async () => {
    const ctx = { project: "proj", token: async () => "tok", get: vi.fn() } as never;
    fetchSpy
      .mockResolvedValueOnce(ok({ jobReference: { jobId: "j1", location: "US" } }))
      .mockResolvedValueOnce(ok({ jobComplete: false }))
      .mockResolvedValueOnce(
        ok({
          jobComplete: true,
          schema: { fields: [{ name: "a" }, { name: "b" }] },
          rows: [{ f: [{ v: "1" }, { v: "2" }] }],
        }),
      );
    const out = await executeBigQueryQuery(ctx, "acct:bigquery-dataset:proj:ds", "SELECT 1");
    expect(out.rows[0]).toEqual({ a: "1", b: "2" });
  });

  it("executeBigQueryQuery throws on submit error", async () => {
    const ctx = { project: "proj", token: async () => "tok", get: vi.fn() } as never;
    fetchSpy.mockResolvedValue(err(400));
    await expect(executeBigQueryQuery(ctx, "acct:bigquery-dataset:proj:ds", "x")).rejects.toThrow(
      "BigQuery error 400",
    );
  });

  it("introspectBigQueryDataset hydrates table schema", async () => {
    const get = vi.fn(async (url: string) => {
      if (url.endsWith("/tables?maxResults=200"))
        return { tables: [{ tableReference: { tableId: "t1" } }] };
      return { schema: { fields: [{ name: "id", type: "INT64" }] } };
    });
    const ctx = { project: "proj", token: async () => "tok", get } as never;
    const out = await introspectBigQueryDataset(ctx, "acct:bigquery-dataset:proj:ds");
    expect(out[0]!.name).toBe("t1");
    expect(out[0]!.columns[0]).toEqual({ name: "id", type: "INT64" });
  });
});

describe("delete-client", () => {
  it("gce-instance DELETE", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ fields: { zone: "z1", name: "vm1" } })),
    });
    fetchSpy.mockResolvedValue(ok({}));
    await deleteResource(ctx, "gce-instance", "rid", "acct");
    expect(fetchSpy.mock.calls[0]![0]).toContain("/zones/z1/instances/vm1");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("gce-instance throws when missing zone", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () => makeResource({ fields: {}, externalId: "", displayName: "" })),
    });
    await expect(deleteResource(ctx, "gce-instance", "rid", "acct")).rejects.toThrow(
      "Cannot determine zone",
    );
  });

  it("cloudsql-instance deletes by parsed name", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await deleteResource(makeCtx(), "cloudsql-instance", "acct:cloudsql-instance:db1", "acct");
    expect(fetchSpy.mock.calls[0]![0]).toContain("/instances/db1");
  });

  it("cloud-run-service uses externalId; errors propagate", async () => {
    const ctx = makeCtx({
      getResource: vi.fn(async () =>
        makeResource({ externalId: "projects/p/locations/l/services/s1" }),
      ),
    });
    fetchSpy.mockResolvedValue(err(500));
    await expect(deleteResource(ctx, "cloud-run-service", "rid", "acct")).rejects.toThrow(
      "Cloud Run API 500",
    );
  });
});

describe("compute-extras-client", () => {
  it("listManagedInstances parses instance URLs", async () => {
    const ctx = makeCtx({ getResource: vi.fn() });
    fetchSpy.mockResolvedValue(
      ok({
        managedInstances: [
          {
            instance: "https://www.googleapis.com/compute/v1/projects/proj/zones/z1/instances/vm1",
            instanceStatus: "RUNNING",
            currentAction: "NONE",
          },
          { instance: "garbage-no-match" },
        ],
      }),
    );
    const out = await listManagedInstances(
      ctx,
      makeResource({ fields: { zone: "z1", name: "ig1" }, accountId: "acct" }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("vm1");
    expect(out[0]!.resourceId).toBe("acct:gce-instance:proj/z1/vm1");
  });

  it("listManagedInstances returns [] for unmanaged", async () => {
    expect(
      await listManagedInstances(makeCtx(), makeResource({ fields: { name: "ig1" } })),
    ).toEqual([]);
  });

  it("attachResource disk→instance zone match + mismatch", async () => {
    const disk = makeResource({ fields: { zone: "z1", name: "d1" } });
    const inst = makeResource({ fields: { zone: "z1", name: "vm1" } });
    const ctx = makeCtx({
      getResource: vi.fn(async (t: string) => (t === "gce-disk" ? disk : inst)),
    });
    fetchSpy.mockResolvedValue(ok({}));
    await attachResource(ctx, "gce-disk", "s", "gce-instance", "t", "acct");
    expect(fetchSpy.mock.calls[0]![0]).toContain("/attachDisk");

    const ctx2 = makeCtx({
      getResource: vi.fn(async (t: string) =>
        t === "gce-disk"
          ? makeResource({ fields: { zone: "z1", name: "d1" } })
          : makeResource({ fields: { zone: "z2", name: "vm1" } }),
      ),
    });
    await expect(
      attachResource(ctx2, "gce-disk", "s", "gce-instance", "t", "acct"),
    ).rejects.toThrow("does not match instance zone");
  });

  it("attachResource unsupported pair throws", async () => {
    await expect(attachResource(makeCtx(), "x", "s", "y", "t", "acct")).rejects.toThrow(
      "not supported",
    );
  });
});
