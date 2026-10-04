import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrusoeClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { parseStatusFeed, mapComponent } from "../status-feed.js";
import { crusoeTerraformExport } from "../terraform.js";
import { normalizeVmState, parseScopedId, parseSizeGib } from "../mappers.js";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

type Route = (call: Call) => unknown;

let calls: Call[] = [];
let routes: Record<string, Route> = {};

function route(method: string, path: string, handler: Route | unknown) {
  routes[`${method} ${path}`] = typeof handler === "function" ? (handler as Route) : () => handler;
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v1/, "");
      const call: Call = {
        method: init.method ?? "GET",
        path,
        query: u.searchParams,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${path}`];
      if (!handler) {
        return new Response(JSON.stringify({ code: "404", message: "not found" }), { status: 404 });
      }
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(typeof out === "string" ? out : JSON.stringify(out ?? {}), {
        status: 200,
      });
    }),
  );
  route("GET", "/organizations/entities", { items: [{ id: "org-1", name: "Acme" }] });
  route("GET", "/organizations/projects", {
    items: [
      { id: "p-1", name: "training", organization_id: "org-1" },
      { id: "p-2", name: "inference", organization_id: "org-1" },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () =>
  new CrusoeClient({ accessKeyId: "AK", secretKey: "c2VjcmV0LWtleS1mb3ItdGVzdHM" }, RESOURCE_TYPES);

const done = { operation: { operation_id: "op-1", state: "SUCCEEDED", result: { id: "new-1" } } };

describe("listing", () => {
  it("signs every request", async () => {
    await client().listResources("project", "acct");
    const h = calls[0]!.headers;
    expect(h["Authorization"]).toMatch(/^Bearer 1\.0:AK:[A-Za-z0-9_-]+$/);
    expect(h["X-Crusoe-Timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("fans VMs out across projects with type details and normalised state", async () => {
    route("GET", "/projects/p-1/compute/vms/instances", {
      items: [
        {
          id: "vm-1",
          name: "trainer",
          type: "h100-80gb-sxm-ib.8x",
          state: "STATE_SHUTOFF",
          location: "us-east1-a",
          network_interfaces: [
            {
              subnet: "sub-1",
              network: "net-1",
              ips: [{ public_ipv4: { address: "1.2.3.4" }, private_ipv4: { address: "10.0.0.2" } }],
            },
          ],
          disks: [{ id: "d-1" }],
        },
      ],
    });
    route("GET", "/projects/p-1/compute/vms/types", {
      items: [
        { product_name: "h100-80gb-sxm-ib.8x", num_gpu: 8, gpu_type: "H100", cpu_cores: 176 },
      ],
    });
    // p-2 refuses: listed empty rather than failing the whole listing.
    route("GET", "/projects/p-2/compute/vms/instances", () => new Response("{}", { status: 403 }));
    const vms = await client().listResources("vm", "acct");
    expect(vms).toHaveLength(1);
    const vm = vms[0]!;
    expect(vm.id).toBe("acct:vm:p-1/vm-1");
    expect(vm.parentResourceId).toBe("acct:project:p-1");
    expect(vm.fields).toMatchObject({
      state: "stopped",
      gpuCount: 8,
      gpuType: "H100",
      vcpus: 176,
      diskIds: "d-1",
      subnetId: "sub-1",
    });
    expect(vm.resolvedOutputs).toMatchObject({ publicIp: "1.2.3.4", privateIp: "10.0.0.2" });
  });

  it("follows next_page_token pagination", async () => {
    route("GET", "/projects/p-1/storage/disks", (c: Call) =>
      c.query.get("next_token")
        ? { items: [{ id: "d-2", size: "1TiB" }] }
        : {
            items: [{ id: "d-1", size: "100GiB", attached_to: [{ vm_id: "vm-1" }] }],
            next_page_token: "t",
          },
    );
    route("GET", "/projects/p-2/storage/disks", { items: [] });
    const disks = await client().listResources("disk", "acct");
    expect(
      disks.map((d) => [d.externalId, d.fields["sizeGib"], d.fields["attachedVmIds"]]),
    ).toEqual([
      ["p-1/d-1", 100, "vm-1"],
      ["p-1/d-2", 1024, ""],
    ]);
  });

  it("lists reservations per organization", async () => {
    route("GET", "/organizations/org-1/reservations", {
      items: [{ id: "r-1", product_line: "h100", quantity: 16, used_quantity: 12 }],
    });
    const [r] = await client().listResources("reservation", "acct");
    expect(r!.fields).toMatchObject({ quantity: 16, usedQuantity: 12, utilizationPercent: 75 });
  });
});

describe("actions", () => {
  it("starts, stops and resets VMs with the PATCH action", async () => {
    route("PATCH", "/projects/p-1/compute/vms/instances/vm-1", done);
    const c = client();
    await c.invokeAction("vm", "acct:vm:p-1/vm-1", "stop", "acct");
    await c.invokeAction("vm", "acct:vm:p-1/vm-1", "start", "acct");
    await c.invokeAction("vm", "acct:vm:p-1/vm-1", "reset", "acct");
    expect(calls.filter((x) => x.method === "PATCH").map((x) => x.body)).toEqual([
      { action: "STOP" },
      { action: "START" },
      { action: "RESET" },
    ]);
  });

  it("surfaces a failed operation's message", async () => {
    route("PATCH", "/projects/p-1/compute/vms/instances/vm-1", {
      operation: { operation_id: "op", state: "FAILED", result: { message: "out of capacity" } },
    });
    await expect(client().invokeAction("vm", "acct:vm:p-1/vm-1", "start", "acct")).rejects.toThrow(
      /out of capacity/,
    );
  });

  it("attaches a disk to a VM in the same project", async () => {
    route("POST", "/projects/p-1/compute/vms/instances/vm-1/attach-disks", done);
    await client().attachResource("disk", "acct:disk:p-1/d-1", "vm", "acct:vm:p-1/vm-1", "acct");
    expect(calls.at(-1)!.body).toEqual({
      attach_disks: [{ disk_id: "d-1", attachment_type: "data", mode: "read-write" }],
    });
    await expect(
      client().attachResource("disk", "acct:disk:p-2/d-1", "vm", "acct:vm:p-1/vm-1", "acct"),
    ).rejects.toThrow(/same project/);
  });
});

describe("create, update, delete", () => {
  it("creates a VM and resolves it by the operation's result id", async () => {
    route("POST", "/projects/p-1/compute/vms/instances", done);
    route("GET", "/projects/p-1/compute/vms/instances", {
      items: [{ id: "new-1", name: "gpu", state: "STATE_RUNNING" }],
    });
    route("GET", "/projects/p-2/compute/vms/instances", { items: [] });
    const vm = await client().createResource("vm", "acct", {
      projectId: "p-1",
      name: "gpu",
      type: "a40.1x",
      location: "us-east1-a",
      image: "ubuntu22.04:latest",
      sshPublicKey: "ssh-ed25519 AAAA",
      reservationStrategy: "on_demand",
    });
    expect(vm.externalId).toBe("p-1/new-1");
    expect(calls.find((x) => x.method === "POST")!.body).toMatchObject({
      name: "gpu",
      type: "a40.1x",
      ssh_public_key: "ssh-ed25519 AAAA",
      reservation_specification: { selection_strategy: "on_demand" },
    });
  });

  it("creates under a project parent without a project field", async () => {
    route("POST", "/projects/p-2/storage/disks", done);
    route("GET", "/projects/p-1/storage/disks", { items: [] });
    route("GET", "/projects/p-2/storage/disks", { items: [{ id: "new-1", name: "data" }] });
    await client().createResource(
      "disk",
      "acct",
      { name: "data", location: "us-east1-a", sizeGib: "500", type: "persistent-ssd" },
      "acct:project:p-2",
    );
    expect(calls.find((x) => x.method === "POST")!.body).toEqual({
      name: "data",
      location: "us-east1-a",
      size: "500GiB",
      type: "persistent-ssd",
    });
  });

  it("defaults a firewall rule's destination to its VPC network", async () => {
    route("POST", "/projects/p-1/networking/vpc-firewall-rules", done);
    await client()
      .createResource("firewall-rule", "acct", {
        networkId: "p-1/net-1",
        name: "ssh",
        protocols: "tcp",
        sources: "203.0.113.0/24",
        destinationPorts: "22",
      })
      .catch(() => undefined);
    expect(calls.find((x) => x.method === "POST")!.body).toMatchObject({
      vpc_network_id: "net-1",
      sources: [{ cidr: "203.0.113.0/24" }],
      destinations: [{ resource_id: "net-1" }],
      destination_ports: ["22"],
    });
  });

  it("scales a node pool and keeps unchanged autoscaling bounds", async () => {
    route("GET", "/projects/p-1/kubernetes/nodepools", {
      items: [
        {
          id: "np-1",
          cluster_id: "c-1",
          count: 2,
          autoscaling_config: { enabled: true, min_node_size: 1, max_node_size: 4 },
        },
      ],
    });
    route("GET", "/projects/p-2/kubernetes/nodepools", { items: [] });
    route("PATCH", "/projects/p-1/kubernetes/nodepools/np-1", done);
    await client().updateResource("node-pool", "acct:node-pool:p-1/np-1", "acct", {
      count: "5",
      maxNodes: "8",
    });
    expect(calls.find((x) => x.method === "PATCH")!.body).toEqual({
      count: 5,
      autoscaling_config: { enabled: true, min_node_size: 1, max_node_size: 8 },
    });
  });

  it("resizes a VM with the UPDATE action and grows a disk", async () => {
    route("PATCH", "/projects/p-1/compute/vms/instances/vm-1", done);
    route("PATCH", "/projects/p-1/storage/disks/d-1", done);
    route("GET", "/projects/p-1/compute/vms/instances", { items: [{ id: "vm-1" }] });
    route("GET", "/projects/p-1/storage/disks", { items: [{ id: "d-1" }] });
    const c = client();
    await c.updateResource("vm", "acct:vm:p-1/vm-1", "acct", { type: "a40.2x" });
    await c.updateResource("disk", "acct:disk:p-1/d-1", "acct", { sizeGib: "200" });
    expect(calls.filter((x) => x.method === "PATCH").map((x) => x.body)).toEqual([
      { action: "UPDATE", type: "a40.2x" },
      { size: "200GiB" },
    ]);
  });

  it("deletes SSH keys by query id and project-scoped resources by path", async () => {
    route("DELETE", "/users/ssh-keys", "");
    route("DELETE", "/projects/p-1/networking/vpc-networks/net-1", done);
    const c = client();
    await c.deleteResource("ssh-key", "acct:ssh-key:key-1", "acct");
    await c.deleteResource("vpc-network", "acct:vpc-network:p-1/net-1", "acct");
    expect(calls.find((x) => x.path === "/users/ssh-keys")!.query.get("id")).toBe("key-1");
    expect(calls.some((x) => x.method === "DELETE" && x.path.endsWith("/net-1"))).toBe(true);
  });

  it("fetches a kubeconfig with admin credentials", async () => {
    route("POST", "/projects/p-1/kubernetes/clusters/c-1/get-credentials", {
      kube_config: "apiVersion: v1",
    });
    const kc = await client().resolveOutput(
      "kubernetes-cluster",
      "acct:kubernetes-cluster:p-1/c-1",
      "kubeconfig",
      "acct",
    );
    expect(kc).toBe("apiVersion: v1");
    expect(calls.at(-1)!.query.get("auth_type")).toBe("admin_cert");
  });
});

describe("credits, commitments, quotas, metrics", () => {
  it("reads the credit balance", async () => {
    route("GET", "/organizations/org-1/billing/credit-balance", { total_balance: "1500.25" });
    expect(await client().fetchCreditBalance("acct")).toEqual([
      { key: "org-1", label: "Credit balance", remaining: 1500.25, currency: "USD" },
    ]);
  });

  it("turns reservations into unit commitments with derived state", async () => {
    route("GET", "/organizations/org-1/reservations", {
      items: [
        {
          id: "r-1",
          product_line: "h100-80gb-sxm-ib",
          quantity: 64,
          contract_start_date: "2020-01-01T00:00:00Z",
          contract_end_date: "2021-01-01T00:00:00Z",
        },
      ],
    });
    const [rec] = await client().fetchCommitments("acct");
    expect(rec).toMatchObject({
      kind: "reservation",
      state: "expired",
      unitCommitments: [{ unit: "h100-80gb-sxm-ib", amount: 64 }],
    });
    expect(rec!.hourlyCommitmentAmount).toBeUndefined();
  });

  it("reports organization quotas", async () => {
    route("GET", "/organizations/org-1/quotas", {
      quotas: [
        { programmatic_name: "h100-gpus", description: "H100 GPUs", max: 64, used: 48 },
        { programmatic_name: "unlimited", max: 0 },
      ],
    });
    expect(await client().fetchQuotas("acct")).toEqual([
      {
        id: "org-1/h100-gpus",
        service: "Crusoe Cloud",
        name: "H100 GPUs",
        limit: 64,
        used: 48,
        adjustable: true,
      },
    ]);
  });

  it("queries VM metrics by vm_id and drops empty series", async () => {
    route("GET", "/projects/p-1/metrics/timeseries/api/v1/query-range", (c: Call) =>
      c.query.get("query")!.includes("DCGM_FI_DEV_GPU_UTIL")
        ? { status: "success", data: { result: [{ values: [[1700000000, "87.5"]] }] } }
        : { status: "success", data: { result: [] } },
    );
    const series = await client().fetchMetricSeries("vm", "acct:vm:p-1/vm-1", "acct");
    expect(series).toEqual([
      { label: "GPU Utilization", unit: "%", points: [{ timestamp: 1700000000000, value: 87.5 }] },
    ]);
    expect(calls.at(-1)!.query.get("query")).toContain('vm_id="vm-1"');
  });
});

describe("pure helpers", () => {
  it("normalises VM states", () => {
    expect(normalizeVmState("STATE_RUNNING")).toBe("running");
    expect(normalizeVmState("STATE_SHUTOFF")).toBe("stopped");
    expect(normalizeVmState("STATE_RESOURCING_AGENT")).toBe("provisioning");
    expect(normalizeVmState(undefined)).toBe("unknown");
  });

  it("parses sizes and scoped ids", () => {
    expect(parseSizeGib("2TiB")).toBe(2048);
    expect(parseSizeGib("junk")).toBe(0);
    expect(parseScopedId("acct:vm:p-1/vm-1")).toEqual({ projectId: "p-1", id: "vm-1" });
    expect(() => parseScopedId("acct:vm:nope")).toThrow();
  });

  it("maps status components to regions, zones and services", () => {
    expect(mapComponent("us-east1")?.regions).toContain("us-east1-a");
    expect(mapComponent("API")).toMatchObject({ providerWide: true });
    expect(mapComponent("Shared Disks")).toEqual({ services: ["Shared Disks"] });
    expect(parseStatusFeed(JSON.stringify({ incidents: [] }))).toEqual([]);
  });

  it("exports Terraform with the provider's import id format", () => {
    const out = crusoeTerraformExport.mapResource({
      id: "acct:disk:p-1/d-1",
      pluginId: "crusoe",
      resourceTypeId: "disk",
      accountId: "acct",
      displayName: "data",
      fields: { name: "data", sizeGib: 100, location: "us-east1-a", type: "persistent-ssd" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "p-1/d-1",
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource).toMatchObject({
      type: "crusoe_storage_disk",
      importId: "d-1,p-1",
      attributes: { size: { kind: "string", value: "100GiB" }, project_id: { value: "p-1" } },
    });
  });
});
