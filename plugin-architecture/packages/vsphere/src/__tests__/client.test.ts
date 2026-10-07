import { describe, expect, it } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import {
  VsphereApi,
  buildQuery,
  decodeBasic,
  describeVapiError,
  normalizeBaseUrl,
} from "../api.js";
import { VsphereClient, datastoreOfVmdk, placementOf } from "../client.js";
import { networkBackingType } from "../create.js";
import { vsphereTerraformExport } from "../terraform.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Route = unknown | ((c: Call) => { status: number; body?: unknown });

function mockHttp(routes: Record<string, Route>) {
  const calls: Call[] = [];
  let sessions = 0;
  const http: HttpHostServices = {
    async request(req) {
      const c = req as Call;
      calls.push(c);
      const u = new URL(req.url);
      const key = `${req.method} ${u.pathname}${u.search}`;
      if (key === "POST /api/session") {
        sessions++;
        return { status: 201, headers: {}, body: JSON.stringify(`token-${sessions}`) };
      }
      const route = routes[key] ?? routes[`${req.method} ${u.pathname}`];
      if (route === undefined)
        return {
          status: 404,
          headers: {},
          body: JSON.stringify({
            error_type: "NOT_FOUND",
            messages: [{ default_message: "nope" }],
          }),
        };
      if (typeof route === "function") {
        const r = (route as (c: Call) => { status: number; body?: unknown })(c);
        return {
          status: r.status,
          headers: {},
          body: r.body === undefined ? "" : JSON.stringify(r.body),
        };
      }
      return { status: 200, headers: {}, body: JSON.stringify(route) };
    },
  };
  return { http, calls, sessions: () => sessions };
}

const CREDS = {
  url: "vcenter.example.com/ui",
  username: "svc@vsphere.local",
  password: "p@ss",
  caCert: "PEM",
};

describe("api", () => {
  it("normalises URLs and builds repeated query params", () => {
    expect(normalizeBaseUrl("vcenter.example.com/ui/")).toBe("https://vcenter.example.com");
    expect(buildQuery({ hosts: ["host-1", "host-2"], action: "clone", x: undefined })).toBe(
      "?hosts=host-1&hosts=host-2&action=clone",
    );
  });

  it("logs in with Basic, sends the session header and the CA", async () => {
    const { http, calls } = mockHttp({
      "GET /api/vcenter/datacenter": [{ datacenter: "datacenter-1", name: "DC1" }],
    });
    const api = new VsphereApi(CREDS, http);
    await api.get("/vcenter/datacenter");
    expect(decodeBasic(calls[0]!.headers["Authorization"]!)).toBe("svc@vsphere.local:p@ss");
    expect(calls[1]!.headers["vmware-api-session-id"]).toBe("token-1");
    expect((calls[1] as unknown as { caCert: string }).caCert).toBe("PEM");
  });

  it("re-logs in once when the session expired", async () => {
    let n = 0;
    const m = mockHttp({
      "GET /api/vcenter/host": () =>
        n++ === 0 ? { status: 401, body: {} } : { status: 200, body: [] },
    });
    const api = new VsphereApi(CREDS, m.http);
    await expect(api.get("/vcenter/host")).resolves.toEqual([]);
    expect(m.sessions()).toBe(2);
  });

  it("maps vAPI errors with status", async () => {
    expect(
      describeVapiError(
        JSON.stringify({ error_type: "NOT_FOUND", messages: [{ default_message: "VM gone" }] }),
      ),
    ).toEqual({ type: "NOT_FOUND", message: "VM gone" });
    const { http } = mockHttp({
      "DELETE /api/vcenter/vm/vm-1": () => ({
        status: 400,
        body: {
          error_type: "NOT_ALLOWED_IN_CURRENT_STATE",
          messages: [{ default_message: "powered on" }],
        },
      }),
    });
    const api = new VsphereApi(CREDS, http);
    await expect(api.delete("/vcenter/vm/vm-1")).rejects.toMatchObject({
      status: 400,
      errorType: "NOT_ALLOWED_IN_CURRENT_STATE",
    });
  });
});

