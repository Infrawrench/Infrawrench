import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpClientContext } from "../shared.js";
import type { GcpCreateContext } from "../create-context.js";
import type { ListerContext } from "../resource-listers/shared.js";
import * as listers from "../resource-listers.js";
import { gcpGetCreateConfig, gcpCreateResource } from "../create-handlers.js";
import {
  cancelLatestCloudRunJobExecution,
  listCloudRunJobExecutions,
  runCloudRunJob,
  updateCloudRunJob,
  updateMemorystoreValkey,
} from "../cloud-run-job-handlers.js";
import { renderCloudRunJob, renderMemorystoreValkey } from "../cloud-run-job-detail-renderers.js";
import { deleteResource } from "../delete-client.js";
import { fetchMetricSeries, getLogs } from "../monitoring-client.js";
import { gcpTerraformExport } from "../terraform.js";
import { GCP_REGIONS } from "../regions.js";
import { VERTEX_GEMINI_MODELS } from "../resources/vertex-gemini-model.js";
import { GcpClient } from "../client.js";

const JOB = "projects/proj/locations/us-central1/jobs/nightly";
const VALKEY = "projects/proj/locations/us-east1/instances/cache";

function resource(over: Partial<ResourceInstance> = {}): ResourceInstance {
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
  };
}

function clientCtx(over: Partial<GcpClientContext> = {}): GcpClientContext {
  return {
    project: "proj",
    serviceAccountKey: { client_email: "sa@x", project_id: "proj" } as never,
    hostServices: undefined,
    token: vi.fn(async () => "tok"),
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => []),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
    getResource: vi.fn(async () => resource()),
    ...over,
  };
}

function createCtx(over: Partial<GcpCreateContext> = {}): GcpCreateContext {
  return {
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => []),
    token: vi.fn(async () => "tok"),
    project: "proj",
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
    machineTypeSpecCache: new Map(),
    ...over,
  };
}

function listerCtx(items: unknown[]): ListerContext {
  return {
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => items) as ListerContext["paginate"],
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

let fetchSpy: Mock;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

function call(i = -1): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const calls = fetchSpy.mock.calls;
  const [url, init] = calls[i < 0 ? calls.length + i : i] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : {} };
}

describe("cloud run job lister", () => {
  it("maps the job template, readiness and latest execution", async () => {
    const ctx = listerCtx([
      {
        name: JOB,
        terminalCondition: { state: "CONDITION_SUCCEEDED" },
        executionCount: 7,
        template: {
          taskCount: 4,
          parallelism: 2,
          template: {
            containers: [{ image: "us-docker.pkg.dev/p/r/job:1" }],
            timeout: "900s",
            serviceAccount: "runner@proj.iam.gserviceaccount.com",
          },
        },
        latestCreatedExecution: {
          name: `${JOB}/executions/nightly-abc`,
          completionStatus: "EXECUTION_SUCCEEDED",
          completionTime: "2026-09-01T00:00:00Z",
        },
      },
    ]);
    const [job] = await listers.listCloudRunJobs(ctx, "acct", "proj");
    expect(ctx.paginate).toHaveBeenCalledWith(
      "https://run.googleapis.com/v2/projects/proj/locations/-/jobs",
      "jobs",
    );
    expect(job!.id).toBe(`acct:cloud-run-job:${JOB}`);
    expect(job!.fields).toMatchObject({
      name: "nightly",
      region: "us-central1",
      image: "us-docker.pkg.dev/p/r/job:1",
      taskCount: 4,
      parallelism: 2,
      maxRetries: 3,
      timeoutSeconds: 900,
      state: "READY",
      executionCount: 7,
      lastExecution: "nightly-abc",
      lastExecutionStatus: "EXECUTION_SUCCEEDED",
    });
    expect(job!.resolvedOutputs.jobName).toBe(JOB);
  });

  it("parses Duration strings", () => {
    expect(listers.durationSeconds("3.5s")).toBe(3.5);
    expect(listers.durationSeconds(undefined)).toBe(0);
  });
});

