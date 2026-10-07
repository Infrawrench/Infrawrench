import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LambdaCloudClient } from "../client.js";
import { LambdaApiError } from "../api.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { formatRules, parseRules, sshOpenToInternet } from "../firewall.js";
import { imageOptions, regionOptions, sizeOption } from "../create-config.js";
import { parseTags } from "../mappers.js";
import { parseStatusFeed, regionsInTitle } from "../status-feed.js";

interface Call {
  method: string;
  url: URL;
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
      const call: Call = {
        method: init.method ?? "GET",
        url: u,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const handler = routes[`${call.method} ${u.pathname.replace(/^\/api\/v1/, "")}`];
      if (!handler) {
        return new Response(
          JSON.stringify({ error: { code: "global/object-does-not-exist", message: "Not found" } }),
          { status: 404 },
        );
      }
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const client = () => new LambdaCloudClient({ apiKey: "secret_k" }, RESOURCE_TYPES);

const INSTANCE = {
  id: "i1",
  name: "trainer",
  ip: "1.2.3.4",
  private_ip: "10.0.0.2",
  status: "active",
  ssh_key_names: ["laptop"],
  file_system_names: ["data"],
  file_system_mounts: [{ mount_point: "/lambda/nfs/data", file_system_id: "fs1" }],
  region: { name: "us-east-1", description: "Virginia, USA" },
  instance_type: {
    name: "gpu_1x_h100_pcie",
    description: "1x H100 (80 GB PCIe)",
    gpu_description: "H100 (80 GB PCIe)",
    price_cents_per_hour: 249,
    specs: { vcpus: 26, memory_gib: 200, storage_gib: 1024, gpus: 1 },
    architecture: "x86_64",
  },
  image: { id: "img", family: "lambda-stack-22-04" },
  jupyter_token: "tok",
  jupyter_url: "https://jupyter/?token=tok",
  first_healthy: "2026-10-01T00:00:00Z",
  actions: { restart: { available: true } },
  tags: [{ key: "team", value: "ml" }],
  firewall_rulesets: [{ id: "rs1" }],
};

describe("api", () => {
  it("sends Bearer auth and unwraps data", async () => {
    route("GET", "/ssh-keys", {
      data: [{ id: "k1", name: "laptop", public_key: "ssh-ed25519 AAA" }],
    });
    const keys = await client().listResources("ssh-key", "acct");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer secret_k");
    expect(keys[0]!.displayName).toBe("laptop");
  });

  it("maps the error envelope and keeps the status", async () => {
    route(
      "GET",
      "/filesystems",
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "global/invalid-api-key",
              message: "API key was invalid",
              suggestion: "Create a new key",
            },
          }),
          { status: 401 },
        ),
    );
    const err = (await client()
      .listResources("filesystem", "acct")
      .catch((e: unknown) => e)) as LambdaApiError;
    expect(err).toBeInstanceOf(LambdaApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("global/invalid-api-key");
    expect(err.message).toContain("Create a new key");
  });

  it("follows page_token on instances", async () => {
    route("GET", "/instances", (c: Call) =>
      c.url.searchParams.get("page_token")
        ? { data: [{ ...INSTANCE, id: "i2" }], page_token: null }
        : { data: [INSTANCE], page_token: "next" },
    );
    const list = await client().listResources("instance", "acct");
    expect(list.map((i) => i.externalId)).toEqual(["i1", "i2"]);
    expect(calls[0]!.url.searchParams.get("page_size")).toBe("100");
  });
});

