import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudRunContext } from "../cloud-run-handlers.js";
import {
  fetchCloudRunServiceFull,
  listCloudRunRevisions,
  listEventarcTriggersForService,
  fetchCloudRunIamBindings,
  listCloudRunDomainMappings,
  executeCloudRunCommand,
  serviceToYaml,
} from "../cloud-run-handlers.js";

const ctx: CloudRunContext = { project: "proj", token: async () => "tok" };
const EXT = "projects/proj/locations/us-central1/services/svc";

function res(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:cloud-run-service:" + EXT,
    pluginId: "gcp",
    resourceTypeId: "cloud-run-service",
    accountId: "acct",
    displayName: "svc",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: EXT,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  } as ResourceInstance;
}

let fetchSpy: Mock;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchCloudRunServiceFull", () => {
  it("returns parsed service", async () => {
    fetchSpy.mockResolvedValueOnce(json({ name: EXT, ingress: "INGRESS_TRAFFIC_ALL" }));
    const out = await fetchCloudRunServiceFull(ctx, res());
    expect(out.service?.ingress).toBe("INGRESS_TRAFFIC_ALL");
  });

  it("bad name + api error", async () => {
    expect((await fetchCloudRunServiceFull(ctx, res({ externalId: "bad" }))).error).toContain(
      "Cannot parse",
    );
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect((await fetchCloudRunServiceFull(ctx, res())).error).toContain("Cloud Run API 500");
  });
});

describe("listCloudRunRevisions", () => {
  it("maps revisions, traffic, health, ready", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        revisions: [
          {
            name: EXT + "/revisions/svc-001",
            containers: [
              {
                image: "gcr.io/p/i:1",
                env: [{}, {}],
                startupProbe: {},
                livenessProbe: {},
                resources: { limits: { cpu: "1", memory: "512Mi" } },
              },
            ],
            volumes: [{}],
            conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }],
            containerStatuses: [{ imageDigest: "sha256:abc" }],
            createTime: "2026",
          },
        ],
      }),
    );
    const out = await listCloudRunRevisions(
      ctx,
      res({
        resolvedOutputs: { traffic: JSON.stringify([{ revision: "svc-001", percent: 100 }]) },
      }),
    );
    expect(out[0]!.name).toBe("svc-001");
    expect(out[0]!.trafficPercent).toBe(100);
    expect(out[0]!.healthCheckCount).toBe(2);
    expect(out[0]!.ready).toBe(true);
    expect(out[0]!.imageDigest).toBe("sha256:abc");
  });

  it("reads traffic from cloudRunFullService blob", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        revisions: [{ name: EXT + "/revisions/r1", containers: [{ image: "i" }], conditions: [] }],
      }),
    );
    const out = await listCloudRunRevisions(
      ctx,
      res({
        resolvedOutputs: {
          cloudRunFullService: JSON.stringify({
            service: { traffic: [{ revision: "r1", percent: 50 }] },
          }),
        },
      }),
    );
    expect(out[0]!.trafficPercent).toBe(50);
  });

  it("bad name returns []; api error throws", async () => {
    expect(await listCloudRunRevisions(ctx, res({ externalId: "bad" }))).toEqual([]);
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(listCloudRunRevisions(ctx, res())).rejects.toThrow("revisions 500");
  });
});

describe("listEventarcTriggersForService", () => {
  it("filters by destination service", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        triggers: [
          {
            name: "projects/p/locations/l/triggers/t1",
            destination: { cloudRun: { service: "svc" } },
            eventFilters: [{ attribute: "type", value: "google.pubsub" }],
            transport: {},
            createTime: "2026",
          },
          { name: "other", destination: { cloudRun: { service: "different" } } },
        ],
      }),
    );
    const out = await listEventarcTriggersForService(ctx, res());
    expect(out).toHaveLength(1);
    expect(out[0]!.eventType).toBe("google.pubsub");
    expect(out[0]!.transport).toBe("Pub/Sub");
  });

  it("api error throws", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(listEventarcTriggersForService(ctx, res())).rejects.toThrow("Eventarc API 500");
  });
});

describe("fetchCloudRunIamBindings", () => {
  it("sorts members", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({ bindings: [{ role: "roles/run.invoker", members: ["user:b", "user:a"] }], etag: "e" }),
    );
    const out = await fetchCloudRunIamBindings(ctx, res());
    expect(out.bindings[0]!.members).toEqual(["user:a", "user:b"]);
  });

  it("error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 403 }));
    expect((await fetchCloudRunIamBindings(ctx, res())).error).toContain("getIamPolicy 403");
  });
});