describe("memorystore valkey lister", () => {
  it("reads the discovery endpoint from endpoints[].connections", async () => {
    const ctx = listerCtx([
      {
        name: VALKEY,
        mode: "CLUSTER",
        nodeType: "HIGHMEM_MEDIUM",
        engineVersion: "VALKEY_9_0",
        shardCount: 3,
        replicaCount: 1,
        state: "ACTIVE",
        transitEncryptionMode: "SERVER_AUTHENTICATION",
        deletionProtectionEnabled: true,
        endpoints: [
          {
            connections: [
              {
                pscAutoConnection: {
                  ipAddress: "10.0.0.9",
                  port: 6379,
                  network: "projects/proj/global/networks/prod",
                  connectionType: "CONNECTION_TYPE_DISCOVERY",
                },
              },
            ],
          },
        ],
      },
    ]);
    const [inst] = await listers.listMemorystoreValkey(ctx, "acct", "proj");
    expect(ctx.paginate).toHaveBeenCalledWith(
      "https://memorystore.googleapis.com/v1/projects/proj/locations/-/instances",
      "instances",
    );
    expect(inst!.fields).toMatchObject({
      name: "cache",
      region: "us-east1",
      shardCount: 3,
      network: "prod",
      deletionProtectionEnabled: true,
    });
    expect(inst!.resolvedOutputs).toMatchObject({
      host: "10.0.0.9",
      port: "6379",
      valkeyUrl: "rediss://10.0.0.9:6379",
    });
  });

  it("falls back to deprecated discoveryEndpoints and picks primary/reader", () => {
    expect(
      listers.valkeyEndpoints({
        discoveryEndpoints: [{ address: "10.1.1.1", port: 6378, network: "n/x" }],
      }),
    ).toEqual({ host: "10.1.1.1", port: "6378", readerHost: "", network: "x" });
    expect(
      listers.valkeyEndpoints({
        pscAutoConnections: [
          { ipAddress: "10.2.0.1", port: 6379, connectionType: "CONNECTION_TYPE_PRIMARY" },
          { ipAddress: "10.2.0.2", port: 6379, connectionType: "CONNECTION_TYPE_READER" },
        ],
      }),
    ).toMatchObject({ host: "10.2.0.1", readerHost: "10.2.0.2" });
  });
});

describe("create", () => {
  it("valkey config offers a network picker and every node type", async () => {
    const cfg = await gcpGetCreateConfig(createCtx(), "memorystore-valkey");
    expect(cfg.fields.find((f) => f.key === "network")!.kind).toBe("resource-picker");
    const nodeType = cfg.fields.find((f) => f.key === "nodeType") as { options: unknown[] };
    expect(nodeType.options).toHaveLength(10);
  });

  it("creates a cluster-mode-disabled valkey instance with one shard", async () => {
    const out = await gcpCreateResource(createCtx(), "memorystore-valkey", "acct", {
      name: "cache",
      location: "us-east1",
      network: "https://www.googleapis.com/compute/v1/projects/proj/global/networks/prod",
      mode: "CLUSTER_DISABLED",
      shardCount: "8",
      replicaCount: "2",
    });
    const { url, body } = call();
    expect(url).toBe(
      "https://memorystore.googleapis.com/v1/projects/proj/locations/us-east1/instances?instanceId=cache",
    );
    expect(body).toMatchObject({
      mode: "CLUSTER_DISABLED",
      shardCount: 1,
      replicaCount: 2,
      engineVersion: "VALKEY_9_0",
      endpoints: [
        {
          connections: [
            {
              pscAutoConnection: {
                network: "projects/proj/global/networks/prod",
                projectId: "proj",
              },
            },
          ],
        },
      ],
    });
    expect(out.externalId).toBe(VALKEY);
    expect(out.fields.network).toBe("prod");
  });

  it("valkey create requires a network", async () => {
    await expect(
      gcpCreateResource(createCtx(), "memorystore-valkey", "acct", { name: "c", location: "x" }),
    ).rejects.toThrow("VPC network");
  });

  it("creates a cloud run job", async () => {
    const out = await gcpCreateResource(createCtx(), "cloud-run-job", "acct", {
      name: "nightly",
      region: "us-central1",
      image: "img:1",
      taskCount: "5",
      timeoutSeconds: "120",
      serviceAccount: "runner@proj.iam.gserviceaccount.com",
    });
    const { url, body } = call();
    expect(url).toBe(
      "https://run.googleapis.com/v2/projects/proj/locations/us-central1/jobs?jobId=nightly",
    );
    expect(body).toMatchObject({
      template: {
        taskCount: 5,
        template: {
          containers: [{ image: "img:1", resources: { limits: { cpu: "1", memory: "512Mi" } } }],
          timeout: "120s",
          serviceAccount: "runner@proj.iam.gserviceaccount.com",
        },
      },
    });
    expect(out.id).toBe(`acct:cloud-run-job:${JOB}`);
    expect(out.fields.state).toBe("PROVISIONING");
  });

  it("job config reads Cloud Run's locations list", async () => {
    const ctx = createCtx({
      get: vi.fn(async () => ({
        locations: [{ locationId: "europe-north2" }, { name: "projects/p/locations/asia-east1" }],
      })) as never,
    });
    const cfg = await gcpGetCreateConfig(ctx, "cloud-run-job");
    const region = cfg.fields.find((f) => f.key === "region") as { regions: Array<{ id: string }> };
    expect(region.regions.map((r) => r.id)).toEqual(["europe-north2", "asia-east1"]);
  });
});

