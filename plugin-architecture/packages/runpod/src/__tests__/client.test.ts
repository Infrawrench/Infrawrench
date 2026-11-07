import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunpodApiError } from "../api.js";
import { flashbootMode, parseEnv, RunpodClient, startCommandBody } from "../client.js";
import { manifest } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import type {
  RpCpuType,
  RpDataCenter,
  RpEndpoint,
  RpGpuType,
  RpNetworkVolume,
  RpPod,
  RpTemplate,
} from "../types.js";

interface Call {
  method: string;
  url: URL;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Route = (call: Call) => unknown;

let calls: Call[] = [];
let routes: Record<string, Route> = {};

function route(method: string, key: string, handler: unknown) {
  routes[`${method} ${key}`] = typeof handler === "function" ? (handler as Route) : () => handler;
}

/** Route key: REST path with its `/v2`, `graphql:<operation name>`, or `sls:<path>`. */
function keyOf(url: URL, body: { query?: string } | undefined): string {
  if (url.host === "api.runpod.ai") return `sls:${url.pathname.replace(/^\/v2/, "")}`;
  if (url.host !== "api.runpod.io") throw new Error(`host outside the fixtures: ${url.host}`);
  if (url.pathname !== "/graphql") return url.pathname;
  const m = /(?:query|mutation)\s+(\w+)/.exec(body?.query ?? "");
  return `graphql:${m?.[1] ?? "?"}`;
}

beforeEach(async () => {
  calls = [];
  routes = {};
  const { Socket } = await vi.importActual<{
    Socket: { prototype: { connect: () => void } };
  }>("node:net");
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("sockets are blocked in these tests");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const call: Call = {
        method: init.method ?? "GET",
        url: u,
        body,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${keyOf(u, body)}`];
      if (!handler) throw new Error(`no fixture for ${call.method} ${url}`);
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const client = () => hostClient(new RunpodClient({ apiKey: "rpa_KEY" }, RESOURCE_TYPES));

const LAST_PAGE = { nextCursor: null, hasNextPage: false };
const page = (key: string, items: unknown[]) => ({ [key]: items, pagination: LAST_PAGE });

/** The `pod` example under `GET /v2/pods/{id}` in the document. */
const POD: RpPod = {
  id: "7h9k2m4n6p",
  name: "pytorch-training",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  args: "",
  disk: 50,
  ports: ["8888/http", "22/tcp"],
  env: { MODEL_NAME: "llama-3" },
  registry: null,
  status: "RUNNING",
  actions: ["stop", "restart", "terminate"],
  mounts: { persistent: { size: 20, path: "/workspace" } },
  gpu: { id: "NVIDIA GeForce RTX 4090", count: 1, vcpuCount: 16, memory: 64 },
  cloud: "SECURE",
  dataCenterId: "US-KS-2",
  cudaVersion: "12.8",
  ssh: {
    proxy: {
      host: "ssh.runpod.io",
      port: 22,
      username: "7h9k2m4n6p-64411eb2",
      command: "ssh 7h9k2m4n6p-64411eb2@ssh.runpod.io",
    },
    direct: {
      host: "195.26.233.3",
      port: 34446,
      username: "root",
      command: "ssh root@195.26.233.3 -p 34446",
    },
  },
  template: "9x4m2p7v",
  cost: 0.44,
  locked: false,
  globalNetworking: { enabled: false },
  runtime: {
    uptime: 3600,
    gpus: [{ util: 94, memoryUtil: 78 }],
    cpu: { util: 45 },
    memory: { util: 60 },
    ports: [{ private: 22, public: 34446, type: "tcp", ip: "195.26.233.3" }],
  },
  createdAt: "2026-06-01T12:00:00Z",
  startedAt: "2026-06-01T12:02:00Z",
};

/** What the document says a list row is: `runtime` and `ssh.direct` are null there. */
const LISTED_POD: RpPod = {
  ...POD,
  runtime: null,
  ssh: { proxy: POD.ssh.proxy, direct: null },
};

/** The `endpoint` example under `GET /v2/serverless/{id}`, as a queue endpoint. */
const ENDPOINT: RpEndpoint = {
  id: "4m7x2k9q",
  name: "image-generator",
  type: "QUEUE",
  requestUrls: {
    run: "https://api.runpod.ai/v2/4m7x2k9q/run",
    runSync: "https://api.runpod.ai/v2/4m7x2k9q/runsync",
    status: "https://api.runpod.ai/v2/4m7x2k9q/status/{job_id}",
    stream: "https://api.runpod.ai/v2/4m7x2k9q/stream/{job_id}",
    cancel: "https://api.runpod.ai/v2/4m7x2k9q/cancel/{job_id}",
    retry: "https://api.runpod.ai/v2/4m7x2k9q/retry/{job_id}",
    purgeQueue: "https://api.runpod.ai/v2/4m7x2k9q/purge-queue",
    health: "https://api.runpod.ai/v2/4m7x2k9q/health",
  },
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  args: "",
  disk: 20,
  ports: ["8000/http"],
  env: { MODEL_NAME: "sdxl" },
  registry: null,
  gpu: { pools: ["ADA_24"], count: 1, allowedCudaVersions: [], minCudaVersion: null },
  workers: { min: 0, max: 5, idleTimeout: 5 },
  scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
  dataCenterIds: ["US-KS-2"],
  networkVolumes: ["2q9m7x4c"],
  mounts: { network: [{ volumeId: "2q9m7x4c" }], global: [] },
  timeout: 300000,
  flashboot: "OFF",
  createdAt: "2026-06-01T12:00:00Z",
};

const TEMPLATE: RpTemplate = {
  id: "tpl_abc",
  name: "My PyTorch Template",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  args: "",
  disk: 50,
  mounts: { persistent: { size: 20, path: "/workspace" } },
  ports: ["8888/http"],
  env: { JUPYTER_ENABLE_LAB: "yes" },
  registry: null,
  serverless: false,
  public: false,
  category: "NVIDIA",
  startSsh: true,
  startJupyter: true,
  allowedCudaVersions: [],
};

const VOLUME: RpNetworkVolume = {
  id: "agv6w2qcg7",
  name: "my-dataset",
  size: 50,
  dataCenter: "EU-RO-1",
  type: "STANDARD",
};

const GPU: RpGpuType = {
  id: "NVIDIA GeForce RTX 4090",
  name: "RTX 4090",
  pool: "ADA_24",
  manufacturer: "NVIDIA",
  memory: 24,
  secure: true,
  community: true,
  price: { secure: 0.44, community: 0.31, serverless: 1.1 },
  maxCount: { secure: 8, community: 4 },
  availability: "HIGH",
};

const CPU: RpCpuType = {
  id: "cpu5c",
  name: "Compute-Optimized",
  group: "Gen 5",
  vcpu: { min: 2, max: 32 },
  ramGbPerVcpu: 2,
  price: { securePerVcpu: 0.04, serverlessPerVcpu: 0.03 },
};

const DATA_CENTER: RpDataCenter = {
  id: "US-KS-2",
  name: "US Kansas 2",
  region: "NORTH_AMERICA",
  globalNetwork: true,
  networkVolumeTypes: ["STANDARD", "HIGH_PERFORMANCE"],
  compliance: ["SOC_2_TYPE_2"],
  gpuAvailability: [{ id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", availability: "HIGH" }],
};

/** Every top-level body field each operation's request schema documents. */
const DOCUMENTED_BODY: Record<string, string[]> = {
  pod: [
    "args",
    "cmd",
    "cloud",
    "cpu",
    "dataCenterIds",
    "disk",
    "entrypoint",
    "env",
    "globalNetworking",
    "gpu",
    "image",
    "mounts",
    "name",
    "ports",
    "registry",
    "startJupyter",
    "startSsh",
    "templateId",
  ],
  endpoint: [
    "args",
    "cmd",
    "cpu",
    "dataCenterIds",
    "disk",
    "entrypoint",
    "env",
    "flashboot",
    "gpu",
    "image",
    "mounts",
    "name",
    "networkVolumes",
    "ports",
    "registry",
    "scaling",
    "templateId",
    "timeout",
    "type",
    "workers",
  ],
  template: [
    "allowedCudaVersions",
    "args",
    "category",
    "cmd",
    "disk",
    "entrypoint",
    "env",
    "image",
    "mounts",
    "name",
    "ports",
    "public",
    "registry",
    "serverless",
    "startJupyter",
    "startSsh",
  ],
  volume: ["dataCenter", "name", "size", "type"],
};

function expectOnlyDocumented(body: Record<string, unknown>, kind: string) {
  expect(Object.keys(body).filter((k) => !DOCUMENTED_BODY[kind]!.includes(k))).toEqual([]);
}

/** Field names of v1 bodies that v2 would answer with a 422, at any depth. */
const V1_BODY_FIELDS =
  /"(interruptible|computeType|cloudType|imageName|containerDiskInGb|volumeInGb|volumeMountPath|containerRegistryAuthId|gpuTypeIds|gpuCount|cpuFlavorIds|dataCenterPriority|networkVolumeId|dockerStartCmd|isServerless|isPublic|readme|workersMin|workersMax|scalerType|scalerValue|executionTimeoutMs|pricing)"/;

describe("auth and errors", () => {
  it("sends the key as a Bearer token to REST and GraphQL, bare to Serverless", async () => {
    route("GET", "/v2/serverless", page("endpoints", [ENDPOINT]));
    route("GET", "/v2/catalog/gpus", { gpus: [] });
    route("GET", "sls:/4m7x2k9q/health", { jobs: { inQueue: 2 }, workers: { idle: 1 } });
    await client().listResources("serverless-endpoint", "acct");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer rpa_KEY");
    const sls = calls.find((c) => c.url.host === "api.runpod.ai")!;
    expect(sls.headers["Authorization"]).toBe("rpa_KEY");
  });

  it("reads the problem details REST v2 answers with", async () => {
    route(
      "GET",
      "/v2/templates",
      () =>
        new Response(
          JSON.stringify({
            title: "Unprocessable Entity",
            status: 422,
            detail: "validation failed",
            errors: ["$: additional properties 'bogus' not allowed"],
          }),
          { status: 422 },
        ),
    );
    route("POST", "graphql:RunpodTemplateExtras", { data: { myself: { podTemplates: [] } } });
    const err = await client()
      .listResources("template", "acct")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunpodApiError);
    expect((err as RunpodApiError).status).toBe(422);
    expect((err as Error).message).toContain(
      "validation failed: $: additional properties 'bogus' not allowed",
    );
  });

  it("turns GraphQL errors into status-bearing errors", async () => {
    route("POST", "graphql:RunpodAccount", {
      errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }],
    });
    await expect(client().fetchCreditBalance("acct")).rejects.toThrow(/All or Read Only/);
  });

  it("uses services.http when the host provides it", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ registries: [] }),
      headers: {},
    }));
    const c = hostClient(
      new RunpodClient({ apiKey: "rpa_KEY", caCert: "PEM" }, RESOURCE_TYPES, {
        http: { request },
      } as never),
    );
    await c.listResources("container-registry-auth", "acct");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.runpod.io/v2/registries",
        caCert: "PEM",
        headers: expect.objectContaining({ Authorization: "Bearer rpa_KEY" }),
      }),
    );
  });
});

describe("egress", () => {
  it("allowlists exactly the hosts it calls, so bastion routing keeps working", async () => {
    expect([...manifest.egressHosts].sort()).toEqual(["api.runpod.ai", "api.runpod.io"]);
    route("GET", "/v2/serverless", page("endpoints", [ENDPOINT]));
    route("GET", "/v2/catalog/gpus", { gpus: [] });
    route("GET", "sls:/4m7x2k9q/health", {});
    route("POST", "graphql:RunpodAccount", { data: { myself: { clientBalance: 1 } } });
    const c = client();
    await c.listResources("serverless-endpoint", "acct");
    await c.fetchCreditBalance("acct");
    expect(new Set(calls.map((x) => x.url.host))).toEqual(new Set(manifest.egressHosts));
  });
});

describe("paging", () => {
  beforeEach(() => {
    route("POST", "graphql:RunpodPodExtras", { data: { myself: { pods: [] } } });
  });

  it("follows the cursor across every page", async () => {
    const pages: Record<string, unknown> = {
      first: {
        pods: [{ ...LISTED_POD, id: "a" }],
        pagination: { nextCursor: "c2", hasNextPage: true },
      },
      c2: {
        pods: [{ ...LISTED_POD, id: "b" }],
        pagination: { nextCursor: "c3", hasNextPage: true },
      },
      c3: { pods: [{ ...LISTED_POD, id: "c" }], pagination: LAST_PAGE },
    };
    route("GET", "/v2/pods", (c: Call) => pages[c.url.searchParams.get("cursor") ?? "first"]);
    const pods = await client().listResources("pod", "acct");
    expect(pods.map((p) => p.externalId)).toEqual(["a", "b", "c"]);
    const asked = calls.filter((c) => c.url.pathname === "/v2/pods");
    expect(asked.map((c) => c.url.search)).toEqual([
      "?limit=1000",
      "?limit=1000&cursor=c2",
      "?limit=1000&cursor=c3",
    ]);
  });

  it("reads past an empty page that says there is more", async () => {
    route("GET", "/v2/pods", (c: Call) =>
      c.url.searchParams.get("cursor")
        ? page("pods", [LISTED_POD])
        : { pods: [], pagination: { nextCursor: "c2", hasNextPage: true } },
    );
    expect(await client().listResources("pod", "acct")).toHaveLength(1);
  });

  it.each([
    ["a page whose list is not an array", { pods: { oops: true }, pagination: LAST_PAGE }],
    ["a renamed list key", { items: [LISTED_POD], pagination: LAST_PAGE }],
    ["a provider error wrapped in a 200", { error: "try later" }],
    ["no pagination block", { pods: [LISTED_POD] }],
    ["a JSON null", null],
  ])("throws rather than read %s as the end of the list", async (_name, body) => {
    route("GET", "/v2/pods", () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(client().listResources("pod", "acct")).rejects.toThrow(/unexpected page/);
  });

  it("throws on an empty 200", async () => {
    route("GET", "/v2/pods", () => new Response("", { status: 200 }));
    await expect(client().listResources("pod", "acct")).rejects.toThrow(/unexpected page/);
  });

  it("throws when a later page is bad, keeping nothing of the earlier ones", async () => {
    route("GET", "/v2/pods", (c: Call) =>
      c.url.searchParams.get("cursor")
        ? { pods: "nope", pagination: LAST_PAGE }
        : { pods: [LISTED_POD], pagination: { nextCursor: "c2", hasNextPage: true } },
    );
    await expect(client().listResources("pod", "acct")).rejects.toThrow(/after 1 items/);
  });

  it("throws when a later page fails", async () => {
    route("GET", "/v2/pods", (c: Call) =>
      c.url.searchParams.get("cursor")
        ? new Response("{}", { status: 500 })
        : { pods: [LISTED_POD], pagination: { nextCursor: "c2", hasNextPage: true } },
    );
    await expect(client().listResources("pod", "acct")).rejects.toThrow(RunpodApiError);
  });

  it("throws when more is promised with no cursor, or the same one again", async () => {
    route("GET", "/v2/pods", {
      pods: [LISTED_POD],
      pagination: { nextCursor: null, hasNextPage: true },
    });
    await expect(client().listResources("pod", "acct")).rejects.toThrow(/no new cursor/);
    route("GET", "/v2/pods", {
      pods: [LISTED_POD],
      pagination: { nextCursor: "same", hasNextPage: true },
    });
    await expect(client().listResources("pod", "acct")).rejects.toThrow(/no new cursor/);
  });

  it("throws at the page cap rather than return part of the list", async () => {
    let n = 0;
    route("GET", "/v2/pods", () => ({
      pods: [LISTED_POD],
      pagination: { nextCursor: `c${++n}`, hasNextPage: true },
    }));
    await expect(client().listResources("pod", "acct")).rejects.toThrow(/within 100 pages/);
    expect(n).toBe(100);
  });

  it("pages Serverless endpoints, templates and network volumes the same way", async () => {
    for (const [path, key, row, type] of [
      ["/v2/serverless", "endpoints", ENDPOINT, "serverless-endpoint"],
      ["/v2/templates", "templates", TEMPLATE, "template"],
      ["/v2/network-volumes", "networkVolumes", VOLUME, "network-volume"],
    ] as const) {
      route("GET", path, (c: Call) =>
        c.url.searchParams.get("cursor")
          ? page(key, [{ ...row, id: "two" }])
          : { [key]: [{ ...row, id: "one" }], pagination: { nextCursor: "n", hasNextPage: true } },
      );
      route("GET", "/v2/catalog/gpus", { gpus: [] });
      route("GET", "/v2/pods", page("pods", []));
      route("GET", "sls:/one/health", {});
      route("GET", "sls:/two/health", {});
      route("POST", "graphql:RunpodTemplateExtras", { data: {} });
      if (key !== "endpoints") route("GET", "/v2/serverless", page("endpoints", []));
      const rows = await client().listResources(type, "acct");
      expect(rows.map((r) => r.externalId)).toEqual(["one", "two"]);
      route("GET", path, { [key]: "broken", pagination: LAST_PAGE });
      await expect(client().listResources(type, "acct")).rejects.toThrow(/unexpected page/);
    }
  });

  it("throws on a registry list with no array, which has no paging at all", async () => {
    route("GET", "/v2/registries", { items: [] });
    await expect(client().listResources("container-registry-auth", "acct")).rejects.toThrow(
      /no list of registries/,
    );
  });
});

describe("pods", () => {
  it("merges a listed pod with GraphQL's runtime, and sends no removed query", async () => {
    route(
      "GET",
      "/v2/pods",
      page("pods", [LISTED_POD, { ...LISTED_POD, id: "pod2", status: "EXITED", mounts: {} }]),
    );
    route("POST", "graphql:RunpodPodExtras", {
      data: {
        myself: {
          pods: [
            {
              id: POD.id,
              adjustedCostPerHr: 0.4,
              lastStatusChange: "Rented by User",
              machine: {
                location: "US",
                gpuDisplayName: "RTX 4090",
                maintenanceStart: "2026-12-01T00:00:00Z",
                maintenanceEnd: "2026-12-02T00:00:00Z",
                maintenanceNote: "kernel",
              },
              runtime: {
                uptimeInSeconds: 60,
                container: { cpuPercent: 12, memoryPercent: 40 },
                gpus: [
                  { gpuUtilPercent: 90, memoryUtilPercent: 50 },
                  { gpuUtilPercent: 70, memoryUtilPercent: 30 },
                ],
                ports: [
                  {
                    ip: "10.0.0.1",
                    isIpPublic: false,
                    privatePort: 22,
                    publicPort: 1,
                    type: "tcp",
                  },
                  {
                    ip: "1.2.3.4",
                    isIpPublic: true,
                    privatePort: 22,
                    publicPort: 10341,
                    type: "tcp",
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const pods = await client().listResources("pod", "acct");
    const p = pods.find((x) => x.externalId === POD.id)!;
    expect(p.fields).toMatchObject({
      status: "running",
      region: "US-KS-2",
      location: "US",
      cloudType: "Secure Cloud",
      computeType: "GPU",
      gpuCount: 1,
      gpuType: "RTX 4090",
      gpuTypeId: "NVIDIA GeForce RTX 4090",
      vcpus: 16,
      memoryGb: 64,
      containerDiskGb: 50,
      volumeGb: 20,
      volumeMountPath: "/workspace",
      costPerHr: 0.44,
      adjustedCostPerHr: 0.4,
      gpuUtilPercent: 80,
      gpuMemoryUtilPercent: 40,
      cpuPercent: 12,
      uptimeSeconds: 60,
      envKeys: "MODEL_NAME",
      sshUser: "7h9k2m4n6p-64411eb2",
      maintenance: "2026-12-01T00:00:00Z to 2026-12-02T00:00:00Z: kernel",
      lastStartedAt: "2026-06-01T12:02:00Z",
    });
    expect(JSON.stringify(p.fields)).not.toContain("llama-3");
    for (const gone of ["interruptible", "machineId", "endpointId"]) {
      expect(p.fields).not.toHaveProperty(gone);
    }
    expect(p.resolvedOutputs).toMatchObject({
      publicIp: "1.2.3.4",
      sshCommand: "ssh 7h9k2m4n6p-64411eb2@ssh.runpod.io",
      directSshCommand: "ssh root@1.2.3.4 -p 10341",
      httpProxyUrl: `https://${POD.id}-8888.proxy.runpod.net`,
      sshProxyHost: "ssh.runpod.io",
    });
    expect(p.createdAt).toBe("2026-06-01T12:00:00Z");
    expect(pods.find((x) => x.externalId === "pod2")!.fields["status"]).toBe("stopped");
    const asked = calls.find((c) => c.url.pathname === "/v2/pods")!;
    expect([...asked.url.searchParams.keys()]).toEqual(["limit"]);
  });

  it("reads runtime and direct SSH from REST on a single pod", async () => {
    route("GET", `/v2/pods/${POD.id}`, POD);
    route("POST", "graphql:RunpodPodExtras", () => new Response("{}", { status: 403 }));
    const p = await client().getResource("pod", `acct:pod:${POD.id}`, "acct");
    expect(p.fields).toMatchObject({
      gpuUtilPercent: 94,
      gpuMemoryUtilPercent: 78,
      cpuPercent: 45,
      memoryPercent: 60,
      uptimeSeconds: 3600,
      gpuType: "NVIDIA GeForce RTX 4090",
      adjustedCostPerHr: 0.44,
    });
    expect(p.resolvedOutputs["directSshCommand"]).toBe("ssh root@195.26.233.3 -p 34446");
    expect(p.resolvedOutputs["publicIp"]).toBe("195.26.233.3");
  });

  it("still lists pods when GraphQL is refused", async () => {
    route("GET", "/v2/pods", page("pods", [LISTED_POD]));
    route("POST", "graphql:RunpodPodExtras", () => new Response("{}", { status: 403 }));
    const [p] = await client().listResources("pod", "acct");
    expect(p!.fields["status"]).toBe("running");
    expect(p!.resolvedOutputs["sshCommand"]).toBe("ssh 7h9k2m4n6p-64411eb2@ssh.runpod.io");
    expect(p!.resolvedOutputs["directSshCommand"]).toBe("");
  });

  it.each([
    ["PROVISIONING", "starting"],
    ["STARTING", "starting"],
    ["RUNNING", "running"],
    ["EXITED", "stopped"],
    ["ERROR", "error"],
    ["TERMINATED", "terminated"],
  ] as const)("reads status %s as %s", async (status, expected) => {
    route("GET", `/v2/pods/${POD.id}`, { ...POD, status });
    route("POST", "graphql:RunpodPodExtras", { data: {} });
    const p = await client().getResource("pod", `acct:pod:${POD.id}`, "acct");
    expect(p.fields["status"]).toBe(expected);
  });

  it("maps a CPU pod, and shows every network volume it mounts", async () => {
    route("GET", "/v2/pods/cpu1", {
      ...POD,
      id: "cpu1",
      gpu: undefined,
      cpu: { id: "cpu5c", vcpuCount: 4, memory: 16 },
      mounts: {
        network: [
          { volumeId: "v1", path: "/a" },
          { volumeId: "v2", path: "/b" },
        ],
      },
    });
    route("POST", "graphql:RunpodPodExtras", { data: {} });
    const p = await client().getResource("pod", "acct:pod:cpu1", "acct");
    expect(p.fields).toMatchObject({
      computeType: "CPU",
      cpuFlavorId: "cpu5c",
      vcpus: 4,
      memoryGb: 16,
      gpuCount: 0,
      networkVolumeId: "v1",
      additionalNetworkVolumes: "v2",
      volumeMountPath: "/a",
    });
  });

  const GPU_FORM = {
    name: "p",
    computeType: "GPU",
    gpuTypeId: "NVIDIA H100 80GB HBM3",
    gpuCount: "2",
    cloudType: "COMMUNITY",
    dataCenterId: "US-TX-3",
    templateId: "none",
    imageName: "img",
    containerDiskInGb: "40",
    volumeInGb: "30",
    volumeMountPath: "/workspace",
    ports: "8888/http, 22/tcp",
    networkVolumeId: "none",
    containerRegistryAuthId: "auth1",
    sshPublicKey: "ssh-ed25519 AAAA me",
    env: "A=1\n# comment\nB=x=y",
  };

  it("builds a GPU pod create body from picker values", async () => {
    route("POST", "/v2/pods", POD);
    await client().createResource("pod", "acct", GPU_FORM);
    expect(calls[0]!.body).toEqual({
      name: "p",
      cloud: "COMMUNITY",
      disk: 40,
      startSsh: true,
      startJupyter: true,
      image: "img",
      dataCenterIds: ["US-TX-3"],
      registry: "auth1",
      ports: ["8888/http", "22/tcp"],
      env: { A: "1", B: "x=y", PUBLIC_KEY: "ssh-ed25519 AAAA me" },
      gpu: { id: "NVIDIA H100 80GB HBM3", count: 2 },
      mounts: { persistent: { size: 30, path: "/workspace" } },
    });
  });

  it("never sends a removed field, even with a stale form value", async () => {
    route("POST", "/v2/pods", POD);
    await client().createResource("pod", "acct", {
      ...GPU_FORM,
      pricing: "spot",
      interruptible: "true",
      machineId: "m1",
    });
    expectOnlyDocumented(calls[0]!.body, "pod");
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(V1_BODY_FIELDS);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("spot");
  });

  it("places a pod where its network volume is, when no data center is chosen", async () => {
    route("GET", "/v2/network-volumes/vol1", VOLUME);
    route("POST", "/v2/pods", POD);
    await client().createResource("pod", "acct", {
      ...GPU_FORM,
      dataCenterId: "any",
      networkVolumeId: "vol1",
      volumeInGb: "0",
      volumeMountPath: "/data",
    });
    const body = calls.find((c) => c.method === "POST")!.body;
    expect(body["dataCenterIds"]).toEqual(["EU-RO-1"]);
    expect(body["mounts"]).toEqual({ network: [{ volumeId: "vol1", path: "/data" }] });
  });

  it("builds a CPU pod with no volume disk, which the document forbids there", async () => {
    route("POST", "/v2/pods", POD);
    await client().createResource("pod", "acct", {
      name: "c",
      computeType: "CPU",
      cpuFlavorId: "cpu5c",
      vcpuCount: "4",
      templateId: "tpl1",
      volumeInGb: "20",
      ports: "",
    });
    const { body } = calls[0]!;
    expect(body["cpu"]).toEqual({ id: "cpu5c", vcpuCount: 4 });
    expect(body["gpu"]).toBeUndefined();
    expect(body["mounts"]).toBeUndefined();
    expect(body["templateId"]).toBe("tpl1");
    expectOnlyDocumented(body, "pod");
  });

  it("refuses a volume below the document's minimum before asking Runpod", async () => {
    await expect(
      client().createResource("pod", "acct", { ...GPU_FORM, volumeInGb: "5" }),
    ).rejects.toThrow(/at least 10 GB/);
    expect(calls).toEqual([]);
  });

  it("sends lifecycle actions through the one action route, with no reset", async () => {
    route("POST", `/v2/pods/pod1/action`, POD);
    route("PATCH", "/v2/pods/pod1", POD);
    const c = client();
    for (const a of ["start", "stop", "restart", "lock"]) {
      await c.invokeAction("pod", "acct:pod:pod1", a, "acct");
    }
    expect(calls.map((x) => [x.method, x.url.pathname, x.body])).toEqual([
      ["POST", "/v2/pods/pod1/action", { action: "start" }],
      ["POST", "/v2/pods/pod1/action", { action: "stop" }],
      ["POST", "/v2/pods/pod1/action", { action: "restart" }],
      ["PATCH", "/v2/pods/pod1", { locked: true }],
    ]);
    await expect(c.invokeAction("pod", "acct:pod:pod1", "reset", "acct")).rejects.toThrow(
      /not supported/,
    );
    expect(calls).toHaveLength(4);
  });

  it("edits a pod with v2 names and grows its volume through mounts", async () => {
    route("GET", "/v2/pods/pod1", POD);
    route("PATCH", "/v2/pods/pod1", POD);
    route("POST", "graphql:RunpodPodExtras", { data: {} });
    await client().updateResource("pod", "acct:pod:pod1", "acct", {
      name: "n",
      imageName: "i2",
      containerDiskGb: "60",
      volumeGb: "40",
      volumeMountPath: "/data",
      ports: "22/tcp",
      locked: "true",
    });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      name: "n",
      image: "i2",
      disk: 60,
      ports: ["22/tcp"],
      locked: true,
      mounts: { persistent: { size: 40, path: "/data" } },
    });
  });

  it("moves the network volume when that is what the pod mounts", async () => {
    route("GET", "/v2/pods/pod1", {
      ...POD,
      mounts: { network: [{ volumeId: "v1", path: "/a" }] },
    });
    route("PATCH", "/v2/pods/pod1", POD);
    route("POST", "graphql:RunpodPodExtras", { data: {} });
    await client().updateResource("pod", "acct:pod:pod1", "acct", { volumeMountPath: "/b" });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      mounts: { network: [{ volumeId: "v1", path: "/b" }] },
    });
  });

  it("refuses to shrink a pod's volume below the minimum", async () => {
    route("GET", "/v2/pods/pod1", POD);
    await expect(
      client().updateResource("pod", "acct:pod:pod1", "acct", { volumeGb: "0" }),
    ).rejects.toThrow(/at least 10 GB/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("create forms", () => {
  it("fills the pod form from the catalog, with no pricing or spot option", async () => {
    route("GET", "/v2/catalog/gpus", (c: Call) => {
      expect(c.url.search).toBe("?include=AVAILABILITY&product=POD");
      return { gpus: [GPU] };
    });
    route("GET", "/v2/catalog/cpus", { cpus: [CPU] });
    route("GET", "/v2/catalog/datacenters", { dataCenters: [DATA_CENTER] });
    route("GET", "/v2/templates", page("templates", [TEMPLATE]));
    route("GET", "/v2/catalog/templates", {
      templates: [{ ...TEMPLATE, id: "official1", name: "PyTorch" }],
      pagination: LAST_PAGE,
    });
    route("GET", "/v2/network-volumes", page("networkVolumes", [VOLUME]));
    route("GET", "/v2/registries", { registries: [{ id: "reg1", name: "ghcr" }] });
    const { fields } = await client().getCreateConfig("pod");
    const byKey = new Map(fields.map((f) => [f.key, f]));
    expect(byKey.has("pricing")).toBe(false);
    expect(JSON.stringify(fields)).not.toMatch(/spot|interruptible/i);
    expect(byKey.get("gpuTypeId")!.options![0]).toMatchObject({
      id: "NVIDIA GeForce RTX 4090",
      description: "24 GB VRAM · Secure $0.44/hr · Community $0.31/hr · Stock: HIGH",
    });
    expect(byKey.get("cpuFlavorId")!.options![0]!.id).toBe("cpu5c");
    expect(byKey.get("dataCenterId")!.regions![1]).toMatchObject({
      id: "US-KS-2",
      location: "US Kansas 2",
      availableFor: ["NVIDIA GeForce RTX 4090"],
    });
    expect(byKey.get("templateId")!.options!.map((o) => [o.id, o.description])).toEqual([
      ["none", undefined],
      ["tpl_abc", TEMPLATE.image],
      ["official1", `Runpod official · ${TEMPLATE.image}`],
    ]);
    expect(byKey.get("networkVolumeId")!.options![1]!.description).toContain("EU-RO-1");
  });

  it("offers pools on the Serverless form, and filters data centers by pool", async () => {
    route("GET", "/v2/catalog/gpus", (c: Call) => {
      expect(c.url.search).toBe("?include=AVAILABILITY&product=SERVERLESS");
      return {
        gpus: [
          GPU,
          { ...GPU, id: "NVIDIA RTX 4090 Ti", name: "RTX 4090 Ti", availability: "LOW" },
          { ...GPU, id: "No pool", pool: null },
        ],
      };
    });
    route("GET", "/v2/catalog/cpus", { cpus: [CPU] });
    route("GET", "/v2/catalog/datacenters", { dataCenters: [DATA_CENTER] });
    route("GET", "/v2/templates", page("templates", [{ ...TEMPLATE, serverless: true }]));
    route("GET", "/v2/network-volumes", page("networkVolumes", []));
    const { fields } = await client().getCreateConfig("serverless-endpoint");
    const byKey = new Map(fields.map((f) => [f.key, f]));
    expect(byKey.get("gpuPool")!.options).toEqual([
      {
        id: "ADA_24",
        label: "RTX 4090, RTX 4090 Ti (ADA_24)",
        description: "24 GB VRAM · $1.10/hr per GPU · Stock: HIGH",
      },
    ]);
    expect(byKey.get("dataCenterId")!.filterByFieldKey).toBe("gpuPool");
    expect(byKey.get("dataCenterId")!.regions![1]!.availableFor).toEqual(["ADA_24"]);
    expect(byKey.get("flashboot")!.options!.map((o) => o.id)).toEqual([
      "FLASHBOOT",
      "PRIORITY_FLASHBOOT",
      "OFF",
    ]);
    expect(byKey.has("scalerType")).toBe(true);
    expect(byKey.has("endpointType")).toBe(true);
  });

  it("offers only data centers with network storage for a network volume", async () => {
    route("GET", "/v2/catalog/datacenters", {
      dataCenters: [DATA_CENTER, { ...DATA_CENTER, id: "NO-STORE-1", networkVolumeTypes: [] }],
    });
    const { fields } = await client().getCreateConfig("network-volume");
    const dc = fields.find((f) => f.key === "dataCenterId")!;
    expect(dc.regions!.map((r) => r.id)).toEqual(["US-KS-2"]);
    const size = fields.find((f) => f.key === "size")!;
    expect([size.minValue, size.maxValue]).toEqual([10, 4096]);
  });
});

describe("serverless endpoints", () => {
  it("maps the nested v2 shape, with queue health and run URLs", async () => {
    route("GET", "/v2/serverless", page("endpoints", [ENDPOINT]));
    route("GET", "/v2/catalog/gpus", {
      gpus: [GPU, { ...GPU, id: "Excluded" }, { ...GPU, id: "Other", pool: "AMPERE_16" }],
    });
    route("GET", "sls:/4m7x2k9q/health", {
      jobs: { inQueue: 2, inProgress: 1, completed: 10, failed: 1 },
      workers: { idle: 1, running: 2 },
    });
    const [e] = await client().listResources("serverless-endpoint", "acct");
    expect(e!.fields).toMatchObject({
      endpointType: "QUEUE",
      computeType: "GPU",
      imageName: ENDPOINT.image,
      gpuPools: "ADA_24",
      gpuTypeIds: "NVIDIA GeForce RTX 4090, Excluded",
      gpuCount: 1,
      workersMin: 0,
      workersMax: 5,
      idleTimeout: 5,
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
      executionTimeoutMs: 300000,
      flashboot: "OFF",
      region: "US-KS-2",
      networkVolumeId: "2q9m7x4c",
      jobsInQueue: 2,
      workersRunning: 2,
    });
    expect(e!.fields["workersThrottled"]).toBeUndefined();
    for (const gone of ["version", "templateId"]) expect(e!.fields).not.toHaveProperty(gone);
    expect(e!.resolvedOutputs["runSyncUrl"]).toBe("https://api.runpod.ai/v2/4m7x2k9q/runsync");
    expect(new URL(calls[0]!.url).searchParams.has("includeTemplate")).toBe(false);
  });

  it("purges the queue on the Serverless host", async () => {
    route("POST", "sls:/ep1/purge-queue", { removed: 2, status: "completed" });
    await client().invokeAction(
      "serverless-endpoint",
      "acct:serverless-endpoint:ep1",
      "purge-queue",
      "acct",
    );
    expect(calls[0]!.url.toString()).toBe("https://api.runpod.ai/v2/ep1/purge-queue");
  });

  it("leaves a load balancing endpoint's workers alone, and gives its own URL", async () => {
    const balanced: RpEndpoint = {
      ...ENDPOINT,
      type: "LOAD_BALANCER",
      requestUrls: {
        base: "https://4m7x2k9q.api.runpod.ai",
        health: "https://4m7x2k9q.api.runpod.ai/ping",
      },
      scaling: { type: "REQUEST_COUNT", requestCount: 4 },
    };
    route("GET", "/v2/serverless", page("endpoints", [balanced]));
    route("GET", "/v2/catalog/gpus", { gpus: [] });
    const c = client();
    const [e] = await c.listResources("serverless-endpoint", "acct");
    expect(calls.some((x) => x.url.host === "api.runpod.ai")).toBe(false);
    expect(e!.resolvedOutputs).toEqual({
      loadBalancerUrl: "https://4m7x2k9q.api.runpod.ai",
      endpointId: "4m7x2k9q",
    });
    expect(e!.fields["scalerValue"]).toBe(4);
  });

  const FORM = {
    name: "e",
    templateId: "tpl1",
    endpointType: "QUEUE",
    computeType: "GPU",
    gpuPool: "ADA_24",
    gpuCount: "1",
    workersMin: "0",
    workersMax: "3",
    scalerType: "QUEUE_DELAY",
    scalerValue: "4",
    idleTimeout: "5",
    executionTimeoutMs: "300000",
    flashboot: "FLASHBOOT",
    dataCenterId: "US-KS-2",
    networkVolumeId: "vol1",
  };

  it("builds a GPU endpoint with only documented fields", async () => {
    route("POST", "/v2/serverless", ENDPOINT);
    await client().createResource("serverless-endpoint", "acct", {
      ...FORM,
      gpuTypeId: "stale",
      version: "3",
    });
    const { body } = calls[0]!;
    expect(body).toEqual({
      name: "e",
      templateId: "tpl1",
      type: "QUEUE",
      scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
      workers: { min: 0, max: 3, idleTimeout: 5 },
      timeout: 300000,
      flashboot: "FLASHBOOT",
      dataCenterIds: ["US-KS-2"],
      mounts: { network: [{ volumeId: "vol1" }] },
      gpu: { pools: ["ADA_24"], count: 1 },
    });
    expectOnlyDocumented(body, "endpoint");
  });

  it("builds a CPU endpoint from an image, with no template", async () => {
    route("POST", "/v2/serverless", ENDPOINT);
    await client().createResource("serverless-endpoint", "acct", {
      ...FORM,
      templateId: "none",
      imageName: "python:3.11-slim",
      computeType: "CPU",
      cpuFlavorId: "cpu5c",
      vcpuCount: "4",
      flashboot: "OFF",
      dataCenterId: "any",
      networkVolumeId: "none",
    });
    const { body } = calls[0]!;
    expect(body["cpu"]).toEqual([{ id: "cpu5c", vcpuCount: 4 }]);
    expect(body["image"]).toBe("python:3.11-slim");
    expect(body["gpu"]).toBeUndefined();
    expect(body["templateId"]).toBeUndefined();
    expect(body["flashboot"]).toBe("OFF");
    expect(body["dataCenterIds"]).toBeUndefined();
  });

  it("leaves out idleTimeout on a queue endpoint scaling by request count", async () => {
    route("POST", "/v2/serverless", ENDPOINT);
    await client().createResource("serverless-endpoint", "acct", {
      ...FORM,
      scalerType: "REQUEST_COUNT",
    });
    expect(calls[0]!.body["workers"]).toEqual({ min: 0, max: 3 });
    expect(calls[0]!.body["scaling"]).toEqual({ type: "REQUEST_COUNT", requestCount: 4 });
  });

  it("refuses queue delay scaling on a load balancer before asking Runpod", async () => {
    await expect(
      client().createResource("serverless-endpoint", "acct", {
        ...FORM,
        endpointType: "LOAD_BALANCER",
      }),
    ).rejects.toThrow(/request count/);
    expect(calls).toEqual([]);
  });

  describe("edits", () => {
    const edit = (fields: Record<string, string>) =>
      client().updateResource(
        "serverless-endpoint",
        "acct:serverless-endpoint:ep1",
        "acct",
        fields,
      );

    beforeEach(() => {
      route("GET", "/v2/serverless/ep1", { ...ENDPOINT, id: "ep1" });
      route("PATCH", "/v2/serverless/ep1", { ...ENDPOINT, id: "ep1" });
      route("GET", "/v2/catalog/gpus", { gpus: [] });
      route("GET", "sls:/ep1/health", {});
    });
    const patched = () => calls.find((c) => c.method === "PATCH")!.body;

    it("nests worker counts and keeps the ones not edited", async () => {
      await edit({ workersMax: "9" });
      expect(patched()).toEqual({ workers: { min: 0, max: 9, idleTimeout: 5 } });
    });

    it("sends a scaler whole when only its threshold changes", async () => {
      await edit({ scalerValue: "0.5" });
      expect(patched()).toEqual({ scaling: { type: "QUEUE_DELAY", queueDelay: 0.5 } });
    });

    it("switches scaler, naming the new variant's field", async () => {
      await edit({ scalerType: "REQUEST_COUNT", scalerValue: "3" });
      expect(patched()).toEqual({ scaling: { type: "REQUEST_COUNT", requestCount: 3 } });
    });

    it("refuses an idle timeout where the document rejects one", async () => {
      await expect(edit({ scalerType: "REQUEST_COUNT", idleTimeout: "10" })).rejects.toThrow(
        /idle timeout does not apply/,
      );
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("renames the timeout, and sends no read when nothing depends on one", async () => {
      await edit({ executionTimeoutMs: "1000", name: "n" });
      expect(patched()).toEqual({ name: "n", timeout: 1000 });
      expect(calls[0]!.method).toBe("PATCH");
    });

    it("sends FlashBoot as its enum, including turning it off (#428)", async () => {
      await edit({ flashboot: "OFF" });
      expect(patched()).toEqual({ flashboot: "OFF" });
    });

    it("shows the FlashBoot the API reports, not a default (#428)", async () => {
      route("GET", "/v2/serverless/ep1", {
        ...ENDPOINT,
        id: "ep1",
        flashboot: "PRIORITY_FLASHBOOT",
      });
      const e = await edit({});
      expect(e.fields["flashboot"]).toBe("PRIORITY_FLASHBOOT");
    });
  });

  it("reads FlashBoot form values, and booleans stored before the enum", () => {
    expect(flashbootMode("true")).toBe("FLASHBOOT");
    expect(flashbootMode("false")).toBe("OFF");
    expect(flashbootMode("PRIORITY_FLASHBOOT")).toBe("PRIORITY_FLASHBOOT");
    expect(() => flashbootMode("sometimes")).toThrow(/not a FlashBoot mode/);
  });
});

describe("templates", () => {
  it("maps a template, with the readme from GraphQL", async () => {
    route("GET", "/v2/templates", page("templates", [TEMPLATE]));
    route("POST", "graphql:RunpodTemplateExtras", {
      data: { myself: { podTemplates: [{ id: "tpl_abc", readme: "# hi", earned: 2 }] } },
    });
    const [t] = await client().listResources("template", "acct");
    expect(t!.fields).toMatchObject({
      imageName: TEMPLATE.image,
      isServerless: false,
      containerDiskGb: 50,
      volumeGb: 20,
      volumeMountPath: "/workspace",
      ports: "8888/http",
      isPublic: false,
      readme: "# hi",
      earned: 2,
    });
  });

  it("still lists templates when GraphQL is refused", async () => {
    route("GET", "/v2/templates", page("templates", [TEMPLATE]));
    route("POST", "graphql:RunpodTemplateExtras", () => new Response("{}", { status: 403 }));
    const [t] = await client().listResources("template", "acct");
    expect(t!.fields["readme"]).toBe("");
  });

  it("shows a shell command as typed, and a stored JSON command as stored", async () => {
    route("POST", "graphql:RunpodTemplateExtras", { data: {} });
    const read = async (over: Partial<RpTemplate>) => {
      route("GET", "/v2/templates/t", { ...TEMPLATE, id: "t", ...over });
      return (await client().getResource("template", "acct:template:t", "acct")).fields[
        "startCommand"
      ];
    };
    expect(await read({ args: "--port 8000" })).toBe("--port 8000");
    expect(await read({ args: '{"cmd":["bash"]}', cmd: ["bash", "-c", "cd /w && go"] })).toBe(
      "cd /w && go",
    );
    const stored = '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}';
    expect(
      await read({ args: stored, entrypoint: ["/bin/bash", "-c"], cmd: ["python -u main.py"] }),
    ).toBe(stored);
  });

  it("creates a template with only documented fields", async () => {
    route("POST", "/v2/templates", TEMPLATE);
    await client().createResource("template", "acct", {
      name: "t",
      imageName: "img",
      isServerless: "false",
      category: "AMD",
      containerDiskInGb: "50",
      volumeInGb: "20",
      volumeMountPath: "/workspace",
      ports: "8888/http",
      startCommand: "python app.py --port 8000",
      env: "A=1",
      containerRegistryAuthId: "reg1",
      readme: "stale form value",
    });
    expect(calls[0]!.body).toEqual({
      name: "t",
      image: "img",
      serverless: false,
      category: "AMD",
      disk: 50,
      ports: ["8888/http"],
      mounts: { persistent: { size: 20, path: "/workspace" } },
      args: "python app.py --port 8000",
      env: { A: "1" },
      registry: "reg1",
    });
    expectOnlyDocumented(calls[0]!.body, "template");
  });

  it("gives a Serverless template no volume", async () => {
    route("POST", "/v2/templates", TEMPLATE);
    await client().createResource("template", "acct", {
      name: "t",
      imageName: "img",
      isServerless: "true",
      volumeInGb: "20",
    });
    expect(calls[0]!.body["mounts"]).toBeUndefined();
  });

  it("edits with v2 names, and sends a mount whole", async () => {
    route("GET", "/v2/templates/t", TEMPLATE);
    route("PATCH", "/v2/templates/t", TEMPLATE);
    route("POST", "graphql:RunpodTemplateExtras", { data: {} });
    await client().updateResource("template", "acct:template:t", "acct", {
      name: "n",
      imageName: "i2",
      containerDiskGb: "60",
      volumeGb: "40",
      ports: "22/tcp",
      startCommand: "cd /w && ./run.sh",
      isPublic: "true",
      readme: "stale form value",
    });
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      name: "n",
      image: "i2",
      disk: 60,
      ports: ["22/tcp"],
      public: true,
      cmd: ["bash", "-c", "cd /w && ./run.sh"],
      mounts: { persistent: { size: 40, path: "/workspace" } },
    });
  });
});

describe("network volumes", () => {
  it("records every pod and endpoint that mounts each volume", async () => {
    route(
      "GET",
      "/v2/network-volumes",
      page("networkVolumes", [
        { ...VOLUME, id: "vol1", dataCenter: "EU-RO-1" },
        { ...VOLUME, id: "vol2", dataCenter: "US-TX-3", type: "HIGH_PERFORMANCE" },
        { ...VOLUME, id: "vol3" },
      ]),
    );
    route(
      "GET",
      "/v2/pods",
      page("pods", [
        {
          ...LISTED_POD,
          id: "pod1",
          mounts: {
            network: [
              { volumeId: "vol1", path: "/a" },
              { volumeId: "vol2", path: "/b" },
            ],
          },
        },
        {
          ...LISTED_POD,
          id: "gone",
          status: "TERMINATED",
          mounts: { network: [{ volumeId: "vol3", path: "/a" }] },
        },
      ]),
    );
    route(
      "GET",
      "/v2/serverless",
      page("endpoints", [
        {
          ...ENDPOINT,
          id: "ep1",
          mounts: { network: [{ volumeId: "vol1" }], global: [] },
          networkVolumes: [],
        },
      ]),
    );
    const vols = await client().listResources("network-volume", "acct");
    expect(vols.map((v) => [v.externalId, v.fields["region"], v.fields["attachedTo"]])).toEqual([
      ["vol1", "EU-RO-1", "pod1, ep1"],
      ["vol2", "US-TX-3", "pod1"],
      ["vol3", "EU-RO-1", ""],
    ]);
    expect(vols[1]!.fields["storageType"]).toBe("HIGH_PERFORMANCE");
  });

  it("does not call a volume unused when the mounts could not be read", async () => {
    route("GET", "/v2/network-volumes", page("networkVolumes", [VOLUME]));
    route("GET", "/v2/pods", { pods: "broken", pagination: LAST_PAGE });
    route("GET", "/v2/serverless", page("endpoints", []));
    const [v] = await client().listResources("network-volume", "acct");
    expect(v!.fields).not.toHaveProperty("attachedTo");
  });

  it("refuses to shrink", async () => {
    route(
      "GET",
      "/v2/network-volumes",
      page("networkVolumes", [{ ...VOLUME, id: "vol1", size: 100 }]),
    );
    route("GET", "/v2/pods", page("pods", []));
    route("GET", "/v2/serverless", page("endpoints", []));
    await expect(
      client().updateResource("network-volume", "acct:network-volume:vol1", "acct", {
        sizeGb: "50",
      }),
    ).rejects.toThrow(/only grow/);
  });

  it("creates with `dataCenter`, and a tier only when one is chosen", async () => {
    route("POST", "/v2/network-volumes", VOLUME);
    const c = client();
    await c.createResource("network-volume", "acct", {
      name: "v",
      dataCenterId: "US-KS-2",
      size: "50",
      storageType: "default",
    });
    await c.createResource("network-volume", "acct", {
      name: "v",
      dataCenterId: "US-KS-2",
      size: "50",
      storageType: "HIGH_PERFORMANCE",
    });
    expect(calls[0]!.body).toEqual({ name: "v", dataCenter: "US-KS-2", size: 50 });
    expect(calls[1]!.body).toEqual({
      name: "v",
      dataCenter: "US-KS-2",
      size: 50,
      type: "HIGH_PERFORMANCE",
    });
    expectOnlyDocumented(calls[1]!.body, "volume");
  });
});

describe("registries", () => {
  it("lists, creates and deletes on the new path", async () => {
    route("GET", "/v2/registries", { registries: [{ id: "reg1", name: "ghcr" }] });
    route("POST", "/v2/registries", { id: "reg2", name: "r" });
    route("DELETE", "/v2/registries/reg1", () => new Response(null, { status: 204 }));
    const c = client();
    const [r] = await c.listResources("container-registry-auth", "acct");
    expect(r!.displayName).toBe("ghcr");
    await c.createResource("container-registry-auth", "acct", {
      name: "r",
      username: "u",
      password: "p",
    });
    await c.deleteResource("container-registry-auth", r!.id, "acct");
    expect(calls[1]!.body).toEqual({ name: "r", username: "u", password: "p" });
    expect(calls[2]!.url.pathname).toBe("/v2/registries/reg1");
  });
});

describe("ssh keys", () => {
  const ED =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGRvZXNub3RtYXR0ZXJmb3J0ZXN0aW5ncHVycG9zZXM me@laptop";
  const RSA = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 work";

  it("lists, appends and removes keys by replacing the whole set", async () => {
    let stored = [ED, RSA];
    route("GET", "/v2/account/ssh-keys", () => ({ keys: stored }));
    route("PUT", "/v2/account/ssh-keys", (c: Call) => {
      stored = c.body["keys"] as string[];
      return { keys: stored };
    });
    const c = client();
    const keys = await c.listResources("ssh-key", "acct");
    expect(keys.map((k) => k.displayName)).toEqual(["me@laptop", "work"]);
    expect(keys[0]!.fields["fingerprint"]).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    await c.createResource("ssh-key", "acct", {
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRoaXJka2V5",
      name: "ci",
    });
    expect(stored).toHaveLength(3);
    expect(stored[2]).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRoaXJka2V5 ci");

    await c.deleteResource("ssh-key", keys[1]!.id, "acct");
    expect(stored).toEqual([ED, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRoaXJka2V5 ci"]);
    expect(calls.some((x) => x.url.pathname === "/graphql")).toBe(false);
  });

  it("throws rather than read a bad answer as no keys", async () => {
    route("GET", "/v2/account/ssh-keys", { error: "try later" });
    await expect(client().listResources("ssh-key", "acct")).rejects.toThrow(/no list of keys/);
  });
});

describe("account", () => {
  it("reports the balance, spend limit and worker quota", async () => {
    route("POST", "graphql:RunpodAccount", {
      data: {
        myself: {
          clientBalance: 42.5,
          currentSpendPerHr: 1.234,
          spendLimit: 80,
          maxServerlessConcurrency: 10,
        },
      },
    });
    route(
      "GET",
      "/v2/serverless",
      page("endpoints", [
        { ...ENDPOINT, id: "a", workers: { min: 0, max: 3 } },
        { ...ENDPOINT, id: "b", workers: { min: 0, max: 4 } },
      ]),
    );
    const c = client();
    expect(await c.fetchCreditBalance("acct")).toEqual([
      { key: "default", label: "Account balance", remaining: 42.5, currency: "USD" },
    ]);
    const quotas = await c.fetchQuotas("acct");
    expect(quotas).toEqual([
      expect.objectContaining({ id: "spend-limit", limit: 80, used: 1.23 }),
      expect.objectContaining({ id: "serverless-workers", limit: 10, used: 7 }),
    ]);
  });

  it("maps savings plans to commitments", async () => {
    route("POST", "graphql:RunpodSavingsPlans", {
      data: {
        myself: {
          savingsPlans: [
            {
              id: "sp1",
              costPerHr: 0.5,
              upfrontCost: 1000,
              startTime: "2026-01-01T00:00:00Z",
              endTime: "2099-01-01T00:00:00Z",
              gpuTypeId: "NVIDIA H100 80GB HBM3",
              podId: "pod1",
            },
          ],
        },
      },
    });
    const [plan] = await client().fetchCommitments("acct");
    expect(plan).toMatchObject({
      id: "sp1",
      kind: "savings_plan",
      state: "active",
      upfrontAmount: 1000,
      hourlyCommitmentAmount: 0.5,
    });
  });

  it("estimates a pod from the catalog's list price, with spot gone", async () => {
    route("GET", "/v2/catalog/gpus", { gpus: [GPU] });
    const c = client();
    const est = await c.estimateCost("pod", {
      gpuTypeId: "NVIDIA GeForce RTX 4090",
      gpuCount: "2",
      cloudType: "COMMUNITY",
      pricing: "spot",
    });
    expect(est?.monthlyAmount).toBeCloseTo(0.31 * 2 * 730, 2);
    expect(est?.partial).toBe(true);
    expect(JSON.stringify(est)).not.toContain("spot");
  });
});

describe("billing", () => {
  const RANGE = { fromDate: "2026-09-01", toDate: "2026-09-30" };

  function routeBilling() {
    route("GET", "/v2/pods", page("pods", [{ ...LISTED_POD, id: "pod1" }]));
    route(
      "GET",
      "/v2/serverless",
      page("endpoints", [{ ...ENDPOINT, id: "ep1", dataCenterIds: ["EU-RO-1"] }]),
    );
    route("GET", "/v2/network-volumes", page("networkVolumes", [{ ...VOLUME, id: "vol1" }]));
    route("GET", "/v2/billing/pods", {
      records: [
        {
          startTime: "2026-09-02T00:00:00Z",
          endTime: "2026-09-03T00:00:00Z",
          podId: "pod1",
          totalAmount: 12.34,
          gpuAmount: 11,
          cpuAmount: 0,
          diskAmount: 1.34,
        },
      ],
      metadata: {},
    });
    route("GET", "/v2/billing/serverless", {
      records: [
        {
          startTime: "2026-09-02T00:00:00Z",
          endTime: "2026-09-03T00:00:00Z",
          serverlessId: "ep1",
          totalAmount: 8.9,
          gpuAmount: 8.9,
          cpuAmount: 0,
          diskAmount: 0,
          feeAmount: 0,
        },
      ],
      metadata: {},
    });
    route("GET", "/v2/billing/network-volumes", {
      records: [
        {
          startTime: "2026-09-02T00:00:00Z",
          endTime: "2026-09-03T00:00:00Z",
          networkVolumeId: "vol1",
          totalAmount: 5.79,
          standardAmount: 5,
          highPerformanceAmount: 0.79,
        },
      ],
      metadata: {},
    });
  }

  it("reads Serverless spend from the Serverless route, never the Public Endpoint one", async () => {
    routeBilling();
    route("GET", "/v2/billing/endpoints", () => {
      throw new Error("/billing/endpoints is Public Endpoint billing");
    });
    const rows = await client().fetchCostData("acct", RANGE);
    const paths = calls.map((c) => c.url.pathname);
    expect(paths).toContain("/v2/billing/serverless");
    expect(paths).not.toContain("/v2/billing/endpoints");
    expect(rows.find((r) => r.service === "Serverless")).toEqual({
      date: "2026-09-02",
      service: "Serverless",
      region: "EU-RO-1",
      resourceId: "ep1",
      tags: { resource_name: "image-generator" },
      currency: "USD",
      amount: 8.9,
    });
  });

  it("asks by the day over the half-open window, with no removed parameter", async () => {
    routeBilling();
    await client().fetchCostData("acct", RANGE);
    for (const path of ["pods", "serverless", "network-volumes"]) {
      const call = calls.find((c) => c.url.pathname === `/v2/billing/${path}`)!;
      expect(Object.fromEntries(call.url.searchParams)).toEqual({
        bucketSize: "day",
        startTime: "2026-09-01T00:00:00Z",
        endTime: "2026-10-01T00:00:00Z",
      });
    }
  });

  it("keeps the spend total, with storage split and not counted twice", async () => {
    routeBilling();
    const rows = await client().fetchCostData("acct", RANGE);
    expect(rows.map((r) => [r.service, r.resourceId, r.amount])).toEqual([
      ["Pods", "pod1", 12.34],
      ["Serverless", "ep1", 8.9],
      ["Network Volumes", "vol1", 5],
      ["High Performance Storage", "vol1", 0.79],
    ]);
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(total).toBeCloseTo(12.34 + 8.9 + 5.79, 6);
  });

  it.each(["pods", "serverless", "network-volumes"])(
    "throws rather than read a bad %s answer as no spend",
    async (path) => {
      routeBilling();
      route("GET", `/v2/billing/${path}`, { oops: [] });
      await expect(client().fetchCostData("acct", RANGE)).rejects.toThrow(/no list of billing/);
    },
  );

  it("explains a refused key", async () => {
    routeBilling();
    route("GET", "/v2/billing/pods", () => new Response('{"detail":"no"}', { status: 403 }));
    await expect(client().fetchCostData("acct", RANGE)).rejects.toThrow(/Read Only permission/);
  });

  it("still attributes spend when a list fails", async () => {
    routeBilling();
    route("GET", "/v2/pods", { pods: "broken", pagination: LAST_PAGE });
    const rows = await client().fetchCostData("acct", RANGE);
    expect(rows.find((r) => r.service === "Pods")).toMatchObject({ resourceId: "pod1" });
  });
});

describe("resources stored before REST v2", () => {
  const stored = (resourceTypeId: string, fields: Record<string, string | number | boolean>) => ({
    id: `acct:${resourceTypeId}:old`,
    pluginId: "runpod",
    resourceTypeId,
    accountId: "acct",
    displayName: "old",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "old",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastSyncedAt: "2026-01-01T00:00:00Z",
  });
  const render = (resource: ReturnType<typeof stored>) =>
    new RunpodClient({ apiKey: "rpa_KEY" }, RESOURCE_TYPES).renderDetail(resource);
  const items = (detail: ReturnType<typeof render>) => JSON.stringify(detail.sections);

  it("renders a pod holding removed fields, and shows none of them", () => {
    const detail = render(
      stored("pod", {
        name: "old",
        status: "running",
        gpuTypeId: "NVIDIA GeForce RTX 4090",
        cloudType: "Secure Cloud",
        interruptible: true,
        machineId: "abc123",
        endpointId: "ep1",
      }),
    );
    const shown = items(detail);
    expect(shown).toContain("old");
    expect(shown).not.toMatch(/interruptible|abc123|Machine|ep1/i);
    expect(detail.instancePricing?.instanceTypes).toEqual(["NVIDIA GeForce RTX 4090"]);
  });

  it("renders an endpoint holding the old FlashBoot boolean and no longer reported fields", () => {
    const detail = render(
      stored("serverless-endpoint", {
        name: "old",
        flashboot: false,
        version: 3,
        templateId: "tpl1",
        gpuTypeIds: "NVIDIA GeForce RTX 4090",
      }),
    );
    const shown = items(detail);
    expect(shown).toContain("FlashBoot");
    expect(shown).not.toMatch(/tpl1|Version/);
    expect(detail.instancePricing?.instanceTypes).toEqual(["NVIDIA GeForce RTX 4090"]);
  });

  it("renders every status a stored pod can hold, with no reset action", () => {
    for (const status of ["running", "starting", "stopped", "terminated", "unknown", "error", ""]) {
      const detail = render(stored("pod", { status, locked: false }));
      const labels = detail.headerActions?.map((a) => a.label) ?? [];
      expect(labels).not.toContain("Reset");
    }
  });
});

describe("pod actions offered", () => {
  const labels = (status: string, locked = false) =>
    new RunpodClient({ apiKey: "rpa_KEY" }, RESOURCE_TYPES)
      .renderDetail({
        id: "a:pod:p",
        pluginId: "runpod",
        resourceTypeId: "pod",
        accountId: "a",
        displayName: "p",
        fields: { status, locked },
        resolvedOutputs: {},
        secretStates: [],
        externalId: "p",
        createdAt: "",
        updatedAt: "",
        lastSyncedAt: "",
      })
      .headerActions?.map((a) => a.label);

  it("matches the document's table of valid transitions", () => {
    expect(labels("running")).toEqual(["Stop", "Restart", "Lock", "Refresh"]);
    expect(labels("starting")).toEqual(["Stop", "Lock", "Refresh"]);
    expect(labels("stopped")).toEqual(["Start", "Lock", "Refresh"]);
    expect(labels("error")).toEqual(["Start", "Lock", "Refresh"]);
    expect(labels("running", true)).toEqual(["Unlock", "Refresh"]);
    expect(labels("terminated")).toEqual(["Refresh"]);
  });
});

describe("helpers", () => {
  it("parses env lines", () => {
    expect(parseEnv("A=1\n\n#x\nB = 2\nbad")).toEqual({ A: "1", B: " 2" });
  });
  it("sends plain start commands as args, and wraps shell ones", () => {
    expect(startCommandBody("python app.py --port 8000")).toEqual({
      args: "python app.py --port 8000",
    });
    expect(startCommandBody("cd /w && ./run.sh")).toEqual({
      cmd: ["bash", "-c", "cd /w && ./run.sh"],
    });
    expect(startCommandBody("  ")).toEqual({ args: "" });
    const stored = '{"entrypoint":["/bin/bash"],"cmd":["x"]}';
    expect(startCommandBody(stored)).toEqual({ args: stored });
  });
});