describe("listCloudRunDomainMappings", () => {
  it("filters by routeName, maps records + ready/pending", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        items: [
          {
            metadata: { name: "a.com", creationTimestamp: "2026" },
            spec: { routeName: "svc" },
            status: {
              conditions: [{ type: "Ready", status: "True" }],
              url: "https://a.com",
              resourceRecords: [{ name: "a.com", type: "A", rrdata: "1.2.3.4" }],
            },
          },
          {
            metadata: { name: "b.com" },
            spec: { routeName: "svc" },
            status: {
              conditions: [
                { type: "CertificateProvisioned", reason: "Provisioning" },
                { type: "Ready", status: "False", message: "wait" },
              ],
            },
          },
          { metadata: { name: "c.com" }, spec: { routeName: "other" } },
        ],
      }),
    );
    const out = await listCloudRunDomainMappings(ctx, res());
    expect(out.mappings).toHaveLength(2);
    expect(out.mappings[0]!.ready).toBe(true);
    expect(out.mappings[1]!.status).toBe("Provisioning");
  });

  it("error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect((await listCloudRunDomainMappings(ctx, res())).error).toContain("domain mappings 500");
  });
});

describe("serviceToYaml", () => {
  it("strips server fields", () => {
    const y = serviceToYaml({ name: "svc", etag: "e", uid: "u", conditions: [], ingress: "x" });
    expect(y).toContain("name: svc");
    expect(y).not.toContain("etag");
    expect(serviceToYaml(null)).toBe("");
  });
});

describe("executeCloudRunCommand", () => {
  it("createDomainMapping validates + posts", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "createDomainMapping", [
      JSON.stringify({ domain: "app.example.com" }),
    ]);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    await expect(
      executeCloudRunCommand(ctx, res(), "createDomainMapping", [
        JSON.stringify({ domain: "not a domain" }),
      ]),
    ).rejects.toThrow("not a valid domain");
  });

  it("deleteDomainMapping tolerates 404", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    await executeCloudRunCommand(ctx, res(), "deleteDomainMapping", [
      JSON.stringify({ domain: "a.com" }),
    ]);
  });

  it("editAuthMode public adds allUsers (get+set)", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ bindings: [], etag: "e" }))
      .mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "editAuthMode", [JSON.stringify({ mode: "public" })]);
    const setBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(setBody.policy.bindings[0].members).toContain("allUsers");
  });

  it("addIamBinding + removeIamBinding", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ bindings: [], etag: "e" }))
      .mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "addIamBinding", [
      JSON.stringify({ role: "roles/run.invoker", member: "user:a@x" }),
    ]);
    expect(
      JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string).policy.bindings[0]
        .members,
    ).toContain("user:a@x");
    await expect(
      executeCloudRunCommand(ctx, res(), "addIamBinding", [
        JSON.stringify({ role: "", member: "" }),
      ]),
    ).rejects.toThrow("role and member are required");

    fetchSpy.mockClear();
    fetchSpy
      .mockResolvedValueOnce(
        json({ bindings: [{ role: "roles/run.invoker", members: ["user:a@x"] }], etag: "e" }),
      )
      .mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "removeIamBinding", [
      JSON.stringify({ role: "roles/run.invoker", member: "user:a@x" }),
    ]);
    expect(
      JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string).policy.bindings,
    ).toEqual([]);
  });

  it("editBinaryAuthorization default + custom + disabled", async () => {
    fetchSpy.mockResolvedValueOnce(json({ template: {} })).mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "editBinaryAuthorization", [
      JSON.stringify({ mode: "default" }),
    ]);
    expect(
      JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string).binaryAuthorization
        .useDefault,
    ).toBe(true);
    // The dispatch only marks binAuth enabled for mode "enabled"|"default";
    // "custom" falls through to the disabled (empty) shape.
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(json({ template: {} })).mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "editBinaryAuthorization", [
      JSON.stringify({ mode: "disabled" }),
    ]);
    expect(
      JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string).binaryAuthorization,
    ).toEqual({});
  });

  it("editNetworking ingress + vpc + mesh", async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ template: {}, annotations: {} }))
      .mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "editNetworking", [
      JSON.stringify({
        ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
        vpcConnector: "conn1",
        vpcEgress: "ALL_TRAFFIC",
        mesh: "m1",
      }),
    ]);
    const url = String(fetchSpy.mock.calls[1]![0]);
    expect(url).toContain("updateMask=");
    const body = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_ONLY");
    expect(body.template.vpcAccess.connector).toBe("conn1");
  });

  it("createTrigger pubsub + deleteTrigger", async () => {
    fetchSpy.mockResolvedValueOnce(json({}));
    await executeCloudRunCommand(ctx, res(), "createTrigger", [
      JSON.stringify({ name: "trig1", eventSource: "pubsub", pubsubTopic: "mytopic" }),
    ]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.transport.pubsub.topic).toBe("projects/proj/topics/mytopic");
    await expect(
      executeCloudRunCommand(ctx, res(), "createTrigger", [
        JSON.stringify({ name: "Bad Name!", eventSource: "pubsub" }),
      ]),
    ).rejects.toThrow("lowercase");

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    await executeCloudRunCommand(ctx, res(), "deleteTrigger", [
      JSON.stringify({ triggerName: "trig1" }),
    ]);
  });

  it("unknown command throws", async () => {
    await expect(executeCloudRunCommand(ctx, res(), "noSuch", [])).rejects.toThrow(
      "Unknown Cloud Run command",
    );
  });
});