describe("cloud run job actions", () => {
  const job = resource({
    resourceTypeId: "cloud-run-job",
    externalId: JOB,
    fields: { lastExecution: "nightly-abc" },
  });

  it("runs and cancels", async () => {
    await runCloudRunJob(clientCtx(), job);
    expect(call().url).toBe(`https://run.googleapis.com/v2/${JOB}:run`);
    await cancelLatestCloudRunJobExecution(clientCtx(), job);
    expect(call().url).toBe(`https://run.googleapis.com/v2/${JOB}/executions/nightly-abc:cancel`);
    expect(call().init.method).toBe("POST");
  });

  it("refuses to cancel without an execution", async () => {
    await expect(
      cancelLatestCloudRunJobExecution(clientCtx(), { ...job, fields: {} }),
    ).rejects.toThrow("no execution");
  });

  it("lists executions with derived status", async () => {
    const ctx = clientCtx({
      get: vi.fn(async () => ({
        executions: [
          {
            name: `${JOB}/executions/e2`,
            taskCount: 2,
            succeededCount: 1,
            failedCount: 1,
            completionTime: "2026-09-02T00:00:00Z",
          },
          { name: `${JOB}/executions/e3`, taskCount: 1, runningCount: 1 },
        ],
      })) as never,
    });
    const out = await listCloudRunJobExecutions(ctx, job);
    expect(out.map((e) => [e.name, e.status, e.tasks])).toEqual([
      ["e2", "Failed", "1/2"],
      ["e3", "Running", "0/1"],
    ]);
  });

  it("update patches the full job with only the edited template values", async () => {
    const live = {
      name: JOB,
      etag: "abc",
      template: {
        taskCount: 1,
        template: { containers: [{ image: "old", env: [{ name: "A", value: "1" }] }] },
      },
    };
    const ctx = clientCtx({ get: vi.fn(async () => structuredClone(live)) as never });
    await updateCloudRunJob(ctx, job, { image: "new", taskCount: "3", timeoutSeconds: "60" });
    const { url, init, body } = call();
    expect(url).toBe(`https://run.googleapis.com/v2/${JOB}`);
    expect(init.method).toBe("PATCH");
    expect(body).toEqual({
      name: JOB,
      etag: "abc",
      template: {
        taskCount: 3,
        template: {
          containers: [{ image: "new", env: [{ name: "A", value: "1" }] }],
          timeout: "60s",
        },
      },
    });
  });
});

