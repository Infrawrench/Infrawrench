import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { OvhClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct1";
const BASE = "https://eu.api.ovh.com/1.0/cloud/project/proj123";
const CREDS = {
  applicationKey: "ak",
  applicationSecret: "as",
  consumerKey: "ck",
  projectId: "proj123",
};

function makeClient() {
  return new OvhClient(CREDS, plugin.resourceTypes);
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

/** Route by `METHOD path` relative to the project; exact path match after stripping the query. */
function route(table: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/auth/time")) return okJson(1700000000);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.replace(BASE, "");
    const key = `${method} ${path}`;
    const keyNoQuery = `${method} ${path.split("?")[0]}`;
    if (key in table) return okJson(table[key]);
    if (keyNoQuery in table) return okJson(table[keyNoQuery]);
    return okJson({ message: `unexpected ${key}` }, 404);
  });
}

beforeEach(() => {
  calls = [];
  fetchMock = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mutations = () => calls.filter((c) => c.method !== "GET");

describe("regions", () => {
  it("reads /region as the plain name list the API returns", async () => {
    route({
      "GET /region": ["GRA11", "EU-WEST-PAR"],
      "GET /region/GRA11/floatingip": [{ id: "f1", ip: "1.1.1.1" }],
      "GET /region/EU-WEST-PAR/floatingip": [{ id: "f2", ip: "2.2.2.2" }],
    });
    const ips = await makeClient().listResources("floating-ip", ACCOUNT);
    expect(ips.map((i) => i.externalId)).toEqual(["GRA11/f1", "EU-WEST-PAR/f2"]);
  });

  it("labels 3-AZ regions in the pickers", async () => {
    route({ "GET /region": ["EU-WEST-PAR"] });
    const cfg = await makeClient().getCreateConfig("volume");
    const region = cfg.fields.find((f) => f.key === "region")!;
    expect(region.regions).toEqual([
      { id: "EU-WEST-PAR", label: "EU-WEST-PAR", location: "Paris, France (3 AZ)", flag: "🇫🇷" },
    ]);
  });
});

describe("instance actions and edits", () => {
  it.each([
    ["start", "/instance/i1/start", undefined],
    ["stop", "/instance/i1/stop", undefined],
    ["shelve", "/instance/i1/shelve", undefined],
    ["unshelve", "/instance/i1/unshelve", undefined],
    ["reboot", "/instance/i1/reboot", { type: "soft" }],
    ["reboot_hard", "/instance/i1/reboot", { type: "hard" }],
  ])("%s posts to %s", async (actionId, path, body) => {
    route({ [`POST ${path}`]: null });
    await makeClient().invokeAction("instance", `${ACCOUNT}:instance:i1`, actionId, ACCOUNT);
    expect(mutations()[0]!.url).toBe(`${BASE}${path}`);
    expect(mutations()[0]!.body).toEqual(body);
  });

  it("snapshots an instance with a dated name", async () => {
    route({ "POST /instance/i1/snapshot": {} });
    await makeClient().invokeAction("instance", `${ACCOUNT}:instance:i1`, "snapshot", ACCOUNT);
    expect((mutations()[0]!.body as { snapshotName: string }).snapshotName).toMatch(
      /^infrawrench-/,
    );
  });

  it("renames and resizes, resolving the flavor name to the regional id", async () => {
    route({
      "GET /instance": [{ id: "i1", name: "web", region: "GRA11", status: "SHUTOFF" }],
      "GET /flavor?region=GRA11": [
        { id: "flv-b3-8", name: "b3-8" },
        { id: "flv-b3-16", name: "b3-16" },
      ],
      "PUT /instance/i1": null,
      "POST /instance/i1/resize": {},
    });
    const r = await makeClient().updateResource("instance", `${ACCOUNT}:instance:i1`, ACCOUNT, {
      name: "web-2",
      flavorName: "b3-16",
    });
    expect(mutations().map((c) => [c.method, c.url.replace(BASE, ""), c.body])).toEqual([
      ["PUT", "/instance/i1", { instanceName: "web-2" }],
      ["POST", "/instance/i1/resize", { flavorId: "flv-b3-16" }],
    ]);
    expect(r.fields).toMatchObject({ name: "web-2", flavorName: "b3-16" });
  });

  it("offers stop, reboot and shelve on a running instance", () => {
    const detail = makeClient().renderDetail({
      id: `${ACCOUNT}:instance:i1`,
      pluginId: "ovh",
      resourceTypeId: "instance",
      accountId: ACCOUNT,
      displayName: "web",
      fields: { status: "ACTIVE" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "x",
      updatedAt: "x",
    });
    const ids = (detail.headerActions ?? []).map((a) =>
      "action" in a && a.action.type === "plugin-action" ? a.action.actionId : "",
    );
    expect(ids).toEqual(
      expect.arrayContaining(["stop", "reboot", "reboot_hard", "shelve", "snapshot"]),
    );
  });
});

describe("volumes", () => {
  const volumes = [{ id: "v1", name: "data", region: "GRA11", size: 50, type: "classic" }];

  it("renames and upsizes a volume", async () => {
    route({ "GET /volume": volumes, "PUT /volume/v1": {}, "POST /volume/v1/upsize": {} });
    const r = await makeClient().updateResource("volume", `${ACCOUNT}:volume:v1`, ACCOUNT, {
      name: "data-2",
      description: "db",
      sizeGb: "100",
    });
    expect(mutations().map((c) => c.body)).toEqual([
      { name: "data-2", description: "db" },
      { size: 100 },
    ]);
    expect(r.fields["sizeGb"]).toBe(100);
  });

  it("refuses to shrink a volume", async () => {
    route({ "GET /volume": volumes });
    await expect(
      makeClient().updateResource("volume", `${ACCOUNT}:volume:v1`, ACCOUNT, { sizeGb: "10" }),
    ).rejects.toThrow(/can only grow/);
  });

  it("lists volume snapshots linked to their volume", async () => {
    route({
      "GET /volume/snapshot": [
        {
          id: "s1",
          name: "nightly",
          region: "GRA11",
          size: 50,
          status: "available",
          volumeId: "v1",
          creationDate: "2026-09-01T00:00:00Z",
        },
      ],
    });
    const [snap] = await makeClient().listResources("volume-snapshot", ACCOUNT);
    expect(snap!.fields).toMatchObject({
      volumeId: "v1",
      sizeGb: 50,
      createdAt: "2026-09-01T00:00:00Z",
    });
  });
});

describe("managed kubernetes", () => {
  it("reads the pool flavor from the `flavor` field and the etcd usage", async () => {
    route({
      "GET /kube": ["k1"],
      "GET /kube/k1": {
        id: "k1",
        name: "prod",
        version: "1.32",
        updatePolicy: "MINIMAL_DOWNTIME",
        isUpToDate: false,
        nextUpgradeVersions: ["1.33"],
      },
      "GET /kube/k1/nodepool": [{ id: "p1", flavor: "b3-8", desiredNodes: 3 }],
      "GET /kube/k1/metrics/etcdUsage": { quota: 1000, usage: 250 },
    });
    const [k] = await makeClient().listResources("managed-kube", ACCOUNT);
    expect(k!.fields).toMatchObject({
      flavor: "b3-8",
      nextUpgradeVersions: "1.33",
      etcdUsagePercent: 25,
      updatePolicy: "MINIMAL_DOWNTIME",
    });
  });

  it("offers the creatable versions from the schema enum", async () => {
    route({ "GET /region": [], "GET /flavor": [] });
    const cfg = await makeClient().getCreateConfig("managed-kube");
    expect(cfg.fields.find((f) => f.key === "version")!.options!.map((o) => o.id)).toEqual([
      "1.35",
      "1.34",
      "1.33",
      "1.32",
      "1.31",
    ]);
  });

  it("updates to the next minor version and resets the kubeconfig", async () => {
    route({ "POST /kube/k1/update": null, "POST /kube/k1/kubeconfig/reset": {} });
    const c = makeClient();
    await c.invokeAction("managed-kube", `${ACCOUNT}:managed-kube:k1`, "update_minor", ACCOUNT);
    await c.invokeAction("managed-kube", `${ACCOUNT}:managed-kube:k1`, "reset_kubeconfig", ACCOUNT);
    expect(mutations()[0]!.body).toEqual({ strategy: "NEXT_MINOR" });
    expect(mutations()[1]!.url).toBe(`${BASE}/kube/k1/kubeconfig/reset`);
  });

  it("edits the update policy and resizes the first pool", async () => {
    route({
      "GET /kube": ["k1"],
      "GET /kube/k1": { id: "k1", name: "prod" },
      "GET /kube/k1/nodepool": [
        { id: "p1", desiredNodes: 3, minNodes: 3, maxNodes: 5 },
        { id: "p2", desiredNodes: 2 },
      ],
      "PUT /kube/k1": null,
      "PUT /kube/k1/nodepool/p1": null,
    });
    await makeClient().updateResource("managed-kube", `${ACCOUNT}:managed-kube:k1`, ACCOUNT, {
      updatePolicy: "NEVER_UPDATE",
      nodeCount: "4",
    });
    expect(mutations().map((c) => c.body)).toEqual([
      { updatePolicy: "NEVER_UPDATE" },
      { desiredNodes: 2, minNodes: 2 },
    ]);
  });
});

describe("managed databases", () => {
  it("builds the create form from /database/capabilities", async () => {
    route({
      "GET /database/capabilities": {
        engines: [
          { name: "postgresql", defaultVersion: "17", versions: ["16", "17"] },
          { name: "valkey", defaultVersion: "8.0", versions: ["8.0"] },
        ],
        plans: [
          { name: "discovery", lifecycle: { status: "STABLE" } },
          { name: "legacy", lifecycle: { status: "END_OF_SALE" } },
        ],
        flavors: [
          {
            name: "b3-8",
            specifications: {
              core: 2,
              memory: { unit: "GB", value: 8 },
              storage: { unit: "GB", value: 80 },
            },
            lifecycle: { status: "STABLE" },
          },
        ],
        regions: ["GRA", "SBG"],
      },
    });
    const cfg = await makeClient().getCreateConfig("managed-db");
    const byKey = Object.fromEntries(cfg.fields.map((f) => [f.key, f]));
    expect(byKey["engine"]!.options!.map((o) => o.id)).toEqual(["postgresql", "valkey"]);
    expect(byKey["version"]!.defaultValue).toBe("17");
    expect(byKey["plan"]!.options!.map((o) => o.id)).toEqual(["discovery"]);
    expect(byKey["flavor"]!.sizes).toEqual([
      { id: "b3-8", label: "b3-8", vcpus: 2, memoryMb: 8192, diskGb: 80, category: "b3" },
    ]);
    expect(byKey["region"]!.options!.map((o) => o.id)).toEqual(["GRA", "SBG"]);
  });

  it("maps backup retention and deletion protection, and edits via the engine path", async () => {
    route({
      "GET /database/service": ["db1"],
      "GET /database/service/db1": {
        id: "db1",
        engine: "postgresql",
        description: "main",
        deletionProtection: true,
        backups: { time: "02:00:00", retentionDays: 7 },
        storage: { size: { unit: "GB", value: 80 } },
      },
      "PUT /database/postgresql/db1": {},
    });
    const c = makeClient();
    const [db] = await c.listResources("managed-db", ACCOUNT);
    expect(db!.fields).toMatchObject({
      deletionProtection: true,
      backupRetentionDays: 7,
      backupTime: "02:00:00",
      storageSizeGb: 80,
    });
    await c.updateResource("managed-db", db!.id, ACCOUNT, {
      flavor: "b3-16",
      deletionProtection: "false",
    });
    expect(mutations()[0]!.body).toEqual({ flavor: "b3-16", deletionProtection: false });
  });
});

describe("Octavia load balancers", () => {
  it("lists per region with the flavor name and the floating IP", async () => {
    route({
      "GET /region": ["GRA11"],
      "GET /region/GRA11/loadbalancing/loadbalancer": [
        {
          id: "lb1",
          name: "edge",
          flavorId: "fl-small",
          provisioningStatus: "active",
          operatingStatus: "online",
          vipAddress: "10.0.0.5",
          vipNetworkId: "os-net-1",
          floatingIp: { id: "fip1", ip: "51.1.1.1" },
        },
      ],
      "GET /region/GRA11/loadbalancing/flavor": [{ id: "fl-small", name: "small" }],
    });
    const [lb] = await makeClient().listResources("octavia-load-balancer", ACCOUNT);
    expect(lb!.externalId).toBe("GRA11/lb1");
    expect(lb!.fields).toMatchObject({ flavor: "small", floatingIp: "51.1.1.1" });
  });

  it("resizes by flavor name", async () => {
    route({
      "GET /region": ["GRA11"],
      "GET /region/GRA11/loadbalancing/loadbalancer": [{ id: "lb1", name: "edge" }],
      "GET /region/GRA11/loadbalancing/flavor": [
        { id: "fl-small", name: "small" },
        { id: "fl-large", name: "large" },
      ],
      "PUT /region/GRA11/loadbalancing/loadbalancer/lb1": {},
      "GET /region/GRA11/loadbalancing/loadbalancer/lb1": {
        id: "lb1",
        name: "edge",
        flavorId: "fl-large",
      },
    });
    const r = await makeClient().updateResource(
      "octavia-load-balancer",
      `${ACCOUNT}:octavia-load-balancer:GRA11/lb1`,
      ACCOUNT,
      { flavor: "large" },
    );
    expect(mutations()[0]!.body).toEqual({ flavorId: "fl-large" });
    expect(r.fields["flavor"]).toBe("large");
  });

  it("reports lifetime stats on the dashboard", async () => {
    route({
      "GET /region/GRA11/loadbalancing/loadbalancer/lb1/stats": {
        activeConnections: 4,
        totalConnections: 100,
        bytesIn: 2e9,
        bytesOut: 1e9,
        requestErrors: 0,
      },
    });
    const stats = await makeClient().fetchDashboardStats(
      "octavia-load-balancer",
      `${ACCOUNT}:octavia-load-balancer:GRA11/lb1`,
      ACCOUNT,
    );
    expect(stats.map((s) => [s.label, s.value])).toEqual([
      ["Active Connections", "4"],
      ["Total Connections", "100"],
      ["Bytes In", "2.00 GB"],
      ["Bytes Out", "1.00 GB"],
      ["Request Errors", "0"],
    ]);
  });
});

describe("container registry", () => {
  it("creates a registry with the plan id of the chosen region", async () => {
    route({
      "GET /capabilities/containerRegistry": [
        { regionName: "GRA", plans: [{ id: "plan-gra-s", name: "SMALL" }] },
        { regionName: "BHS", plans: [{ id: "plan-bhs-s", name: "SMALL" }] },
      ],
      "POST /containerRegistry": { id: "r1", name: "team", region: "BHS", url: "https://x" },
    });
    const r = await makeClient().createResource("container-registry", ACCOUNT, {
      name: "team",
      region: "BHS",
      plan: "SMALL",
    });
    expect(mutations()[0]!.body).toEqual({ name: "team", region: "BHS", planID: "plan-bhs-s" });
    expect(r.resolvedOutputs["url"]).toBe("https://x");
  });
});
