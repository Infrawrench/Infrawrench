import { describe, expect, it } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { OpenStackApi, describeOpenStackError, normalizeAuthUrl } from "../api.js";
import { OpenStackClient } from "../client.js";
import {
  describeRule,
  isPublicReadAcl,
  mapServerFields,
  serverAddresses,
  type NovaServer,
} from "../mappers.js";
import { ruleBody } from "../ops.js";
import { fetchOpenStackQuotas } from "../extras.js";
import { plugin } from "../plugin.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const CATALOG = [
  {
    type: "compute",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://nova.example.com/v2.1" },
      { interface: "public", region_id: "RegionTwo", url: "https://nova2.example.com/v2.1" },
    ],
  },
  {
    type: "network",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://neutron.example.com/" },
      { interface: "internal", region_id: "RegionOne", url: "http://neutron.internal:9696" },
    ],
  },
  {
    type: "image",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://glance.example.com/v2" },
    ],
  },
  {
    type: "volumev3",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://cinder.example.com/v3/proj1" },
    ],
  },
  {
    type: "object-store",
    endpoints: [
      {
        interface: "public",
        region_id: "RegionOne",
        url: "https://swift.example.com/v1/AUTH_proj1",
      },
    ],
  },
];

type Route =
  unknown | ((c: Call) => { status: number; body?: unknown; headers?: Record<string, string> });

function mockHttp(routes: Record<string, Route>) {
  const calls: Call[] = [];
  let tokens = 0;
  const http: HttpHostServices = {
    async request(req) {
      const c = req as Call;
      calls.push(c);
      const u = new URL(req.url);
      if (req.method === "POST" && u.pathname === "/v3/auth/tokens") {
        tokens++;
        return {
          status: 201,
          headers: { "x-subject-token": `tok-${tokens}` },
          body: JSON.stringify({
            token: {
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              project: { id: "proj1", name: "demo" },
              user: { id: "u1" },
              catalog: CATALOG,
            },
          }),
        };
      }
      const key = `${req.method} ${u.host}${u.pathname}`;
      const route = routes[`${key}${u.search}`] ?? routes[key];
      if (route === undefined)
        return {
          status: 404,
          headers: {},
          body: JSON.stringify({ itemNotFound: { message: `no route ${key}${u.search}` } }),
        };
      if (typeof route === "function") {
        const r = (
          route as (c: Call) => { status: number; body?: unknown; headers?: Record<string, string> }
        )(c);
        return {
          status: r.status,
          headers: r.headers ?? {},
          body: r.body === undefined ? "" : JSON.stringify(r.body),
        };
      }
      return { status: 200, headers: {}, body: JSON.stringify(route) };
    },
  };
  return { http, calls, tokens: () => tokens };
}

const APP = {
  authUrl: "https://keystone.example.com:5000",
  applicationCredentialId: "abc",
  applicationCredentialSecret: "s3cret",
  region: "RegionOne",
};

const SERVER: NovaServer = {
  id: "srv-1",
  name: "web01",
  status: "ACTIVE",
  flavor: { original_name: "m1.small", vcpus: 1, ram: 2048, disk: 20 },
  image: { id: "img-1" },
  key_name: "mykey",
  "OS-EXT-AZ:availability_zone": "nova",
  addresses: {
    private: [
      { addr: "10.0.0.5", version: 4, "OS-EXT-IPS:type": "fixed" },
      { addr: "203.0.113.9", version: 4, "OS-EXT-IPS:type": "floating" },
    ],
  },
  security_groups: [{ name: "default" }, { name: "default" }],
  "os-extended-volumes:volumes_attached": [{ id: "vol-1" }],
};

