import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunpodClient, parseEnv, startCommandArgs } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { RunpodApiError } from "../api.js";

interface Call {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}

type Route = (call: Call) => unknown;

let calls: Call[] = [];
let routes: Record<string, Route> = {};

function route(method: string, key: string, handler: Route | unknown) {
  routes[`${method} ${key}`] = typeof handler === "function" ? (handler as Route) : () => handler;
}

/** Route key: REST path, `graphql:<operation name>`, or `sls:<path>`. */
function keyOf(url: URL, body: unknown): string {
  if (url.host === "rest.runpod.io") return url.pathname.replace(/^\/v1/, "");
  if (url.host === "api.runpod.ai") return `sls:${url.pathname.replace(/^\/v2/, "")}`;
  const q = (body as { query?: string } | undefined)?.query ?? "";
  const m = /(?:query|mutation)\s+(\w+)/.exec(q);
  return `graphql:${m?.[1] ?? "?"}`;
}

beforeEach(() => {
  calls = [];
  routes = {};
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
      if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () => new RunpodClient({ apiKey: "rpa_KEY" }, RESOURCE_TYPES);

const POD = {
  id: "pod1",
  name: "trainer",
  desiredStatus: "RUNNING",
  image: "runpod/pytorch:2.4",
  costPerHr: 0.74,
  adjustedCostPerHr: 0.69,
  gpu: { id: "NVIDIA GeForce RTX 4090", count: 2, displayName: "RTX 4090" },
  machine: { dataCenterId: "EU-RO-1", location: "RO", secureCloud: true },
  publicIp: "1.2.3.4",
  portMappings: { "22": 10341 },
  ports: ["8888/http", "22/tcp"],
  env: { HF_TOKEN: "secret", A: "1" },
  networkVolumeId: "vol1",
  containerDiskInGb: 50,
  volumeInGb: 20,
};

describe("auth and errors", () => {
  it("sends the key as a Bearer token to REST and GraphQL, bare to Serverless", async () => {
    route("GET", "/endpoints", [{ id: "ep1", name: "llm" }]);
    route("GET", "sls:/ep1/health", { jobs: { inQueue: 2 }, workers: { idle: 1, running: 0 } });
    await client().listResources("serverless-endpoint", "acct");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer rpa_KEY");
    const sls = calls.find((c) => c.url.host === "api.runpod.ai")!;
    expect(sls.headers["Authorization"]).toBe("rpa_KEY");
  });

  it("attaches the HTTP status to errors", async () => {
    route("GET", "/templates", () => new Response('{"error":"bad key"}', { status: 401 }));
    const err = await client()
      .listResources("template", "acct")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunpodApiError);
    expect((err as RunpodApiError).status).toBe(401);
    expect((err as Error).message).toContain("bad key");
  });

  it("turns GraphQL errors into status-bearing errors", async () => {
    route("POST", "graphql:RunpodAccount", {
      errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }],
    });
    await expect(client().fetchCreditBalance("acct")).rejects.toThrow(/All or Read Only/);
  });

  it("uses services.http when the host provides it", async () => {
    const request = vi.fn(async () => ({ status: 200, body: "[]", headers: {} }));
    const c = new RunpodClient({ apiKey: "rpa_KEY", caCert: "PEM" }, RESOURCE_TYPES, {
      http: { request },
    } as never);
    await c.listResources("container-registry-auth", "acct");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://rest.runpod.io/v1/containerregistryauth",
        caCert: "PEM",
        headers: expect.objectContaining({ Authorization: "Bearer rpa_KEY" }),
      }),
    );
  });
});