describe("mappers", () => {
  it("extracts datastores and placement", () => {
    expect(datastoreOfVmdk("[ds-ssd 01] web01/web01.vmdk")).toBe("ds-ssd 01");
    expect(placementOf({ host: "host-1", resourcePool: "", datastore: "datastore-9" })).toEqual({
      host: "host-1",
      datastore: "datastore-9",
    });
    expect(
      networkBackingType(
        [{ network: "dvportgroup-1", type: "DISTRIBUTED_PORTGROUP" }],
        "dvportgroup-1",
      ),
    ).toBe("DISTRIBUTED_PORTGROUP");
  });
});

describe("client", () => {
  const routes: Record<string, Route> = {
    "GET /api/vcenter/vm": [
      { vm: "vm-1", name: "web01", power_state: "POWERED_ON", cpu_count: 2, memory_size_MiB: 4096 },
    ],
    "GET /api/vcenter/vm?hosts=host-1": [{ vm: "vm-1", name: "web01", power_state: "POWERED_ON" }],
    "GET /api/vcenter/vm?clusters=domain-c1": [
      { vm: "vm-1", name: "web01", power_state: "POWERED_ON" },
    ],
    "GET /api/vcenter/vm?resource_pools=resgroup-1": [{ vm: "vm-1" }, { vm: "vm-2" }],
    "GET /api/vcenter/vm?resource_pools=resgroup-2": [{ vm: "vm-1" }],
    "GET /api/vcenter/host": [
      {
        host: "host-1",
        name: "esx1.example.com",
        connection_state: "CONNECTED",
        power_state: "POWERED_ON",
      },
    ],
    "GET /api/vcenter/cluster": [
      { cluster: "domain-c1", name: "Prod", ha_enabled: true, drs_enabled: true },
    ],
    "GET /api/vcenter/resource-pool": [
      { resource_pool: "resgroup-1", name: "Resources" },
      { resource_pool: "resgroup-2", name: "web" },
    ],
    "GET /api/vcenter/vm/vm-1": {
      name: "web01",
      guest_OS: "UBUNTU_64",
      cpu: { count: 2, cores_per_socket: 1, hot_add_enabled: false },
      memory: { size_MiB: 4096, hot_add_enabled: true },
      hardware: { version: "VMX_21" },
      disks: {
        "2000": {
          label: "Hard disk 1",
          capacity: 42949672960,
          backing: { vmdk_file: "[ds1] web01/web01.vmdk" },
        },
      },
      nics: { "4000": { backing: { network: "network-1" } } },
      identity: { instance_uuid: "uuid-1" },
    },
    "POST /api/cis/tagging/tag-association?action=list-attached-tags-on-objects": [
      { object_id: { id: "vm-1", type: "VirtualMachine" }, tag_ids: ["urn:tag:1"] },
    ],
    "GET /api/cis/tagging/tag": ["urn:tag:1"],
    "GET /api/cis/tagging/tag/urn%3Atag%3A1": { name: "prod" },
    "GET /api/vcenter/vm/vm-1/guest/identity": { ip_address: "10.0.0.5", host_name: "web01" },
  };

  it("lists VMs with placement (deepest pool), datastores, networks and tags", async () => {
    const { http } = mockHttp(routes);
    const client = new VsphereClient(CREDS, { http });
    const [vm] = await client.listResources("vsphere-vm", "acct");
    expect(vm!.id).toBe("acct:vsphere-vm:vm-1");
    expect(vm!.fields).toMatchObject({
      powerState: "POWERED_ON",
      cpuCount: 2,
      memoryMb: 4096,
      memoryHotAdd: true,
      guestOs: "UBUNTU_64",
      diskGb: 40,
      datastores: "ds1",
      networkIds: "network-1",
      hostId: "host-1",
      clusterId: "domain-c1",
      resourcePoolId: "resgroup-2",
      tags: "prod",
    });
  });

  it("resolves the VM IP from VMware Tools", async () => {
    const { http } = mockHttp(routes);
    const client = new VsphereClient(CREDS, { http });
    expect(
      await client.resolveOutput("vsphere-vm", "acct:vsphere-vm:vm-1", "ipAddress", "acct"),
    ).toBe("10.0.0.5");
  });

  it("power and guest actions use ?action=", async () => {
    const { http, calls } = mockHttp({
      ...routes,
      "POST /api/vcenter/vm/vm-1/power": () => ({ status: 204 }),
      "POST /api/vcenter/vm/vm-1/guest/power": () => ({ status: 204 }),
    });
    const client = new VsphereClient(CREDS, { http });
    await client.invokeAction("vsphere-vm", "acct:vsphere-vm:vm-1", "stop", "acct");
    await client.invokeAction("vsphere-vm", "acct:vsphere-vm:vm-1", "guest-shutdown", "acct");
    expect(calls.map((c) => c.url)).toContain(
      "https://vcenter.example.com/api/vcenter/vm/vm-1/power?action=stop",
    );
    expect(calls.map((c) => c.url)).toContain(
      "https://vcenter.example.com/api/vcenter/vm/vm-1/guest/power?action=shutdown",
    );
  });

  it("edits CPU and memory with size_MiB", async () => {
    const bodies: Record<string, unknown> = {};
    const record = (k: string) => (c: Call) => {
      bodies[k] = JSON.parse(c.body ?? "{}");
      return { status: 204 };
    };
    const { http } = mockHttp({
      ...routes,
      "PATCH /api/vcenter/vm/vm-1/hardware/cpu": record("cpu"),
      "PATCH /api/vcenter/vm/vm-1/hardware/memory": record("mem"),
    });
    const client = new VsphereClient(CREDS, { http });
    await client.updateResource("vsphere-vm", "acct:vsphere-vm:vm-1", "acct", {
      cpuCount: "4",
      memoryMb: "8192",
    });
    expect(bodies["cpu"]).toEqual({ count: 4 });
    expect(bodies["mem"]).toEqual({ size_MiB: 8192 });
  });

  it("refuses to delete a powered-on VM", async () => {
    const { http } = mockHttp(routes);
    const client = new VsphereClient(CREDS, { http });
    await expect(
      client.deleteResource("vsphere-vm", "acct:vsphere-vm:vm-1", "acct"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("clones with placement through a prompt", async () => {
    let body: Record<string, unknown> = {};
    const { http } = mockHttp({
      ...routes,
      "POST /api/vcenter/vm?action=clone": (c: Call) => {
        body = JSON.parse(c.body ?? "{}");
        return { status: 200, body: "vm-9" };
      },
    });
    const client = new VsphereClient(CREDS, { http });
    const r = await client.executeNoSqlCommand(
      "vsphere-vm",
      "acct:vsphere-vm:vm-1",
      "acct",
      "clone",
      [JSON.stringify({ name: "web02", host: "host-1", powerOn: "true" })],
    );
    expect(r).toEqual({ ok: true, vm: "vm-9" });
    expect(body).toEqual({
      source: "vm-1",
      name: "web02",
      placement: { host: "host-1" },
      power_on: true,
    });
  });
});

describe("terraform", () => {
  it("maps tags with a JSON import id", () => {
    const out = vsphereTerraformExport.mapResource({
      id: "a:vsphere-tag:urn:1",
      pluginId: "vsphere",
      resourceTypeId: "vsphere-tag",
      accountId: "a",
      displayName: "prod",
      fields: { name: "prod", categoryId: "urn:cat:1", categoryName: "env", description: "" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "urn:1",
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("vsphere_tag");
    expect(out?.resource.importId).toBe('{"category_name":"env","tag_name":"prod"}');
  });
});
