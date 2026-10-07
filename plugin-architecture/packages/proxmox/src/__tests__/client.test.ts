import { describe, expect, it } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { ProxmoxClient } from "../client.js";
import { ProxmoxApi, encodeForm, normalizeBaseUrl, nodeOfUpid } from "../api.js";
import {
  backupGuest,
  memoryMb,
  parseBackupExternalId,
  parsePropertyString,
  pickAgentAddresses,
  pickCtAddresses,
  resizableVmDisks,
  rrdTimeframe,
  sizeToGib,
  summarizeNetworks,
  summarizeVmDisks,
} from "../mappers.js";
import { heldPrivileges, proxmoxPolicyTemplate } from "../preflight.js";
import { plugin } from "../plugin.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  caCert?: string;
}

function mockHttp(
  routes: Record<string, unknown | ((c: Call) => { status: number; body: unknown })>,
) {
  const calls: Call[] = [];
  const http: HttpHostServices = {
    async request(req) {
      calls.push(req as Call);
      const u = new URL(req.url);
      const key = `${req.method} ${u.pathname.replace("/api2/json", "")}`;
      const route = routes[key];
      if (route === undefined)
        return { status: 404, headers: {}, body: JSON.stringify({ data: null }) };
      if (typeof route === "function") {
        const r = (route as (c: Call) => { status: number; body: unknown })(req as Call);
        return { status: r.status, headers: {}, body: JSON.stringify(r.body) };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ data: route }) };
    },
  };
  return { http, calls };
}

const CREDS = {
  url: "https://pve.example.com:8006/",
  tokenId: "infrawrench@pve!iw",
  tokenSecret: "secret-uuid",
  caCert: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----",
};

const RESOURCES = [
  {
    id: "node/pve1",
    type: "node",
    node: "pve1",
    status: "online",
    maxcpu: 16,
    maxmem: 68719476736,
  },
  { id: "node/pve2", type: "node", node: "pve2", status: "offline" },
  {
    id: "qemu/100",
    type: "qemu",
    vmid: 100,
    node: "pve1",
    name: "web01",
    status: "running",
    maxdisk: 34359738368,
    maxmem: 4294967296,
    template: 0,
    pool: "prod",
  },
  {
    id: "qemu/9000",
    type: "qemu",
    vmid: 9000,
    node: "pve1",
    name: "ubuntu-tmpl",
    status: "stopped",
    template: 1,
  },
  { id: "lxc/101", type: "lxc", vmid: 101, node: "pve1", name: "ct01", status: "stopped" },
  {
    id: "storage/pve1/local",
    type: "storage",
    node: "pve1",
    storage: "local",
    content: "iso,vztmpl,backup",
    status: "available",
    maxdisk: 107374182400,
    plugintype: "dir",
    shared: 0,
  },
  {
    id: "storage/pve1/nfs",
    type: "storage",
    node: "pve1",
    storage: "nfs",
    content: "backup",
    status: "available",
    shared: 1,
  },
  {
    id: "storage/pve2/nfs",
    type: "storage",
    node: "pve2",
    storage: "nfs",
    content: "backup",
    status: "available",
    shared: 1,
  },
];