describe("pods", () => {
  it("merges REST pods with GraphQL runtime and SSH proxy ids", async () => {
    route("GET", "/pods", (c: Call) => {
      expect(c.url.searchParams.get("includeMachine")).toBe("true");
      return [POD, { id: "pod2", name: "idle", desiredStatus: "EXITED" }];
    });
    route("POST", "graphql:RunpodPodExtras", {
      data: {
        myself: {
          pods: [
            {
              id: "pod1",
              createdAt: "2026-09-01T00:00:00Z",
              machine: { podHostId: "abc123" },
              runtime: {
                uptimeInSeconds: 60,
                container: { cpuPercent: 12, memoryPercent: 40 },
                gpus: [
                  { gpuUtilPercent: 90, memoryUtilPercent: 50 },
                  { gpuUtilPercent: 70, memoryUtilPercent: 30 },
                ],
              },
            },
          ],
        },
      },
    });
    const pods = await client().listResources("pod", "acct");
    const p = pods.find((x) => x.externalId === "pod1")!;
    expect(p.fields).toMatchObject({
      status: "running",
      region: "EU-RO-1",
      cloudType: "Secure Cloud",
      gpuCount: 2,
      gpuType: "RTX 4090",
      gpuUtilPercent: 80,
      gpuMemoryUtilPercent: 40,
      cpuPercent: 12,
      envKeys: "A, HF_TOKEN",
      sshUser: "pod1-abc123",
      networkVolumeId: "vol1",
    });
    expect(JSON.stringify(p.fields)).not.toContain("secret");
    expect(p.resolvedOutputs).toMatchObject({
      sshCommand: "ssh pod1-abc123@ssh.runpod.io",
      directSshCommand: "ssh root@1.2.3.4 -p 10341",
      httpProxyUrl: "https://pod1-8888.proxy.runpod.net",
      sshProxyHost: "ssh.runpod.io",
    });
    expect(p.createdAt).toBe("2026-09-01T00:00:00Z");
    expect(pods.find((x) => x.externalId === "pod2")!.fields["status"]).toBe("stopped");
  });

  it("still lists pods when GraphQL is refused", async () => {
    route("GET", "/pods", [POD]);
    route("POST", "graphql:RunpodPodExtras", () => new Response("{}", { status: 403 }));
    const [p] = await client().listResources("pod", "acct");
    expect(p!.fields["status"]).toBe("running");
    expect(p!.resolvedOutputs["sshCommand"]).toBe("");
  });

  it("builds a GPU pod create body from picker values", async () => {
    route("POST", "/pods", (c: Call) => ({ id: "new", ...(c.body as object) }));
    await client().createResource("pod", "acct", {
      name: "p",
      computeType: "GPU",
      gpuTypeId: "NVIDIA H100 80GB HBM3",
      gpuCount: "2",
      cloudType: "COMMUNITY",
      pricing: "spot",
      dataCenterId: "US-TX-3",
      templateId: "none",
      imageName: "img",
      containerDiskInGb: "40",
      volumeInGb: "0",
      volumeMountPath: "/workspace",
      ports: "8888/http, 22/tcp",
      networkVolumeId: "none",
      containerRegistryAuthId: "auth1",
      sshPublicKey: "ssh-ed25519 AAAA me",
      env: "A=1\n# comment\nB=x=y",
    });
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      gpuTypeIds: ["NVIDIA H100 80GB HBM3"],
      gpuCount: 2,
      cloudType: "COMMUNITY",
      interruptible: true,
      dataCenterIds: ["US-TX-3"],
      containerRegistryAuthId: "auth1",
      ports: ["8888/http", "22/tcp"],
      env: { A: "1", B: "x=y", PUBLIC_KEY: "ssh-ed25519 AAAA me" },
    });
    expect(body["templateId"]).toBeUndefined();
    expect(body["networkVolumeId"]).toBeUndefined();
  });

  it("maps lifecycle actions onto the REST verbs", async () => {
    for (const a of ["start", "stop", "restart", "reset"]) route("POST", `/pods/pod1/${a}`, {});
    route("PATCH", "/pods/pod1", {});
    const c = client();
    for (const a of ["start", "stop", "restart", "reset", "lock"]) {
      await c.invokeAction("pod", "acct:pod:pod1", a, "acct");
    }
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "POST /v1/pods/pod1/start",
      "POST /v1/pods/pod1/stop",
      "POST /v1/pods/pod1/restart",
      "POST /v1/pods/pod1/reset",
      "PATCH /v1/pods/pod1",
    ]);
    expect(calls[4]!.body).toEqual({ locked: true });
  });
});

