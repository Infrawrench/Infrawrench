import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { gcpRenderDetail } from "../detail-renderers.js";
import type { GcpDetailContext } from "../detail-context.js";
import { gcpGetCreateConfig, gcpCreateResource } from "../create-handlers.js";
import type { GcpCreateContext } from "../create-context.js";
import { enrichDetail } from "../enrich-detail-client.js";
import type { GcpClientContext } from "../shared.js";

const detailCtx: GcpDetailContext = {
  id: (a, t, e) => `${a}:${t}:${e}`,
  project: "proj",
  resourceTypes: [],
};

function res(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:type:ext",
    pluginId: "gcp",
    resourceTypeId: "gce-instance",
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

describe("gcpRenderDetail", () => {
  it("builds base schema with status + details", () => {
    const out = gcpRenderDetail(detailCtx, res({ fields: { status: "RUNNING", zone: "z1" } }));
    expect(out.title).toBe("name");
    expect(out.subtitle).toBe("z1");
    expect(out.status?.kind).toBe("status-dot");
    expect(out.sections?.[0]?.title).toBe("Details");
  });

  it("gcs-bucket adds storageBrowser, removes status", () => {
    const out = gcpRenderDetail(
      detailCtx,
      res({ resourceTypeId: "gcs-bucket", externalId: "bk1" }),
    );
    expect(out.storageBrowser?.bucketName).toBe("bk1");
    expect(out.status).toBeUndefined();
  });

  it("cloudsql-instance adds reset password action", () => {
    const out = gcpRenderDetail(detailCtx, res({ resourceTypeId: "cloudsql-instance" }));
    const conn = out.sections?.find((s) => "title" in s && s.title === "Connection");
    expect(conn).toBeDefined();
  });

  it("memorystore-redis forces info status", () => {
    const out = gcpRenderDetail(
      detailCtx,
      res({ resourceTypeId: "memorystore-redis", fields: { state: "READY" } }),
    );
    expect(out.status?.status).toBe("info");
  });

  it("secret-manager-secret + kms-key set secretVersions", () => {
    const sm = gcpRenderDetail(detailCtx, res({ resourceTypeId: "secret-manager-secret" }));
    expect(sm.secretVersions?.supportsFileUpload).toBe(true);
    const kms = gcpRenderDetail(detailCtx, res({ resourceTypeId: "kms-key" }));
    expect(kms.secretVersions?.supportsReveal).toBe(false);
  });

  it("artifact-registry-repo sets artifactRegistry meta", () => {
    const out = gcpRenderDetail(
      detailCtx,
      res({ resourceTypeId: "artifact-registry-repo", fields: { format: "DOCKER" } }),
    );
    expect(out.artifactRegistry?.format).toBe("docker");
    expect(out.artifactRegistry?.supportsTags).toBe(true);
  });

  it("spanner-database sets sqlEditor with parsed tables", () => {
    const out = gcpRenderDetail(
      detailCtx,
      res({
        resourceTypeId: "spanner-database",
        fields: { dialect: "POSTGRESQL" },
        resolvedOutputs: {
          __tables__: JSON.stringify([{ name: "t1", columns: [], pkColumns: [] }]),
        },
      }),
    );
    expect(out.sqlEditor?.tables).toHaveLength(1);
    expect(out.sqlEditor?.defaultQuery).toContain("information_schema");
  });

  it("log-sink disabled label", () => {
    const out = gcpRenderDetail(
      detailCtx,
      res({ resourceTypeId: "log-sink", fields: { disabled: true } }),
    );
    expect(out.status?.label).toBe("Disabled");
  });

  it("instance-group children + restart action", () => {
    const managed = JSON.stringify([
      { name: "vm1", zone: "z1", resourceId: "rid", status: "RUNNING", currentAction: "NONE" },
    ]);
    const out = gcpRenderDetail(
      detailCtx,
      res({ resourceTypeId: "instance-group", resolvedOutputs: { managedInstances: managed } }),
    );
    expect(out.children).toHaveLength(1);
    expect(out.headerActions?.[0]?.label).toBe("Restart/replace VMs");
  });

  it("vertex-gemini-model sets chatPanel", () => {
    const out = gcpRenderDetail(
      detailCtx,
      res({ resourceTypeId: "vertex-gemini-model", fields: { modelId: "gemini-2.0" } }),
    );
    expect(out.chatPanel?.tabLabel).toBe("Playground");
  });
});

describe("create-handlers dispatch", () => {
  function ctx(over: Partial<GcpCreateContext> = {}): GcpCreateContext {
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

  it("getCreateConfig + createResource throw for unknown type", async () => {
    await expect(gcpGetCreateConfig(ctx(), "no-such-type")).rejects.toThrow("No create config");
    await expect(gcpCreateResource(ctx(), "no-such-type", "acct", {})).rejects.toThrow(
      "not supported",
    );
  });

  it("pubsub-topic create config has name field", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "pubsub-topic");
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("pubsub-subscription config lists topics when no parent", async () => {
    const c = ctx({ paginate: vi.fn(async () => [{ name: "projects/proj/topics/t1" }]) });
    const cfg = await gcpGetCreateConfig(c, "pubsub-subscription");
    const topicField = cfg.fields.find((f) => f.key === "topic");
    expect(topicField).toBeDefined();
    expect((topicField as { options?: unknown[] }).options).toHaveLength(1);
  });

  it("pubsub-subscription config hides topic with parent", async () => {
    const cfg = await gcpGetCreateConfig(
      ctx(),
      "pubsub-subscription",
      "acct:pubsub-topic:projects/proj/topics/t1",
    );
    expect(cfg.fields.find((f) => f.key === "topic")).toBeUndefined();
  });

  it("pubsub-topic createResource PUTs + returns instance", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const out = await gcpCreateResource(ctx(), "pubsub-topic", "acct", { name: "topic1" });
      expect(out.resourceTypeId).toBe("pubsub-topic");
      expect(out.externalId).toBe("topic1");
      expect((spy.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
    } finally {
      spy.mockRestore();
    }
  });

  it("pubsub-subscription createResource recovers topic from parent", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const out = await gcpCreateResource(
        ctx(),
        "pubsub-subscription",
        "acct",
        { name: "sub1" },
        "acct:pubsub-topic:projects/proj/topics/t1",
      );
      const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.topic).toBe("projects/proj/topics/t1");
      expect(out.fields.topic).toBe("t1");
    } finally {
      spy.mockRestore();
    }
  });

  it("pubsub-topic createResource throws on API error", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("boom", { status: 500 }));
    try {
      await expect(gcpCreateResource(ctx(), "pubsub-topic", "acct", { name: "t" })).rejects.toThrow(
        "Pub/Sub API 500",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("enrichDetail", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
  });
  afterEach(() => vi.restoreAllMocks());

  function gcpCtx(over: Partial<GcpClientContext> = {}): GcpClientContext {
    return {
      project: "proj",
      serviceAccountKey: {} as never,
      hostServices: undefined,
      token: vi.fn(async () => "tok"),
      get: vi.fn(async () => ({}) as never),
      paginate: vi.fn(async () => []),
      id: (a, t, e) => `${a}:${t}:${e}`,
      now: () => "t",
      getResource: vi.fn(),
      ...over,
    };
  }

  const cloudCtx = { project: "proj", token: async () => "tok" } as never;
  const fsCtx = { project: "proj", token: async () => "tok" } as never;

  it("passes through resource with no enrichment", async () => {
    const r = res({ resourceTypeId: "gce-disk" });
    const out = await enrichDetail(gcpCtx(), cloudCtx, cloudCtx, fsCtx, r);
    expect(out).toBe(r);
  });

  it("instance-group enrichment stores managedInstances even on error", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
    const out = await enrichDetail(
      gcpCtx(),
      cloudCtx,
      cloudCtx,
      fsCtx,
      res({ resourceTypeId: "instance-group", fields: { zone: "z1", name: "ig1" } }),
    );
    expect(out.resolvedOutputs.managedInstances).toBe("[]");
  });

  it("cloud-tasks-queue enrichment captures tasks/error", async () => {
    const ctx = gcpCtx({
      get: vi.fn(async () => ({ tasks: [{ name: "projects/p/.../tasks/t1" }] })),
    });
    const out = await enrichDetail(
      ctx,
      cloudCtx,
      cloudCtx,
      fsCtx,
      res({ resourceTypeId: "cloud-tasks-queue", externalId: "projects/p/locations/l/queues/q" }),
    );
    expect(out.resolvedOutputs.cloudTasksQueueTasks).toContain("items");
  });
});