describe("instances", () => {
  it("maps specs, price and connection outputs without storing Jupyter credentials", async () => {
    route("GET", "/instances", { data: [INSTANCE], page_token: null });
    const [i] = await client().listResources("instance", "acct");
    expect(i!.fields).toMatchObject({
      region: "us-east-1",
      instanceType: "gpu_1x_h100_pcie",
      gpus: 1,
      pricePerHour: 2.49,
      filesystemIds: "fs1",
      firewallRulesetIds: "rs1",
      tags: "team=ml",
      restartBlocked: "",
    });
    expect(i!.resolvedOutputs["sshCommand"]).toBe("ssh ubuntu@1.2.3.4");
    expect(JSON.stringify(i)).not.toContain("tok");
  });

  it("resolves the Jupyter URL on demand", async () => {
    route("GET", "/instances/i1", { data: INSTANCE });
    expect(await client().resolveOutput("instance", "acct:instance:i1", "jupyterUrl", "acct")).toBe(
      "https://jupyter/?token=tok",
    );
  });

  it("launches with picker values and reads the new instance back", async () => {
    route("POST", "/instance-operations/launch", { data: { instance_ids: ["i1"] } });
    route("GET", "/instances/i1", { data: INSTANCE });
    const created = await client().createResource("instance", "acct", {
      name: "trainer",
      instanceTypeName: "gpu_1x_h100_pcie",
      regionName: "us-east-1",
      sshKeyName: "laptop",
      image: "lambda-stack-24-04",
      filesystemName: "data",
      firewallRulesetId: "rs1",
      tags: "team=ml, lambda-ai-x=1",
      userData: "#cloud-config",
    });
    expect(calls[0]!.body).toEqual({
      region_name: "us-east-1",
      instance_type_name: "gpu_1x_h100_pcie",
      ssh_key_names: ["laptop"],
      name: "trainer",
      image: { family: "lambda-stack-24-04" },
      file_system_names: ["data"],
      firewall_rulesets: [{ id: "rs1" }],
      tags: [{ key: "team", value: "ml" }],
      user_data: "#cloud-config",
    });
    expect(created.externalId).toBe("i1");
  });

  it("omits the image for the default and none pickers", () => {
    const body = client().launchBody({
      instanceTypeName: "t",
      regionName: "r",
      sshKeyName: "k",
      image: "default",
      filesystemName: "none",
      firewallRulesetId: "none",
    });
    expect(body).toEqual({ region_name: "r", instance_type_name: "t", ssh_key_names: ["k"] });
  });

  it("terminates and restarts through instance-operations", async () => {
    route("POST", "/instance-operations/terminate", { data: { terminated_instances: [] } });
    route("POST", "/instance-operations/restart", { data: { restarted_instances: [] } });
    const c = client();
    await c.deleteResource("instance", "acct:instance:i1", "acct");
    await c.invokeAction("instance", "acct:instance:i1", "restart", "acct");
    expect(calls.map((x) => [x.url.pathname, x.body])).toEqual([
      ["/api/v1/instance-operations/terminate", { instance_ids: ["i1"] }],
      ["/api/v1/instance-operations/restart", { instance_ids: ["i1"] }],
    ]);
  });

  it("renames and retags", async () => {
    route("POST", "/instances/i1", { data: INSTANCE });
    await client().updateResource("instance", "acct:instance:i1", "acct", {
      name: "x",
      tags: "a=1",
    });
    expect(calls[0]!.body).toEqual({ name: "x", tags: [{ key: "a", value: "1" }] });
  });

  it("estimates from the type's list price", async () => {
    route("GET", "/instance-types", {
      data: {
        gpu_1x_h100_pcie: {
          instance_type: INSTANCE.instance_type,
          regions_with_capacity_available: [],
        },
      },
    });
    const est = await client().estimateCost("instance", { instanceTypeName: "gpu_1x_h100_pcie" });
    expect(est?.monthlyAmount).toBeCloseTo(2.49 * 730, 2);
  });
});