describe("valkey update", () => {
  const inst = resource({
    resourceTypeId: "memorystore-valkey",
    externalId: VALKEY,
    fields: { mode: "CLUSTER", shardCount: 3, replicaCount: 1, nodeType: "HIGHMEM_MEDIUM" },
  });

  it("sends only changed fields in the update mask", async () => {
    await updateMemorystoreValkey(clientCtx(), inst, {
      shardCount: "6",
      replicaCount: "1",
      nodeType: "HIGHMEM_MEDIUM",
      deletionProtectionEnabled: "true",
    });
    const { url, body } = call();
    expect(url).toBe(
      `https://memorystore.googleapis.com/v1/${VALKEY}?updateMask=shard_count,deletion_protection_enabled`,
    );
    expect(body).toEqual({ shardCount: 6, deletionProtectionEnabled: true });
  });

  it("is a no-op when nothing changed and rejects shards on cluster-disabled", async () => {
    await updateMemorystoreValkey(clientCtx(), inst, { shardCount: "3" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      updateMemorystoreValkey(
        clientCtx(),
        { ...inst, fields: { ...inst.fields, mode: "CLUSTER_DISABLED" } },
        { shardCount: "2" },
      ),
    ).rejects.toThrow("exactly one shard");
  });
});

describe("delete, metrics and logs", () => {
  it("deletes both types by full name", async () => {
    const ctx = clientCtx({
      getResource: vi.fn(async (typeId: string) =>
        resource({ externalId: typeId === "cloud-run-job" ? JOB : VALKEY }),
      ) as never,
    });
    await deleteResource(ctx, "cloud-run-job", "rid", "acct");
    expect(call().url).toBe(`https://run.googleapis.com/v2/${JOB}`);
    await deleteResource(ctx, "memorystore-valkey", "rid", "acct");
    expect(call().url).toBe(`https://memorystore.googleapis.com/v1/${VALKEY}`);
    expect(call().init.method).toBe("DELETE");
  });

  it("queries job and valkey metrics by their monitored-resource labels", async () => {
    const urls: string[] = [];
    const get = vi.fn(async (url: string) => {
      urls.push(decodeURIComponent(url));
      return {
        timeSeries: [{ points: [{ interval: { endTime: "2026" }, value: { int64Value: "2" } }] }],
      };
    });
    const jobCtx = clientCtx({
      get: get as never,
      getResource: vi.fn(async () => resource({ fields: { name: "nightly" } })) as never,
    });
    const jobSeries = await fetchMetricSeries(jobCtx, "cloud-run-job", "rid", "acct");
    expect(jobSeries.map((s) => s.label)).toContain("Completed Executions");
    expect(urls.some((u) => u.includes('resource.labels.job_name="nightly"'))).toBe(true);

    const valkeySeries = await fetchMetricSeries(
      {
        ...jobCtx,
        getResource: vi.fn(async () => resource({ fields: { name: "cache" } })) as never,
      },
      "memorystore-valkey",
      "rid",
      "acct",
    );
    expect(valkeySeries).toHaveLength(11);
    expect(
      urls.some((u) =>
        u.includes('metric.type="memorystore.googleapis.com/instance/cpu/average_utilization"'),
      ),
    ).toBe(true);
  });

  it("reads job logs from cloud_run_job entries", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ entries: [{ timestamp: "t", textPayload: "done" }] })),
    );
    const ctx = clientCtx({
      getResource: vi.fn(async () =>
        resource({ fields: { name: "nightly", region: "us-central1" } }),
      ) as never,
    });
    const out = await getLogs(ctx, "cloud-run-job", "rid", "acct", {});
    expect(call().body["filter"]).toBe(
      'resource.type="cloud_run_job" AND resource.labels.job_name="nightly" AND resource.labels.location="us-central1"',
    );
    expect(out.text).toContain("done");
    expect(out.activeContainer).toBe("job");
  });
});

