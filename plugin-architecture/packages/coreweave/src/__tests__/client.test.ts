import { afterEach, describe, expect, it, vi } from "vitest";
import { exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { CoreWeaveClient } from "../client.js";
import { plugin } from "../plugin.js";

const CLUSTER = {
  id: "c-1",
  name: "train",
  zone: "US-EAST-04A",
  vpcId: "v-1",
  public: true,
  version: "v1.36",
  network: {
    podCidrName: "pod cidr",
    serviceCidrName: "service cidr",
    internalLbCidrNames: ["lb"],
  },
  apiServerEndpoint: "org-abc.k8s.us-east-04a.coreweave.com",
  status: "STATUS_RUNNING",
};

const VPC = {
  id: "v-1",
  name: "main",
  zone: "US-EAST-04A",
  status: "STATUS_READY",
  vpcPrefixes: [
    { name: "pod cidr", value: "10.0.0.0/13" },
    { name: "service cidr", value: "10.16.0.0/22" },
    { name: "lb", value: "10.32.4.0/22" },
  ],
};

const POOL = {
  metadata: { name: "h100", creationTimestamp: "2026-09-01T00:00:00Z" },
  spec: {
    instanceType: "gd-8xh100ib-i128",
    targetNodes: 2,
    autoscaling: false,
    computeClass: "default",
  },
  status: { currentNodes: 2, conditions: [{ type: "Ready", status: "True" }] },
};

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

function mockFetch(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const path = new URL(url).host + new URL(url).pathname;
      const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
      if (!key) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(routes[key]), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const routes = {
  "GET api.coreweave.com/v1beta1/cks/clusters/c-1": { cluster: CLUSTER },
  "GET api.coreweave.com/v1beta1/cks/clusters": { items: [CLUSTER] },
  "GET api.coreweave.com/v1beta1/networking/vpcs": { items: [VPC] },
  "GET org-abc.k8s.us-east-04a.coreweave.com/apis/compute.coreweave.com/v1alpha1/nodepools/h100":
    POOL,
  "GET org-abc.k8s.us-east-04a.coreweave.com/apis/compute.coreweave.com/v1alpha1/nodepools": {
    items: [POOL],
  },
  "PATCH org-abc.k8s.us-east-04a.coreweave.com/apis/compute.coreweave.com/v1alpha1/nodepools/h100":
    POOL,
};

describe("CoreWeaveClient", () => {
  it("lists clusters with Node Pool roll-ups, authenticating with the token", async () => {
    const calls = mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "CW-SECRET-x" });
    const [cluster] = await client.listResources("cks-cluster", "acc");
    expect(cluster).toMatchObject({
      id: "acc:cks-cluster:c-1",
      fields: { name: "train", vpcName: "main", nodeCount: 2, gpuCount: 16, hourlyRunRate: 98.48 },
    });
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer CW-SECRET-x");
  });

  it("lists Node Pools as children of their cluster", async () => {
    mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "t" });
    const [pool] = await client.listResources("node-pool", "acc");
    expect(pool).toMatchObject({
      id: "acc:node-pool:c-1/h100",
      parentResourceId: "acc:cks-cluster:c-1",
      fields: { instanceType: "gd-8xh100ib-i128", currentNodes: 2, gpuCount: 16, state: "running" },
    });
  });

  it("builds a kubeconfig that carries the token inline", async () => {
    mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "CW-SECRET-x" });
    const kubeconfig = await client.resolveOutput(
      "cks-cluster",
      "acc:cks-cluster:c-1",
      "kubeconfig",
      "acc",
    );
    expect(kubeconfig).toContain('server: "https://org-abc.k8s.us-east-04a.coreweave.com"');
    expect(kubeconfig).toContain('token: "CW-SECRET-x"');
    expect(kubeconfig).not.toMatch(/exec|tokenFile|client-certificate:/);
  });

  it("scales a Node Pool with a merge patch after validating it", async () => {
    const calls = mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "t" });
    await client.updateResource("node-pool", "acc:node-pool:c-1/h100", "acc", { targetNodes: "4" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers["Content-Type"]).toBe("application/merge-patch+json");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ spec: { targetNodes: 4 } });
    await expect(
      client.updateResource("node-pool", "acc:node-pool:c-1/h100", "acc", { autoscaling: "true" }),
    ).rejects.toThrow(/minimum and maximum/);
  });

  it("refuses a cluster whose prefixes are not in the chosen VPC", async () => {
    mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "t" });
    await expect(
      client.createResource("cks-cluster", "acc", {
        name: "new",
        vpcId: "v-1",
        version: "v1.37",
        public: "true",
        podCidrName: "v-1/pod cidr",
        serviceCidrName: "v-2/service cidr",
        internalLbCidrName: "v-1/lb",
      }),
    ).rejects.toThrow(/not a prefix of VPC main/);
  });

  it("renders every type with a metrics tab where it declares metrics", async () => {
    mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "t" });
    const [cluster] = await client.listResources("cks-cluster", "acc");
    const detail = client.renderDetail(cluster!);
    expect(detail.metricsCapability).toBeDefined();
    expect(detail.childTables?.[0]?.typeId).toBe("node-pool");
  });
});

describe("Terraform export", () => {
  it("maps clusters, VPCs and buckets to the coreweave provider", async () => {
    mockFetch(routes);
    const client = new CoreWeaveClient({ apiToken: "t" });
    const [cluster] = await client.listResources("cks-cluster", "acc");
    const [vpc] = await client.listResources("vpc", "acc");
    const result = exportResourcesToTerraform([cluster!, vpc!], () => plugin.terraformExport);
    expect(result.hcl).toContain('resource "coreweave_cks_cluster"');
    expect(result.hcl).toContain('pod_cidr_name          = "pod cidr"');
    expect(result.hcl).toContain('resource "coreweave_networking_vpc"');
    expect(result.hcl).toContain('source  = "coreweave/coreweave"');
  });
});