describe("api", () => {
  it("normalises base URLs", () => {
    expect(normalizeBaseUrl("pve.local:8006")).toBe("https://pve.local:8006");
    expect(normalizeBaseUrl("https://pve.local:8006/api2/json/")).toBe("https://pve.local:8006");
    expect(normalizeBaseUrl("https://127.0.0.1:41234/")).toBe("https://127.0.0.1:41234");
  });

  it("form-encodes booleans as 0/1 and skips undefined", () => {
    expect(encodeForm({ a: true, b: false, c: undefined, d: "x y", e: "" })).toBe(
      "a=1&b=0&d=x%20y&e=",
    );
  });

  it("sends the PVEAPIToken header, the CA and form bodies through services.http", async () => {
    const { http, calls } = mockHttp({
      "POST /nodes/pve1/qemu/100/status/start": "UPID:pve1:1:2:3:qmstart:100:root@pam:",
    });
    const api = new ProxmoxApi(CREDS, http);
    await api.post("/nodes/pve1/qemu/100/status/start", { skiplock: false });
    expect(calls[0]!.url).toBe(
      "https://pve.example.com:8006/api2/json/nodes/pve1/qemu/100/status/start",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("PVEAPIToken=infrawrench@pve!iw=secret-uuid");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.body).toBe("skiplock=0");
    expect(calls[0]!.caCert).toContain("BEGIN CERTIFICATE");
  });

  it("maps errors to statuses with readable messages", async () => {
    const { http } = mockHttp({
      "GET /version": () => ({ status: 401, body: { data: null } }),
      "POST /pools": () => ({
        status: 400,
        body: { data: null, errors: { poolid: "invalid format" } },
      }),
      "GET /cluster/status": () => ({ status: 403, body: { data: null } }),
    });
    const api = new ProxmoxApi(CREDS, http);
    await expect(api.get("/version")).rejects.toMatchObject({ status: 401 });
    await expect(api.post("/pools", { poolid: "!" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("poolid: invalid format"),
    });
    await expect(api.get("/cluster/status")).rejects.toMatchObject({ status: 403 });
  });

  it("waits for tasks and surfaces failures", async () => {
    let n = 0;
    const { http } = mockHttp({
      "GET /nodes/pve1/tasks/UPID%3Apve1%3Aa/status": () => ({
        status: 200,
        body: { data: n++ < 1 ? { status: "running" } : { status: "stopped", exitstatus: "OK" } },
      }),
    });
    const api = new ProxmoxApi(CREDS, http);
    expect(await api.waitForTask("pve1", "UPID:pve1:a", { sleep: async () => {} })).toBe(true);
    expect(nodeOfUpid("UPID:pve2:0001:x")).toBe("pve2");
  });
});

describe("mappers", () => {
  it("parses property strings and sizes", () => {
    expect(parsePropertyString("local-lvm:vm-100-disk-0,size=32G,iothread=1")).toEqual({
      "": "local-lvm:vm-100-disk-0",
      size: "32G",
      iothread: "1",
    });
    expect(sizeToGib("32G")).toBe(32);
    expect(sizeToGib("512M")).toBe(0.5);
    expect(sizeToGib("1T")).toBe(1024);
    expect(memoryMb("current=4096")).toBe(4096);
    expect(memoryMb(2048)).toBe(2048);
  });

  it("summarises disks and networks, and finds resizable disks", () => {
    const cfg = {
      scsi0: "local-lvm:vm-100-disk-0,size=32G",
      ide2: "local:iso/ubuntu.iso,media=cdrom",
      efidisk0: "local-lvm:vm-100-disk-1,size=4M",
      net0: "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1,tag=20",
    };
    expect(summarizeVmDisks(cfg)).toBe(
      "efidisk0=local-lvm 4M, ide2=cdrom local:iso/ubuntu.iso, scsi0=local-lvm 32G",
    );
    expect(resizableVmDisks(cfg)).toEqual(["scsi0"]);
    expect(summarizeNetworks(cfg)).toBe("net0=virtio vmbr0 vlan 20 (BC:24:11:00:00:01)");
  });

  it("derives the guest of a backup from vzdump and PBS volids", () => {
    expect(backupGuest("local:backup/vzdump-qemu-100-2026_10_01-02_00_00.vma.zst")).toEqual({
      guestType: "qemu",
      vmid: "100",
    });
    expect(backupGuest("pbs:backup/ct/101/2026-10-01T02:00:00Z")).toEqual({
      guestType: "lxc",
      vmid: "101",
    });
    expect(parseBackupExternalId("pve1/pbs:backup/ct/101/2026-10-01T02:00:00Z")).toEqual({
      node: "pve1",
      volid: "pbs:backup/ct/101/2026-10-01T02:00:00Z",
      storage: "pbs",
    });
  });

  it("picks addresses from the guest agent and container interfaces", () => {
    expect(
      pickAgentAddresses([
        { name: "lo", "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4" }] },
        {
          name: "eth0",
          "ip-addresses": [
            { "ip-address": "fe80::1", "ip-address-type": "ipv6" },
            { "ip-address": "10.0.0.5", "ip-address-type": "ipv4" },
            { "ip-address": "2001:db8::5", "ip-address-type": "ipv6" },
          ],
        },
      ]),
    ).toEqual({ ipv4: "10.0.0.5", ipv6: "2001:db8::5" });
    expect(pickCtAddresses([{ name: "eth0", inet: "10.0.0.6/24" }])).toEqual({
      ipv4: "10.0.0.6",
      ipv6: "",
    });
  });

  it("chooses the RRD timeframe covering a range", () => {
    expect(rrdTimeframe(3_600_000)).toBe("hour");
    expect(rrdTimeframe(86_400_000)).toBe("day");
    expect(rrdTimeframe(7 * 86_400_000)).toBe("week");
    expect(rrdTimeframe(90 * 86_400_000)).toBe("year");
  });
});