describe("api", () => {
  it("normalises Keystone URLs to /v3", () => {
    expect(normalizeAuthUrl("keystone.example.com:5000")).toBe(
      "https://keystone.example.com:5000/v3",
    );
    expect(normalizeAuthUrl("https://k/identity/v3/")).toBe("https://k/identity/v3");
    expect(normalizeAuthUrl("https://k:5000/v2.0")).toBe("https://k:5000/v3");
  });

  it("builds password and application-credential auth bodies", () => {
    const pw = new OpenStackApi({
      authUrl: "https://k/v3",
      username: "alice",
      password: "pw",
      project: "demo",
      projectDomain: "Default",
    });
    expect(pw.authBody(true)).toEqual({
      auth: {
        identity: {
          methods: ["password"],
          password: { user: { name: "alice", domain: { name: "Default" }, password: "pw" } },
        },
        scope: { project: { name: "demo", domain: { name: "Default" } } },
      },
    });
    const byId = new OpenStackApi({
      authUrl: "https://k/v3",
      username: "alice",
      password: "pw",
      project: "0123456789abcdef0123456789abcdef",
    });
    expect((byId.authBody(true)["auth"] as { scope: unknown }).scope).toEqual({
      project: { id: "0123456789abcdef0123456789abcdef" },
    });
    const app = new OpenStackApi(APP);
    expect(app.authBody(true)).toEqual({
      auth: {
        identity: {
          methods: ["application_credential"],
          application_credential: { id: "abc", secret: "s3cret" },
        },
      },
    });
  });

  it("picks endpoints by region and interface and strips version segments", () => {
    expect(OpenStackApi.pickEndpoint(CATALOG, "compute", "RegionTwo", "public")).toBe(
      "https://nova2.example.com/v2.1",
    );
    expect(OpenStackApi.pickEndpoint(CATALOG, "network", "RegionOne", "internal")).toBe(
      "http://neutron.internal:9696",
    );
    expect(OpenStackApi.pickEndpoint(CATALOG, "image", "RegionOne", "public")).toBe(
      "https://glance.example.com",
    );
    expect(OpenStackApi.pickEndpoint(CATALOG, "block-storage", "RegionOne", "public")).toBe(
      "https://cinder.example.com/v3/proj1",
    );
    expect(OpenStackApi.pickEndpoint(CATALOG, "dns", "RegionOne", "public")).toBeUndefined();
    expect(OpenStackApi.catalogRegions(CATALOG)).toEqual(["RegionOne", "RegionTwo"]);
  });

  it("extracts error messages from every service's envelope", () => {
    expect(
      describeOpenStackError(
        JSON.stringify({ badRequest: { message: "Invalid flavorRef", code: 400 } }),
      ),
    ).toBe("Invalid flavorRef");
    expect(
      describeOpenStackError(
        JSON.stringify({ NeutronError: { message: "Quota exceeded", type: "OverQuota" } }),
      ),
    ).toBe("Quota exceeded");
    expect(
      describeOpenStackError(JSON.stringify({ faultstring: "Load Balancer is immutable" })),
    ).toBe("Load Balancer is immutable");
  });

  it("paginates with markers and sends the token and microversion", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({ ...SERVER, id: `s${i}` }));
    const { http, calls } = mockHttp({
      "GET nova.example.com/v2.1/servers/detail?limit=500": { servers: page1 },
      "GET nova.example.com/v2.1/servers/detail?limit=500&marker=s499": {
        servers: [{ ...SERVER, id: "last" }],
      },
    });
    const api = new OpenStackApi(APP, http);
    const all = await api.paginate("compute", "/servers/detail", "servers");
    expect(all).toHaveLength(501);
    const list = calls.find((c) => c.url.includes("/servers/detail"))!;
    expect(list.headers["X-Auth-Token"]).toBe("tok-1");
    expect(list.headers["OpenStack-API-Version"]).toBe("compute 2.47");
  });

  it("re-authenticates once on 401", async () => {
    let n = 0;
    const m = mockHttp({
      "GET nova.example.com/v2.1/limits": () =>
        n++ === 0 ? { status: 401, body: {} } : { status: 200, body: { limits: { absolute: {} } } },
    });
    const api = new OpenStackApi(APP, m.http);
    await api.get("compute", "/limits");
    expect(m.tokens()).toBe(2);
  });
});

describe("mappers", () => {
  it("maps servers with fixed and floating addresses", () => {
    expect(serverAddresses(SERVER)).toMatchObject({
      publicIp: "203.0.113.9",
      privateIp: "10.0.0.5",
    });
    const f = mapServerFields(SERVER, new Map([["private", "net-1"]]));
    expect(f).toMatchObject({
      flavor: "m1.small",
      vcpus: 1,
      ramMb: 2048,
      imageId: "img-1",
      networkIds: "net-1",
      securityGroups: "default",
      volumeIds: "vol-1",
    });
  });

  it("describes rules and builds rule bodies", () => {
    const rule = {
      id: "r",
      direction: "ingress",
      ethertype: "IPv4",
      protocol: "tcp",
      port_range_min: 22,
      port_range_max: 22,
      remote_ip_prefix: "0.0.0.0/0",
      security_group_id: "sg",
    };
    expect(describeRule(rule)).toBe("ingress IPv4 tcp:22 from 0.0.0.0/0");
    expect(
      ruleBody("sg", {
        direction: "ingress",
        ethertype: "IPv4",
        protocol: "tcp",
        portMin: "80",
        remoteIpPrefix: "",
      }),
    ).toEqual({
      security_group_rule: {
        security_group_id: "sg",
        direction: "ingress",
        ethertype: "IPv4",
        protocol: "tcp",
        port_range_min: 80,
        port_range_max: 80,
      },
    });
    expect(isPublicReadAcl(".r:*,.rlistings")).toBe(true);
    expect(isPublicReadAcl("proj1:alice")).toBe(false);
  });
});

