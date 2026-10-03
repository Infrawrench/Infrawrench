import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { HetznerClient } from "../client.js";
import { plugin } from "../plugin.js";
import { parseRecordValues } from "../dns.js";

const ACCOUNT = "acct1";
const CLOUD = "https://api.hetzner.cloud/v1";
const HETZNER = "https://api.hetzner.com/v1";

function makeClient() {
  return new HetznerClient({ apiToken: "tok" }, plugin.resourceTypes);
}

function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type Call = { url: string; method: string; body: unknown };
let fetchMock: MockInstance<typeof fetch>;
let calls: Call[];

/** Route requests by `METHOD url-prefix`; the longest matching prefix wins. */
function route(table: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(table)
      .filter((k) => {
        const [m, p] = k.split(" ");
        return m === method && url.startsWith(p!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected ${method} ${url}`);
    return okJson(table[key]);
  });
}

beforeEach(() => {
  calls = [];
  fetchMock = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const zone = {
  id: 77,
  name: "example.com",
  created: "2026-01-01T00:00:00Z",
  mode: "primary",
  ttl: 3600,
  status: "ok",
  record_count: 3,
  registrar: "other",
  protection: { delete: false },
  authoritative_nameservers: {
    assigned: ["hydrogen.ns.hetzner.com.", "oxygen.ns.hetzner.com."],
    delegated: [],
    delegation_status: "invalid",
  },
};

describe("DNS zones and record sets", () => {
  it("lists zones with delegation and nameserver details", async () => {
    route({ [`GET ${CLOUD}/zones`]: { zones: [zone] } });
    const [z] = await makeClient().listResources("dns-zone", ACCOUNT);
    expect(z!.id).toBe(`${ACCOUNT}:dns-zone:77`);
    expect(z!.fields).toMatchObject({
      name: "example.com",
      recordCount: 3,
      delegationStatus: "invalid",
      nameservers: "hydrogen.ns.hetzner.com., oxygen.ns.hetzner.com.",
    });
    expect(z!.resolvedOutputs["nameservers"]).toContain("hydrogen");
  });

  it("lists record sets per zone, skipping SOA, with zone-default TTL as empty", async () => {
    route({
      [`GET ${CLOUD}/zones?`]: { zones: [zone] },
      [`GET ${CLOUD}/zones/77/rrsets`]: {
        rrsets: [
          { name: "@", type: "SOA", ttl: null, records: [{ value: "x" }] },
          {
            name: "www",
            type: "A",
            ttl: null,
            records: [{ value: "203.0.113.1" }, { value: "203.0.113.2" }],
            protection: { change: false },
          },
        ],
      },
    });
    const records = await makeClient().listResources("dns-record", ACCOUNT);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(`${ACCOUNT}:dns-record:77/www/A`);
    expect(records[0]!.parentResourceId).toBe(`${ACCOUNT}:dns-zone:77`);
    expect(records[0]!.fields).toMatchObject({
      content: "203.0.113.1, 203.0.113.2",
      ttl: "",
      zoneName: "example.com",
    });
    expect(records[0]!.displayName).toBe("A www.example.com");
  });

  it("creates a primary zone with a normalised name", async () => {
    route({ [`POST ${CLOUD}/zones`]: { zone, action: { id: 1 } } });
    await makeClient().createResource("dns-zone", ACCOUNT, { name: "Example.com.", ttl: "600" });
    expect(calls[0]!.body).toEqual({ name: "example.com", mode: "primary", ttl: 600 });
  });

  it("creates a record set under its parent zone", async () => {
    route({
      [`GET ${CLOUD}/zones/77`]: { zone },
      [`POST ${CLOUD}/zones/77/rrsets`]: {
        rrset: { name: "@", type: "TXT", ttl: 300, records: [{ value: '"a, b"' }] },
        action: { id: 1 },
      },
    });
    const r = await makeClient().createResource(
      "dns-record",
      ACCOUNT,
      { type: "TXT", name: "@", content: '"a, b"', ttl: "300" },
      `${ACCOUNT}:dns-zone:77`,
    );
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      name: "@",
      type: "TXT",
      ttl: 300,
      records: [{ value: '"a, b"' }],
    });
    expect(r.externalId).toBe("77/@/TXT");
  });

  it("edits a record set's values and resets its TTL to the zone default", async () => {
    route({
      [`POST ${CLOUD}/zones/77/rrsets/www/A/actions/set_records`]: { action: { id: 1 } },
      [`POST ${CLOUD}/zones/77/rrsets/www/A/actions/change_ttl`]: { action: { id: 2 } },
      [`GET ${CLOUD}/zones/77/rrsets/www/A`]: {
        rrset: { name: "www", type: "A", ttl: null, records: [{ value: "198.51.100.7" }] },
      },
      [`GET ${CLOUD}/zones/77`]: { zone },
    });
    const r = await makeClient().updateResource(
      "dns-record",
      `${ACCOUNT}:dns-record:77/www/A`,
      ACCOUNT,
      { content: "198.51.100.7", ttl: "" },
    );
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => p.body)).toEqual([
      { records: [{ value: "198.51.100.7" }] },
      { ttl: null },
    ]);
    expect(r.fields["content"]).toBe("198.51.100.7");
  });

  it("changes a zone's default TTL", async () => {
    route({
      [`POST ${CLOUD}/zones/77/actions/change_ttl`]: { action: { id: 1 } },
      [`GET ${CLOUD}/zones/77`]: { zone: { ...zone, ttl: 600 } },
    });
    const r = await makeClient().updateResource("dns-zone", `${ACCOUNT}:dns-zone:77`, ACCOUNT, {
      ttl: "600",
    });
    expect(calls[0]!.body).toEqual({ ttl: 600 });
    expect(r.fields["ttl"]).toBe(600);
  });

  it("deletes a record set by name and type", async () => {
    route({ [`DELETE ${CLOUD}/zones/77/rrsets/www/A`]: { action: { id: 1 } } });
    await makeClient().deleteResource("dns-record", `${ACCOUNT}:dns-record:77/www/A`, ACCOUNT);
    expect(calls[0]!.url).toBe(`${CLOUD}/zones/77/rrsets/www/A`);
  });

  it("splits record values on commas outside quotes and on newlines", () => {
    expect(parseRecordValues('1.1.1.1, 2.2.2.2\n"v=spf1 a, mx"')).toEqual([
      "1.1.1.1",
      "2.2.2.2",
      '"v=spf1 a, mx"',
    ]);
  });
});

describe("certificates", () => {
  const cert = {
    id: 5,
    name: "web",
    type: "managed",
    created: "2026-01-01T00:00:00Z",
    domain_names: ["example.com", "*.example.com"],
    not_valid_before: "2026-01-01T00:00:00Z",
    not_valid_after: "2026-04-01T00:00:00Z",
    fingerprint: "AA:BB",
    status: { issuance: "failed", renewal: "unavailable", error: { message: "dns not found" } },
    used_by: [{ id: 9, type: "load_balancer" }],
  };

  it("lists certificates with expiry, status and load balancer links", async () => {
    route({ [`GET ${CLOUD}/certificates`]: { certificates: [cert] } });
    const [c] = await makeClient().listResources("certificate", ACCOUNT);
    expect(c!.fields).toMatchObject({
      domainNames: "example.com, *.example.com",
      issuanceStatus: "failed",
      statusError: "dns not found",
      notValidAfter: "2026-04-01T00:00:00Z",
      usedByLoadBalancerIds: "9",
    });
    const detail = makeClient().renderDetail(c!);
    expect(JSON.stringify(detail.headerActions)).toContain('"actionId":"retry"');
  });

  it("creates a managed certificate from the domain list", async () => {
    route({ [`POST ${CLOUD}/certificates`]: { certificate: cert, action: { id: 1 } } });
    await makeClient().createResource("certificate", ACCOUNT, {
      name: "web",
      type: "managed",
      domainNames: "example.com, *.example.com",
    });
    expect(calls[0]!.body).toEqual({
      name: "web",
      type: "managed",
      domain_names: ["example.com", "*.example.com"],
    });
  });

  it("creates an uploaded certificate and refuses one without a key", async () => {
    route({ [`POST ${CLOUD}/certificates`]: { certificate: { ...cert, type: "uploaded" } } });
    await expect(
      makeClient().createResource("certificate", ACCOUNT, {
        name: "x",
        type: "uploaded",
        certificate: "PEM",
      }),
    ).rejects.toThrow(/certificate and a key/);
    await makeClient().createResource("certificate", ACCOUNT, {
      name: "x",
      type: "uploaded",
      certificate: "PEM",
      privateKey: "KEY",
    });
    expect(calls[0]!.body).toEqual({
      name: "x",
      type: "uploaded",
      certificate: "PEM",
      private_key: "KEY",
    });
  });

  it("retries a failed issuance", async () => {
    route({ [`POST ${CLOUD}/certificates/5/actions/retry`]: { action: { id: 1 } } });
    await makeClient().invokeAction("certificate", `${ACCOUNT}:certificate:5`, "retry", ACCOUNT);
    expect(calls[0]!.url).toBe(`${CLOUD}/certificates/5/actions/retry`);
  });
});

describe("storage boxes (api.hetzner.com)", () => {
  const box = {
    id: 42,
    name: "backups",
    created: "2026-01-01T00:00:00Z",
    status: "active",
    username: "u12345",
    server: "u12345.your-storagebox.de",
    storage_box_type: { name: "bx11", size: 1_000_000_000_000 },
    location: { name: "fsn1" },
    access_settings: {
      ssh_enabled: true,
      samba_enabled: true,
      webdav_enabled: false,
      zfs_enabled: false,
      reachable_externally: true,
    },
    snapshot_plan: { max_snapshots: 7, minute: 30, hour: 3, day_of_week: null, day_of_month: null },
    protection: { delete: false },
    stats: { size: 250_000_000_000, size_data: 200_000_000_000, size_snapshots: 50_000_000_000 },
  };

  it("lists boxes from the Hetzner API with usage in GB", async () => {
    route({ [`GET ${HETZNER}/storage_boxes`]: { storage_boxes: [box] } });
    const [b] = await makeClient().listResources("storage-box", ACCOUNT);
    expect(calls[0]!.url.startsWith(`${HETZNER}/storage_boxes`)).toBe(true);
    expect(b!.fields).toMatchObject({
      storageBoxType: "bx11",
      sizeGb: 1000,
      usedGb: 250,
      snapshotsGb: 50,
      sambaEnabled: true,
      reachableExternally: true,
      snapshotPlan: "daily at 03:30 UTC, keep 7",
    });
    expect(b!.resolvedOutputs).toEqual({ server: "u12345.your-storagebox.de", username: "u12345" });
  });

  it("builds the create form from storage box types and creates a box", async () => {
    route({
      [`GET ${HETZNER}/storage_box_types`]: {
        storage_box_types: [
          {
            id: 1,
            name: "bx11",
            description: "BX11",
            size: 1099511627776,
            deprecation: null,
            prices: [{ location: "fsn1", price_monthly: { gross: "3.8100" } }],
          },
        ],
      },
      [`POST ${HETZNER}/storage_boxes`]: { storage_box: box, action: { id: 1 } },
    });
    const cfg = await makeClient().getCreateConfig("storage-box");
    const typeField = cfg.fields.find((f) => f.key === "storageBoxType")!;
    expect(typeField.options).toEqual([{ id: "bx11", label: "BX11 · 1 TB · 3.81/mo gross" }]);
    await makeClient().createResource("storage-box", ACCOUNT, {
      name: "backups",
      location: "fsn1",
      storageBoxType: "bx11",
      password: "correct-horse-battery!",
      sshPublicKey: "ssh-ed25519 AAAA me",
      sshEnabled: "true",
      reachableExternally: "false",
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      name: "backups",
      location: "fsn1",
      storage_box_type: "bx11",
      password: "correct-horse-battery!",
      ssh_keys: ["ssh-ed25519 AAAA me"],
      access_settings: { ssh_enabled: true, reachable_externally: false },
    });
  });

  it("edits name, type and access settings with one call each", async () => {
    route({
      [`PUT ${HETZNER}/storage_boxes/42`]: { storage_box: box },
      [`POST ${HETZNER}/storage_boxes/42/actions/change_type`]: { action: { id: 1 } },
      [`POST ${HETZNER}/storage_boxes/42/actions/update_access_settings`]: { action: { id: 2 } },
      [`GET ${HETZNER}/storage_boxes/42`]: { storage_box: box },
    });
    await makeClient().updateResource("storage-box", `${ACCOUNT}:storage-box:42`, ACCOUNT, {
      name: "archive",
      storageBoxType: "bx21",
      sambaEnabled: "false",
    });
    expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.body])).toEqual([
      ["PUT", { name: "archive" }],
      ["POST", { storage_box_type: "bx21" }],
      ["POST", { samba_enabled: false }],
    ]);
  });

  it("takes a snapshot and toggles protection", async () => {
    route({
      [`POST ${HETZNER}/storage_boxes/42/snapshots`]: { snapshot: { id: 1 } },
      [`POST ${HETZNER}/storage_boxes/42/actions/change_protection`]: { action: { id: 1 } },
    });
    const c = makeClient();
    await c.invokeAction("storage-box", `${ACCOUNT}:storage-box:42`, "create_snapshot", ACCOUNT);
    await c.invokeAction("storage-box", `${ACCOUNT}:storage-box:42`, "enable_protection", ACCOUNT);
    expect(calls.map((x) => x.url)).toEqual([
      `${HETZNER}/storage_boxes/42/snapshots`,
      `${HETZNER}/storage_boxes/42/actions/change_protection`,
    ]);
    expect(calls[1]!.body).toEqual({ delete: true });
  });
});

describe("create for network, primary IP and load balancer", () => {
  it("creates a network with its first cloud subnet", async () => {
    route({
      [`POST ${CLOUD}/networks`]: {
        network: { id: 3, name: "net", ip_range: "10.0.0.0/16", created: "x" },
      },
    });
    const r = await makeClient().createResource("network", ACCOUNT, {
      name: "net",
      ipRange: "10.0.0.0/16",
      subnetRange: "10.0.1.0/24",
      networkZone: "eu-central",
    });
    expect(calls[0]!.body).toEqual({
      name: "net",
      ip_range: "10.0.0.0/16",
      subnets: [{ type: "cloud", ip_range: "10.0.1.0/24", network_zone: "eu-central" }],
    });
    expect(r.id).toBe(`${ACCOUNT}:network:3`);
  });

  it("offers network zones from the locations list", async () => {
    route({
      [`GET ${CLOUD}/locations`]: {
        locations: [
          { id: 1, name: "fsn1", city: "Falkenstein", network_zone: "eu-central" },
          { id: 2, name: "ash", city: "Ashburn", network_zone: "us-east" },
        ],
      },
    });
    const cfg = await makeClient().getCreateConfig("network");
    expect(cfg.fields.find((f) => f.key === "networkZone")!.options!.map((o) => o.id)).toEqual([
      "eu-central",
      "us-east",
    ]);
  });

  it("creates an unassigned primary IP in a location", async () => {
    route({
      [`POST ${CLOUD}/primary_ips`]: {
        primary_ip: {
          id: 8,
          name: "edge",
          ip: "1.1.1.1",
          type: "ipv4",
          created: "x",
          location: { name: "fsn1" },
          assignee_id: null,
          assignee_type: "unassigned",
          blocked: false,
          auto_delete: false,
        },
      },
    });
    const r = await makeClient().createResource("primary-ip", ACCOUNT, {
      name: "edge",
      type: "ipv4",
      location: "fsn1",
      autoDelete: "false",
    });
    expect(calls[0]!.body).toEqual({
      name: "edge",
      type: "ipv4",
      location: "fsn1",
      auto_delete: false,
    });
    expect(r.fields["location"]).toBe("fsn1");
  });

  it("creates a load balancer with an algorithm object", async () => {
    route({
      [`POST ${CLOUD}/load_balancers`]: {
        load_balancer: { id: 4, name: "lb", created: "x", location: { name: "nbg1" } },
      },
    });
    await makeClient().createResource("load-balancer", ACCOUNT, {
      name: "lb",
      type: "lb11",
      location: "nbg1",
      algorithm: "least_connections",
    });
    expect(calls[0]!.body).toEqual({
      name: "lb",
      load_balancer_type: "lb11",
      location: "nbg1",
      algorithm: { type: "least_connections" },
    });
  });

  it("lists load balancer types without deprecated ones", async () => {
    route({
      [`GET ${CLOUD}/locations`]: { locations: [] },
      [`GET ${CLOUD}/load_balancer_types`]: {
        load_balancer_types: [
          { id: 1, name: "lb11", max_targets: 25, max_connections: 10000, deprecation: null },
          { id: 2, name: "lb-old", deprecation: { announced: "2026-01-01" } },
        ],
      },
    });
    const cfg = await makeClient().getCreateConfig("load-balancer");
    expect(cfg.fields.find((f) => f.key === "type")!.options).toEqual([
      { id: "lb11", label: "LB11 · 25 targets · 10,000 connections" },
    ]);
  });
});