describe("client", () => {
  const routes = {
    "GET /cluster/resources": RESOURCES,
    "GET /nodes/pve1/qemu/100/config": {
      name: "web01",
      cores: 2,
      sockets: 1,
      memory: "4096",
      cpu: "cputype=host",
      ostype: "l26",
      agent: "enabled=1,fstrim_cloned_disks=1",
      onboot: 1,
      scsi0: "local-lvm:vm-100-disk-0,size=32G",
      net0: "virtio=BC:24:11:00:00:01,bridge=vmbr0",
    },
    "GET /nodes/pve1/qemu/9000/config": { name: "ubuntu-tmpl", template: 1 },
    "GET /nodes/pve1/lxc/101/config": {
      hostname: "ct01",
      memory: 1024,
      swap: 256,
      rootfs: "local-lvm:subvol-101-disk-0,size=8G",
      unprivileged: 1,
      net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:02,ip=dhcp,type=veth",
    },
    "GET /nodes/pve1/storage/local/content": [
      {
        volid: "local:backup/vzdump-qemu-100-2026_10_01-02_00_00.vma.zst",
        ctime: 1790000000,
        size: 1073741824,
        format: "vma.zst",
        protected: 1,
        notes: "web01",
      },
    ],
    "GET /nodes/pve1/storage/nfs/content": [
      {
        volid: "nfs:backup/vzdump-lxc-101-2026_10_02-02_00_00.tar.zst",
        ctime: 1790086400,
        size: 536870912,
      },
    ],
    "GET /nodes/pve1/qemu/100/agent/network-get-interfaces": {
      result: [
        { name: "eth0", "ip-addresses": [{ "ip-address": "10.0.0.5", "ip-address-type": "ipv4" }] },
      ],
    },
  };

  it("lists VMs with config-derived fields", async () => {
    const { http } = mockHttp(routes);
    const client = new ProxmoxClient(CREDS, { http });
    const vms = await client.listResources("pve-vm", "acct");
    expect(vms).toHaveLength(2);
    const web = vms.find((v) => v.externalId === "100")!;
    expect(web.id).toBe("acct:pve-vm:100");
    expect(web.displayName).toBe("web01 (100)");
    expect(web.fields).toMatchObject({
      status: "running",
      cores: 2,
      memoryMb: 4096,
      cpuType: "host",
      agent: true,
      onboot: true,
      diskGb: 32,
      pool: "prod",
      template: false,
    });
    expect(vms.find((v) => v.externalId === "9000")!.fields["template"]).toBe(true);
  });

  it("lists containers", async () => {
    const { http } = mockHttp(routes);
    const client = new ProxmoxClient(CREDS, { http });
    const [ct] = await client.listResources("pve-ct", "acct");
    expect(ct!.fields).toMatchObject({
      name: "ct01",
      diskGb: 8,
      swapMb: 256,
      unprivileged: true,
      status: "stopped",
    });
  });

  it("lists backups once per shared storage, with their guest", async () => {
    const { http, calls } = mockHttp(routes);
    const client = new ProxmoxClient(CREDS, { http });
    const backups = await client.listResources("pve-backup", "acct");
    expect(backups).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("/storage/nfs/content"))).toHaveLength(1);
    const vmBackup = backups.find((b) => b.fields["vmid"] === "100")!;
    expect(vmBackup.fields).toMatchObject({
      guestType: "qemu",
      vmId: "100",
      ctId: "",
      protected: true,
      sizeGb: 1,
    });
    expect(vmBackup.parentResourceId).toBe("acct:pve-storage:pve1/local");
    expect(backups.find((b) => b.fields["vmid"] === "101")!.fields["ctId"]).toBe("101");
  });

  it("resolves a VM's IPv4 from the guest agent", async () => {
    const { http } = mockHttp(routes);
    const client = new ProxmoxClient(CREDS, { http });
    expect(await client.resolveOutput("pve-vm", "acct:pve-vm:100", "ipv4", "acct")).toBe(
      "10.0.0.5",
    );
  });

  it("power actions post to the guest's current node", async () => {
    const { http, calls } = mockHttp({
      ...routes,
      "POST /nodes/pve1/qemu/100/status/shutdown": "UPID:x",
    });
    const client = new ProxmoxClient(CREDS, { http });
    await client.invokeAction("pve-vm", "acct:pve-vm:100", "shutdown", "acct");
    expect(
      calls.some(
        (c) => c.method === "POST" && c.url.endsWith("/nodes/pve1/qemu/100/status/shutdown"),
      ),
    ).toBe(true);
  });

  it("updates set changed keys and delete cleared ones", async () => {
    let body = "";
    const { http } = mockHttp({
      ...routes,
      "PUT /nodes/pve1/qemu/100/config": (c: Call) => {
        body = String(c.body);
        return { status: 200, body: { data: null } };
      },
    });
    const client = new ProxmoxClient(CREDS, { http });
    await client.updateResource("pve-vm", "acct:pve-vm:100", "acct", {
      memoryMb: "8192",
      tags: "",
      onboot: "false",
    });
    expect(new URLSearchParams(body).get("memory")).toBe("8192");
    expect(new URLSearchParams(body).get("onboot")).toBe("0");
    expect(new URLSearchParams(body).get("delete")).toBe("tags");
  });

  it("refuses to delete a running guest", async () => {
    const { http } = mockHttp(routes);
    const client = new ProxmoxClient(CREDS, { http });
    await expect(client.deleteResource("pve-vm", "acct:pve-vm:100", "acct")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("prompt commands: snapshot and grow disk", async () => {
    const { http, calls } = mockHttp({
      ...routes,
      "POST /nodes/pve1/qemu/100/snapshot": "UPID:s",
      "PUT /nodes/pve1/qemu/100/resize": "UPID:r",
    });
    const client = new ProxmoxClient(CREDS, { http });
    await client.executeNoSqlCommand("pve-vm", "acct:pve-vm:100", "acct", "snapshot", [
      JSON.stringify({ snapname: "pre", vmstate: "true" }),
    ]);
    await client.executeNoSqlCommand("pve-vm", "acct:pve-vm:100", "acct", "resize", [
      JSON.stringify({ disk: "scsi0", size: "10" }),
    ]);
    const snap = calls.find((c) => c.url.endsWith("/snapshot"))!;
    expect(new URLSearchParams(String(snap.body)).get("vmstate")).toBe("1");
    const resize = calls.find((c) => c.url.endsWith("/resize"))!;
    expect(new URLSearchParams(String(resize.body)).get("size")).toBe("+10G");
  });

  it("HA rules degrade to empty on Proxmox VE 8", async () => {
    const { http } = mockHttp({
      "GET /cluster/ha/rules": () => ({ status: 501, body: { data: null } }),
    });
    const client = new ProxmoxClient(CREDS, { http });
    expect(await client.listResources("pve-ha-rule", "acct")).toEqual([]);
  });

  it("renders a VM detail with enrichment-driven prompts", async () => {
    const { http } = mockHttp({
      ...routes,
      "GET /nodes/pve1/qemu/100/snapshot": [
        { name: "current" },
        { name: "pre", snaptime: 1790000000, description: "x" },
      ],
      "GET /pools": [{ poolid: "prod" }],
    });
    const client = new ProxmoxClient(CREDS, { http });
    const vm = await client.getResource("pve-vm", "acct:pve-vm:100", "acct");
    const detail = client.renderDetail(await client.enrichDetail(vm));
    const labels = (detail.headerActions ?? []).map((a) => a.label);
    expect(labels).toContain("Shut down");
    expect(labels).toContain("Open console");
    expect(detail.sections.some((s) => s.title === "Snapshots")).toBe(true);
    expect(detail.metricsCapability).toBeDefined();
  });
});

describe("preflight", () => {
  it("collects privileges and builds a pveum template", () => {
    const held = heldPrivileges({ "/": { "VM.Audit": 1 }, "/storage": { "Datastore.Audit": 1 } });
    expect(held.root.has("VM.Audit")).toBe(true);
    expect(held.anywhere.has("Datastore.Audit")).toBe(true);
    const t = proxmoxPolicyTemplate(["resources", "power"]);
    expect(t.document).toContain(
      '--privs "Datastore.Audit,Pool.Audit,Sys.Audit,VM.Audit,VM.PowerMgmt"',
    );
    expect(plugin.manifest.preflight?.capabilities.length).toBeGreaterThan(5);
  });
});