describe("serverless endpoints", () => {
  it("adds queue health and run URLs", async () => {
    route("GET", "/endpoints", [
      { id: "ep1", name: "llm", workersMax: 3, dataCenterIds: ["EU-RO-1"] },
    ]);
    route("GET", "sls:/ep1/health", {
      jobs: { inQueue: 2, inProgress: 1, completed: 10, failed: 1 },
      workers: { idle: 1, running: 2 },
    });
    const [e] = await client().listResources("serverless-endpoint", "acct");
    expect(e!.fields).toMatchObject({ jobsInQueue: 2, workersRunning: 2, region: "EU-RO-1" });
    expect(e!.fields["workersThrottled"]).toBeUndefined();
    expect(e!.resolvedOutputs["runSyncUrl"]).toBe("https://api.runpod.ai/v2/ep1/runsync");
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
});

describe("network volumes", () => {
  it("records which pods and endpoints mount each volume", async () => {
    route("GET", "/networkvolumes", [
      { id: "vol1", name: "data", size: 100, dataCenterId: "EU-RO-1" },
      { id: "vol2", name: "old", size: 10, dataCenterId: "US-TX-3" },
    ]);
    route("GET", "/pods", [POD]);
    route("GET", "/endpoints", [{ id: "ep1", networkVolumeIds: ["vol1"] }]);
    const vols = await client().listResources("network-volume", "acct");
    expect(vols.map((v) => [v.externalId, v.fields["attachedTo"]])).toEqual([
      ["vol1", "pod1, ep1"],
      ["vol2", ""],
    ]);
  });

  it("refuses to shrink", async () => {
    route("GET", "/networkvolumes", [{ id: "vol1", size: 100 }]);
    route("GET", "/pods", []);
    route("GET", "/endpoints", []);
    await expect(
      client().updateResource("network-volume", "acct:network-volume:vol1", "acct", {
        sizeGb: "50",
      }),
    ).rejects.toThrow(/only grow/);
  });
});

describe("ssh keys", () => {
  const ED =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGRvZXNub3RtYXR0ZXJmb3J0ZXN0aW5ncHVycG9zZXM me@laptop";
  const RSA = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 work";

  it("lists, appends and removes keys in the single pubKey string", async () => {
    let stored = `${ED}\n\n${RSA}`;
    route("POST", "graphql:RunpodPubKey", () => ({
      data: { myself: { id: "u", pubKey: stored } },
    }));
    route("POST", "graphql:RunpodUpdatePubKey", (c: Call) => {
      stored = (c.body as { variables: { input: { pubKey: string } } }).variables.input.pubKey;
      return { data: { updateUserSettings: { id: "u" } } };
    });
    const c = client();
    const keys = await c.listResources("ssh-key", "acct");
    expect(keys.map((k) => k.displayName)).toEqual(["me@laptop", "work"]);
    expect(keys[0]!.fields["fingerprint"]).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    await c.createResource("ssh-key", "acct", {
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRoaXJka2V5",
      name: "ci",
    });
    expect(stored.split("\n\n")).toHaveLength(3);
    expect(stored).toContain("AAAAIHRoaXJka2V5 ci");

    await c.deleteResource("ssh-key", keys[1]!.id, "acct");
    expect(stored).not.toContain("ssh-rsa");
    expect(stored).toContain("me@laptop");
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
    route("GET", "/endpoints", [
      { id: "a", workersMax: 3 },
      { id: "b", workersMax: 4 },
    ]);
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

  it("estimates a pod from the GPU type's list price", async () => {
    route("POST", "graphql:RunpodGpuTypes", {
      data: {
        gpuTypes: [
          {
            id: "NVIDIA GeForce RTX 4090",
            displayName: "RTX 4090",
            secureCloud: true,
            securePrice: 0.74,
            communityPrice: 0.34,
          },
        ],
      },
    });
    const est = await client().estimateCost("pod", {
      gpuTypeId: "NVIDIA GeForce RTX 4090",
      gpuCount: "2",
      cloudType: "COMMUNITY",
    });
    expect(est?.monthlyAmount).toBeCloseTo(0.34 * 2 * 730, 2);
    expect(est?.partial).toBe(true);
  });
});

describe("helpers", () => {
  it("parses env lines", () => {
    expect(parseEnv("A=1\n\n#x\nB = 2\nbad")).toEqual({ A: "1", B: " 2" });
  });
  it("splits plain start commands and wraps shell ones", () => {
    expect(startCommandArgs("python app.py --port 8000")).toEqual([
      "python",
      "app.py",
      "--port",
      "8000",
    ]);
    expect(startCommandArgs("cd /w && ./run.sh")).toEqual(["bash", "-c", "cd /w && ./run.sh"]);
    expect(startCommandArgs("  ")).toEqual([]);
  });
});