describe("client", () => {
  const routes: Record<string, Route> = {
    "GET nova.example.com/v2.1/servers/detail": { servers: [SERVER] },
    "GET neutron.example.com/v2.0/networks": {
      networks: [
        { id: "net-1", name: "private", project_id: "proj1", subnets: ["sub-1"] },
        { id: "ext-1", name: "public", "router:external": true },
      ],
    },
    "GET swift.example.com/v1/AUTH_proj1": [{ name: "assets", count: 3, bytes: 1073741824 }],
    "HEAD swift.example.com/v1/AUTH_proj1/assets": () => ({
      status: 204,
      headers: { "X-Container-Read": ".r:*,.rlistings" },
    }),
  };

  it("lists servers with network ids and outputs", async () => {
    const { http } = mockHttp(routes);
    const client = new OpenStackClient(APP, { http });
    const [s] = await client.listResources("os-server", "acct");
    expect(s!.fields["networkIds"]).toBe("net-1");
    expect(s!.resolvedOutputs["publicIp"]).toBe("203.0.113.9");
  });

  it("returns nothing for services missing from the catalog", async () => {
    const { http } = mockHttp(routes);
    const client = new OpenStackClient(APP, { http });
    expect(await client.listResources("os-dns-zone", "acct")).toEqual([]);
    expect(await client.listResources("os-loadbalancer", "acct")).toEqual([]);
  });

  it("lists Swift containers with their read ACL", async () => {
    const { http } = mockHttp(routes);
    const client = new OpenStackClient(APP, { http });
    const [c] = await client.listResources("os-container", "acct");
    expect(c!.fields).toMatchObject({
      name: "assets",
      objectCount: 3,
      sizeGb: 1,
      publicRead: true,
    });
  });

  it("server power actions post Nova action bodies", async () => {
    let body = "";
    const { http } = mockHttp({
      ...routes,
      "POST nova.example.com/v2.1/servers/srv-1/action": (c: Call) => (
        (body = c.body ?? ""),
        { status: 202 }
      ),
    });
    const client = new OpenStackClient(APP, { http });
    await client.invokeAction("os-server", "acct:os-server:srv-1", "reboot-hard", "acct");
    expect(JSON.parse(body)).toEqual({ reboot: { type: "HARD" } });
  });

  it("associates a floating IP with the server's port", async () => {
    let body = "";
    const { http } = mockHttp({
      ...routes,
      "GET neutron.example.com/v2.0/ports?device_id=srv-1": {
        ports: [{ id: "port-1", fixed_ips: [{ ip_address: "10.0.0.5" }] }],
      },
      "PUT neutron.example.com/v2.0/floatingips/fip-1": (c: Call) => (
        (body = c.body ?? ""),
        { status: 200, body: {} }
      ),
    });
    const client = new OpenStackClient(APP, { http });
    await client.attachResource(
      "os-floating-ip",
      "acct:os-floating-ip:fip-1",
      "os-server",
      "acct:os-server:srv-1",
      "acct",
    );
    expect(JSON.parse(body)).toEqual({ floatingip: { port_id: "port-1" } });
  });

  it("reads console output as logs", async () => {
    const { http } = mockHttp({
      ...routes,
      "POST nova.example.com/v2.1/servers/srv-1/action": { output: "boot ok\n" },
    });
    const client = new OpenStackClient(APP, { http });
    const logs = await client.getLogs("os-server", "acct:os-server:srv-1", "acct", {
      tailLines: 50,
    });
    expect(logs.text).toBe("boot ok\n");
  });

  it("reports quotas from Nova, Cinder and Neutron, skipping unlimited ones", async () => {
    const { http } = mockHttp({
      "GET nova.example.com/v2.1/limits": {
        limits: {
          absolute: {
            maxTotalInstances: 10,
            totalInstancesUsed: 3,
            maxTotalCores: -1,
            totalCoresUsed: 4,
            maxTotalRAMSize: 51200,
            totalRAMUsed: 2048,
          },
        },
      },
      "GET cinder.example.com/v3/proj1/limits": {
        limits: {
          absolute: {
            maxTotalVolumes: 10,
            totalVolumesUsed: 1,
            maxTotalVolumeGigabytes: 1000,
            totalGigabytesUsed: 20,
          },
        },
      },
      "GET neutron.example.com/v2.0/quotas/proj1/details.json": {
        quota: {
          floatingip: { limit: 5, used: 2, reserved: 0 },
          subnetpool: { limit: -1, used: 0 },
        },
      },
    });
    const client = new OpenStackClient(APP, { http });
    const q = await fetchOpenStackQuotas(client);
    expect(q.map((x) => x.id).sort()).toEqual([
      "block-storage/gigabytes",
      "block-storage/volumes",
      "compute/instances",
      "compute/ram",
      "network/floatingip",
    ]);
    expect(q.find((x) => x.id === "compute/ram")).toMatchObject({
      limit: 51200,
      used: 2048,
      unit: "MiB",
      region: "RegionOne",
    });
  });
});

describe("credential options", () => {
  it("lists regions from the catalog", async () => {
    const { http } = mockHttp({});
    const opts = await plugin.listCredentialOptions!("region", APP, { http });
    expect(opts.map((o) => o.id)).toEqual(["RegionOne", "RegionTwo"]);
  });
});