describe("firewall", () => {
  it("round-trips rules through the text format", () => {
    const text =
      "tcp 22 0.0.0.0/0 SSH\ntcp 8000-8100 10.0.0.0/8 internal apis\nicmp - 0.0.0.0/0 ping\nall - 1.2.3.4/32";
    const rules = parseRules(text);
    expect(rules[1]).toEqual({
      protocol: "tcp",
      port_range: [8000, 8100],
      source_network: "10.0.0.0/8",
      description: "internal apis",
    });
    expect(rules[2]!.port_range).toBeUndefined();
    expect(rules[3]!.port_range).toEqual([1, 65535]);
    expect(formatRules(rules)).toBe(
      "tcp 22 0.0.0.0/0 SSH\ntcp 8000-8100 10.0.0.0/8 internal apis\nicmp - 0.0.0.0/0 ping\nall 1-65535 1.2.3.4/32",
    );
    expect(sshOpenToInternet(rules)).toBe(true);
  });

  it("rejects malformed lines with the line number", () => {
    expect(() => parseRules("tcp 22 0.0.0.0/0\nfoo 1 0.0.0.0/0")).toThrow(/line 2/);
    expect(() => parseRules("tcp 22 everywhere")).toThrow(/CIDR/);
    expect(() => parseRules("tcp 99999 0.0.0.0/0")).toThrow(/1-65535/);
  });

  it("patches a ruleset and the global rules", async () => {
    route("PATCH", "/firewall-rulesets/rs1", (c: Call) => ({
      data: {
        id: "rs1",
        name: "web",
        region: { name: "us-east-1" },
        rules: (c.body as { rules: unknown }).rules,
        instance_ids: ["i1"],
      },
    }));
    route("PATCH", "/firewall-rulesets/global", (c: Call) => ({
      data: { id: "global", name: "Global", rules: (c.body as { rules: unknown }).rules },
    }));
    const c = client();
    const rs = await c.updateResource("firewall-ruleset", "acct:firewall-ruleset:rs1", "acct", {
      rules: "tcp 443 0.0.0.0/0 https",
    });
    expect(rs.fields).toMatchObject({
      ruleCount: 1,
      openToInternet: true,
      sshOpenToInternet: false,
      instanceIds: "i1",
    });
    const g = await c.updateResource("global-firewall", "acct:global-firewall:global", "acct", {
      rules: "tcp 22 0.0.0.0/0 ssh",
    });
    expect(g.externalId).toBe("global");
    expect(g.fields["sshOpenToInternet"]).toBe(true);
  });
});

describe("create helpers", () => {
  const types = [
    {
      instance_type: {
        name: "a",
        price_cents_per_hour: 100,
        specs: { vcpus: 8, memory_gib: 32, gpus: 1 },
      },
      regions_with_capacity_available: [{ name: "us-east-1" }],
    },
    {
      instance_type: { name: "b", price_cents_per_hour: 200 },
      regions_with_capacity_available: [],
    },
  ];

  it("tags each region with the types that have capacity there", () => {
    const regions = regionOptions([{ name: "us-east-1" }, { name: "us-west-1" }], types);
    expect(regions.map((r) => [r.id, r.availableFor])).toEqual([
      ["us-east-1", ["a"]],
      ["us-west-1", []],
    ]);
  });

  it("prices sizes monthly and marks types without capacity", () => {
    expect(sizeOption(types[0]!)).toMatchObject({
      id: "a",
      vcpus: 8,
      memoryMb: 32768,
      priceMonthly: 730,
    });
    expect(sizeOption(types[1]!).label).toBe("b (no capacity)");
  });

  it("collapses images to one per family, newest version", () => {
    const opts = imageOptions([
      { id: "1", family: "ubuntu", name: "Ubuntu 22.04", version: "1" },
      { id: "2", family: "ubuntu", name: "Ubuntu 22.04", version: "2" },
    ]);
    expect(opts.map((o) => o.id)).toEqual(["default", "ubuntu"]);
  });

  it("parses tags and drops reserved keys", () => {
    expect(parseTags("a=1, b, lambda-ai-x=2")).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "" },
    ]);
  });
});

describe("status feed", () => {
  it("keeps unresolved incidents and lifts regions from titles", () => {
    const body = JSON.stringify({
      page: { id: "p", name: "Lambda", url: "https://status.lambda.ai" },
      incidents: [
        {
          id: "a",
          name: "US-SOUTH-2 Network degradation",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-05T18:00:00Z",
          updated_at: "2026-10-05T18:10:00Z",
          resolved_at: null,
          incident_updates: [],
          components: [{ id: "c", name: "Network" }],
        },
        {
          id: "b",
          name: "Old",
          status: "resolved",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          resolved_at: "2026-10-01T01:00:00Z",
          incident_updates: [],
        },
      ],
    });
    const out = parseStatusFeed(body);
    expect(out.map((i) => i.externalId)).toEqual(["a"]);
    expect(out[0]!.regions).toContain("us-south-2");
    expect(out[0]!.providerWide).toBe(false);
  });

  it("finds region codes in titles", () => {
    expect(regionsInTitle("Maintenance in us-east-1 and US-WEST-3")).toEqual([
      "us-east-1",
      "us-west-3",
    ]);
  });
});