describe("detail renderers", () => {
  const base = (): DetailViewSchema => ({ title: "t", sections: [], headerActions: [] });

  it("job: execute always, cancel only while running, executions tab", () => {
    const view = base();
    renderCloudRunJob(
      resource({
        fields: { lastExecutionStatus: "EXECUTION_RUNNING", lastExecution: "e1" },
        resolvedOutputs: {
          executions: JSON.stringify({
            items: [
              { name: "e1", status: "Running", tasks: "0/1", createTime: "", completionTime: "" },
            ],
          }),
        },
      }),
      view,
    );
    expect(view.headerActions!.map((a) => a.label)).toEqual(["Execute", "Cancel execution"]);
    expect(view.logs).toBeDefined();
    expect(view.customTabs![0]!.id).toBe("executions");

    const idle = base();
    renderCloudRunJob(resource({ fields: { lastExecutionStatus: "EXECUTION_SUCCEEDED" } }), idle);
    expect(idle.headerActions!.map((a) => a.label)).toEqual(["Execute"]);
  });

  it("valkey: info status and a connection section", () => {
    const view = base();
    renderMemorystoreValkey(
      resource({
        fields: { state: "ACTIVE", mode: "CLUSTER" },
        resolvedOutputs: { host: "10.0.0.9", port: "6379" },
      }),
      view,
    );
    expect(view.status).toMatchObject({ status: "info", label: "ACTIVE" });
    expect(view.sections![0]!.title).toBe("Connection");
  });
});

describe("terraform", () => {
  const tfResource = (resourceTypeId: string, fields: Record<string, string | number | boolean>) =>
    resource({ resourceTypeId, fields, externalId: "projects/p/locations/l/x/y" });

  it("maps a cloud run job", () => {
    expect(
      gcpTerraformExport.mapResource(
        tfResource("cloud-run-job", {
          name: "nightly",
          region: "us-central1",
          image: "img:1",
          taskCount: 2,
          maxRetries: 1,
        }),
      ),
    ).toMatchObject({
      resource: {
        type: "google_cloud_run_v2_job",
        attributes: {
          location: { value: "us-central1" },
          template: {
            kind: "block",
            attributes: {
              task_count: { value: 2 },
              template: { attributes: { max_retries: { value: 1 } } },
            },
          },
        },
      },
    });
  });

  it("maps a valkey instance and skips one without a shard count", () => {
    expect(
      gcpTerraformExport.mapResource(
        tfResource("memorystore-valkey", {
          name: "cache",
          region: "us-east1",
          shardCount: 1,
          mode: "CLUSTER_DISABLED",
          network: "prod",
        }),
      ),
    ).toMatchObject({
      resource: {
        type: "google_memorystore_instance",
        attributes: {
          instance_id: { value: "cache" },
          mode: { value: "CLUSTER_DISABLED" },
          desired_auto_created_endpoints: { kind: "block" },
        },
      },
    });
    expect(
      gcpTerraformExport.mapResource(tfResource("memorystore-valkey", { name: "c", region: "r" })),
    ).toBeNull();
  });
});

describe("catalogs", () => {
  it("region picker covers every region, including Mexico and Bangkok", () => {
    const ids = GCP_REGIONS.map((r) => r.id);
    expect(ids[0]).toBe("us-central1");
    expect(ids).toEqual(expect.arrayContaining(["northamerica-south1", "asia-southeast3"]));
    expect(GCP_REGIONS.find((r) => r.id === "northamerica-south1")!.location).toContain("Mexico");
  });

  it("gemini catalog drops shut-down models", () => {
    const ids = VERTEX_GEMINI_MODELS.map((m) => m.modelId);
    expect(ids).not.toContain("gemini-2.0-flash");
    expect(ids).not.toContain("gemini-1.5-pro");
    expect(ids).toContain("gemini-3.8-flash");
  });

  it("the gemini playground calls the global Vertex endpoint", async () => {
    const client = new GcpClient(
      {
        serviceAccountJson: JSON.stringify({
          type: "service_account",
          project_id: "proj",
          private_key_id: "kid",
          private_key: "k",
          client_email: "sa@proj.iam.gserviceaccount.com",
          client_id: "1",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      },
      [],
    );
    vi.spyOn(client as unknown as { token: () => Promise<string> }, "token").mockResolvedValue(
      "tok",
    );
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const events = [];
    for await (const e of client.streamChatMessage(
      "vertex-gemini-model",
      "acct:vertex-gemini-model:gemini-3.8-flash",
      "acct",
      [{ role: "user", content: "hi" }],
    )) {
      events.push(e);
    }
    expect(call().url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions",
    );
    expect(call().body["model"]).toBe("google/gemini-3.8-flash");
    expect(events[0]).toMatchObject({ kind: "error" });
  });
});
