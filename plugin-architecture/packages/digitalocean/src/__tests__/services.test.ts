import { describe, it, expect, vi, afterEach } from "vitest";
import { DigitalOceanClient } from "../client.js";
import { loadBalancerPutBody } from "../service-ops.js";
import { buildInboundRules } from "../create-handlers/services.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

type Call = { path: string; method: string; body: unknown };

function installFetch(route: (path: string, method: string) => unknown | undefined) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("https://api.digitalocean.com/v2", "");
    const method = init?.method ?? "GET";
    const raw = init?.body as string | undefined;
    calls.push({ path, method, body: raw ? JSON.parse(raw) : undefined });
    const result = route(path, method);
    if (result === undefined) return jsonResponse({}, 404);
    if (typeof result === "string") return jsonResponse(result);
    return jsonResponse(result);
  }) as typeof fetch);
  return calls;
}

const ACC = "acc1";
const client = () => new DigitalOceanClient({ apiToken: "tok" });

afterEach(() => vi.restoreAllMocks());

const LB = {
  id: "lb-1",
  name: "web",
  ip: "1.2.3.4",
  ipv6: "",
  size_unit: 2,
  size: "lb-small",
  algorithm: "round_robin",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  region: { slug: "nyc3", name: "New York 3" },
  type: "REGIONAL",
  network: "EXTERNAL",
  forwarding_rules: [
    { entry_protocol: "https", entry_port: 443, target_protocol: "http", target_port: 80 },
  ],
  health_check: { protocol: "http", port: 80, path: "/" },
  droplet_ids: [11, 12],
  tag: "",
  vpc_uuid: "vpc-1",
  project_id: "p-1",
  redirect_http_to_https: false,
};

describe("service listers", () => {
  it("maps load balancers with rules, targets, outputs and project parent", async () => {
    installFetch((p) => (p.startsWith("/load_balancers") ? { load_balancers: [LB] } : undefined));
    const [lb] = await client().listResources("load-balancer", ACC);
    expect(lb!.externalId).toBe("lb-1");
    expect(lb!.parentResourceId).toBe(`${ACC}:project:p-1`);
    expect(lb!.fields).toMatchObject({
      region: "nyc3",
      sizeUnit: 2,
      dropletIds: "11,12",
      dropletTag: "",
      lbType: "REGIONAL",
      forwardingRules: "https:443 → http:80",
    });
    expect(lb!.resolvedOutputs["ip"]).toBe("1.2.3.4");
    expect(lb!.resolvedOutputs["ipv6"]).toBeUndefined();
  });

  it("maps firewalls, NAT gateways, peerings, certificates and CDN endpoints", async () => {
    installFetch((p) => {
      if (p.startsWith("/firewalls"))
        return {
          firewalls: [
            {
              id: "fw-1",
              name: "ssh",
              status: "succeeded",
              droplet_ids: [11],
              tags: [],
              inbound_rules: [
                { protocol: "tcp", ports: "22", sources: { addresses: ["0.0.0.0/0"] } },
              ],
              outbound_rules: [],
            },
          ],
        };
      if (p.startsWith("/vpc_nat_gateways"))
        return {
          vpc_nat_gateways: [
            {
              id: "nat-1",
              name: "egress",
              region: "tor1",
              state: "ACTIVE",
              size: 2,
              vpcs: [{ vpc_uuid: "vpc-1", gateway_ip: "10.0.0.1" }],
              egresses: { public_gateways: [{ ipv4: "5.6.7.8" }] },
            },
          ],
        };
      if (p.startsWith("/vpc_peerings"))
        return { vpc_peerings: [{ id: "pe-1", name: "a-b", vpc_ids: ["vpc-1", "vpc-2"] }] };
      if (p.startsWith("/certificates"))
        return {
          certificates: [
            {
              id: "c-1",
              name: "site",
              type: "lets_encrypt",
              state: "verified",
              dns_names: ["example.com", "www.example.com"],
              not_after: "2027-01-01T00:00:00Z",
            },
          ],
        };
      if (p.startsWith("/cdn/endpoints"))
        return {
          endpoints: [
            {
              id: "cdn-1",
              origin: "b.nyc3.digitaloceanspaces.com",
              endpoint: "b.nyc3.cdn.digitaloceanspaces.com",
              ttl: 600,
            },
          ],
        };
      return undefined;
    });
    const c = client();
    const [fw] = await c.listResources("firewall", ACC);
    expect(fw!.fields).toMatchObject({ dropletIds: "11", tags: "", inboundRuleCount: 1 });
    const [nat] = await c.listResources("vpc-nat-gateway", ACC);
    expect(nat!.fields).toMatchObject({ vpcUuids: "vpc-1", egressIp: "5.6.7.8", size: 2 });
    expect(nat!.resolvedOutputs["egressIp"]).toBe("5.6.7.8");
    const [pe] = await c.listResources("vpc-peering", ACC);
    expect(pe!.fields["vpcIds"]).toBe("vpc-1,vpc-2");
    const [cert] = await c.listResources("certificate", ACC);
    expect(cert!.fields).toMatchObject({
      dnsNames: "example.com,www.example.com",
      notAfter: "2027-01-01T00:00:00Z",
    });
    const [cdn] = await c.listResources("cdn-endpoint", ACC);
    expect(cdn!.fields["ttl"]).toBe("600");
    expect(cdn!.resolvedOutputs["url"]).toBe("https://b.nyc3.cdn.digitaloceanspaces.com");
  });

  it("collapses a 403 on newer products to an empty list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "forbidden" }, 403));
    expect(await client().listResources("autoscale-pool", ACC)).toEqual([]);
  });

  it("maps App Platform apps with components and phase", async () => {
    installFetch((p) =>
      p.startsWith("/apps?")
        ? {
            apps: [
              {
                id: "app-1",
                spec: {
                  name: "shop",
                  services: [{ name: "api" }],
                  static_sites: [{ name: "web" }],
                },
                region: { slug: "ams" },
                active_deployment: { id: "d-1", phase: "ACTIVE" },
                live_url: "https://shop.ondigitalocean.app",
                project_id: "p-1",
              },
            ],
          }
        : undefined,
    );
    const [app] = await client().listResources("app", ACC);
    expect(app!.fields).toMatchObject({
      name: "shop",
      components: "api,web",
      phase: "ACTIVE",
      activeDeploymentId: "d-1",
    });
    expect(app!.parentResourceId).toBe(`${ACC}:project:p-1`);
  });
});

describe("service create", () => {
  it("creates a load balancer by Droplet ids with a TLS rule", async () => {
    const calls = installFetch((p, m) =>
      p === "/load_balancers" && m === "POST" ? { load_balancer: LB } : undefined,
    );
    await client().createResource("load-balancer", ACC, {
      name: "web",
      region: "nyc3",
      lbType: "REGIONAL",
      network: "EXTERNAL",
      sizeUnit: "2",
      targetMode: "droplets",
      dropletIds: JSON.stringify(["11", "12"]),
      entryProtocol: "https",
      entryPort: "443",
      targetProtocol: "http",
      targetPort: "80",
      certificateId: "c-1",
      healthCheckProtocol: "tcp",
      healthCheckPort: "80",
    });
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      size_unit: 2,
      droplet_ids: [11, 12],
      forwarding_rules: [{ entry_protocol: "https", certificate_id: "c-1", target_port: 80 }],
      health_check: { protocol: "tcp", port: 80 },
    });
    expect(body).not.toHaveProperty("tag");
    expect((body["health_check"] as Record<string, unknown>)["path"]).toBeUndefined();
  });

  it("refuses an HTTPS load balancer without a certificate", async () => {
    installFetch(() => undefined);
    await expect(
      client().createResource("load-balancer", ACC, {
        name: "web",
        region: "nyc3",
        entryProtocol: "https",
      }),
    ).rejects.toThrow(/certificate/);
  });

  it("builds firewall rules from the key-value rows", () => {
    const rules = buildInboundRules(
      JSON.stringify([
        { ports: "22", protocol: "tcp" },
        { ports: "", protocol: "udp" },
        { ports: "99", protocol: "icmp" },
      ]),
      "10.0.0.0/8",
    );
    expect(rules).toEqual([
      { protocol: "tcp", ports: "22", sources: { addresses: ["10.0.0.0/8"] } },
      { protocol: "udp", ports: "0", sources: { addresses: ["10.0.0.0/8"] } },
      { protocol: "icmp", ports: "0", sources: { addresses: ["10.0.0.0/8"] } },
    ]);
  });

  it("creates a Let's Encrypt certificate covering the picked domain's subdomains", async () => {
    const calls = installFetch((p) =>
      p === "/certificates" ? { certificate: { id: "c-1", name: "site" } } : undefined,
    );
    await client().createResource("certificate", ACC, {
      name: "site",
      type: "lets_encrypt",
      domain: "example.com",
      subdomains: "www,*,api.example.com",
    });
    expect(calls[0]!.body).toEqual({
      name: "site",
      type: "lets_encrypt",
      dns_names: ["example.com", "www.example.com", "*.example.com", "api.example.com"],
    });
  });

  it("creates a NAT gateway and a VPC peering", async () => {
    const calls = installFetch((p) => {
      if (p === "/vpc_nat_gateways") return { vpc_nat_gateway: { id: "nat-1" } };
      if (p === "/vpc_peerings") return { vpc_peering: { id: "pe-1" } };
      return undefined;
    });
    const c = client();
    await c.createResource("vpc-nat-gateway", ACC, {
      name: "egress",
      region: "tor1",
      vpcUuid: "vpc-1",
      defaultGateway: "true",
      size: "2",
    });
    expect(calls[0]!.body).toMatchObject({
      type: "PUBLIC",
      size: 2,
      vpcs: [{ vpc_uuid: "vpc-1", default_gateway: true }],
      tcp_timeout_seconds: 30,
    });
    await expect(
      c.createResource("vpc-peering", ACC, { name: "x", vpcA: "vpc-1", vpcB: "vpc-1" }),
    ).rejects.toThrow(/two different/);
    await c.createResource("vpc-peering", ACC, { name: "x", vpcA: "vpc-1", vpcB: "vpc-2" });
    expect(calls.at(-1)!.body).toEqual({ name: "x", vpc_ids: ["vpc-1", "vpc-2"] });
  });

  it("offers pickers, not id inputs, on the load balancer form", async () => {
    installFetch((p) => {
      if (p === "/regions") return { regions: [{ slug: "nyc3", name: "NYC 3", available: true }] };
      if (p.startsWith("/droplets"))
        return { droplets: [{ id: 11, name: "web-1", region: { slug: "nyc3" } }] };
      if (p.startsWith("/certificates")) return { certificates: [{ id: "c-1", name: "site" }] };
      if (p.startsWith("/tags")) return { tags: [{ name: "web" }] };
      if (p.startsWith("/vpcs")) return { vpcs: [] };
      if (p === "/projects") return { projects: [] };
      return undefined;
    });
    const cfg = await client().getCreateConfig("load-balancer");
    const byKey = new Map(cfg.fields.map((f) => [f.key, f]));
    expect(byKey.get("dropletIds")?.kind).toBe("policy-picker");
    expect(byKey.get("dropletIds")?.policies?.[0]?.label).toBe("web-1 (nyc3)");
    expect(byKey.get("certificateId")?.options?.[0]?.id).toBe("c-1");
    expect(byKey.get("tag")?.options?.[0]?.id).toBe("web");
  });
});

describe("service update", () => {
  it("echoes the full load balancer back with the edited keys", async () => {
    const calls = installFetch((p, m) => {
      if (p === "/load_balancers/lb-1" && m === "GET") return { load_balancer: LB };
      if (p === "/load_balancers/lb-1" && m === "PUT")
        return { load_balancer: { ...LB, size_unit: 3 } };
      return undefined;
    });
    const r = await client().updateResource("load-balancer", `${ACC}:load-balancer:lb-1`, ACC, {
      sizeUnit: "3",
    });
    expect(r.fields["sizeUnit"]).toBe(3);
    const body = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ size_unit: 3, region: "nyc3", droplet_ids: [11, 12] });
    for (const k of ["id", "ip", "status", "created_at", "size", "algorithm", "tag"]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it("keeps the tag and drops droplet_ids for tag-targeted load balancers", () => {
    const body = loadBalancerPutBody({ ...LB, tag: "web", droplet_ids: [11] });
    expect(body["tag"]).toBe("web");
    expect(body).not.toHaveProperty("droplet_ids");
  });

  it("converts autoscale targets from percent to fractions", async () => {
    const pool = {
      id: "as-1",
      name: "workers",
      config: { min_instances: 1, max_instances: 5, target_cpu_utilization: 0.6 },
      droplet_template: { region: "nyc3", size: "s-1vcpu-1gb", image: "ubuntu", ssh_keys: ["1"] },
      active_resources_count: 2,
    };
    const calls = installFetch((p, m) => {
      if (p === "/droplets/autoscale/as-1" && m === "GET") return { autoscale_pool: pool };
      if (p === "/droplets/autoscale/as-1" && m === "PUT") return { autoscale_pool: pool };
      return undefined;
    });
    await client().updateResource("autoscale-pool", `${ACC}:autoscale-pool:as-1`, ACC, {
      maxInstances: "8",
      targetCpuUtilization: "75",
    });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      name: "workers",
      config: { min_instances: 1, max_instances: 8, target_cpu_utilization: 0.75 },
      droplet_template: pool.droplet_template,
    });
  });

  it("rejects out-of-range NAT gateway sizes before calling DO", async () => {
    const calls = installFetch((p) =>
      p === "/vpc_nat_gateways/nat-1" ? { vpc_nat_gateway: { id: "nat-1", vpcs: [] } } : undefined,
    );
    await expect(
      client().updateResource("vpc-nat-gateway", `${ACC}:vpc-nat-gateway:nat-1`, ACC, {
        size: "9",
      }),
    ).rejects.toThrow(/between 1 and 5/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("validates uptime regions", async () => {
    installFetch((p) =>
      p === "/uptime/checks/u-1" ? { check: { id: "u-1", regions: ["us_east"] } } : undefined,
    );
    await expect(
      client().updateResource("uptime-check", `${ACC}:uptime-check:u-1`, ACC, {
        regions: "us_east,mars",
      }),
    ).rejects.toThrow(/mars/);
  });
});

describe("service commands, actions and delete", () => {
  it("adds and removes firewall rules through the rules endpoint", async () => {
    const calls = installFetch((p) => (p === "/firewalls/fw-1/rules" ? {} : undefined));
    const c = client();
    const id = `${ACC}:firewall:fw-1`;
    await c.executeNoSqlCommand("firewall", id, ACC, "fw-add-rule", [
      JSON.stringify({ direction: "inbound", action: "deny", protocol: "tcp", ports: "3306" }),
    ]);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        inbound_rules: [
          {
            protocol: "tcp",
            ports: "3306",
            action: "deny",
            sources: { addresses: ["0.0.0.0/0", "::/0"] },
          },
        ],
      },
    });
    const rule = { protocol: "icmp", ports: "0", destinations: { addresses: ["0.0.0.0/0"] } };
    await c.executeNoSqlCommand("firewall", id, ACC, "fw-remove-rule", [
      JSON.stringify({ rule: `outbound:${JSON.stringify(rule)}` }),
    ]);
    expect(calls[1]).toMatchObject({ method: "DELETE", body: { outbound_rules: [rule] } });
  });

  it("adds Droplets to a load balancer and purges a CDN path", async () => {
    const calls = installFetch(() => ({}));
    const c = client();
    await c.executeNoSqlCommand(
      "load-balancer",
      `${ACC}:load-balancer:lb-1`,
      ACC,
      "lb-add-droplets",
      [JSON.stringify({ dropletIds: JSON.stringify(["13"]) })],
    );
    expect(calls[0]).toMatchObject({
      path: "/load_balancers/lb-1/droplets",
      method: "POST",
      body: { droplet_ids: [13] },
    });
    await c.executeNoSqlCommand("cdn-endpoint", `${ACC}:cdn-endpoint:cdn-1`, ACC, "cdn-purge", [
      JSON.stringify({ files: "" }),
    ]);
    expect(calls[1]).toMatchObject({
      path: "/cdn/endpoints/cdn-1/cache",
      method: "DELETE",
      body: { files: ["*"] },
    });
  });

  it("deploys, rolls back and deletes apps", async () => {
    const calls = installFetch(() => ({}));
    const c = client();
    const id = `${ACC}:app:app-1`;
    await c.invokeAction("app", id, "app-force-rebuild", ACC);
    expect(calls[0]).toMatchObject({
      path: "/apps/app-1/deployments",
      body: { force_build: true },
    });
    await c.executeNoSqlCommand("app", id, ACC, "app-rollback", [
      JSON.stringify({ deploymentId: "d-0" }),
    ]);
    expect(calls[1]).toMatchObject({
      path: "/apps/app-1/rollback",
      body: { deployment_id: "d-0", skip_pin: true },
    });
    await c.deleteResource("app", id, ACC);
    expect(calls[2]).toMatchObject({ path: "/apps/app-1", method: "DELETE" });
  });

  it("deletes an autoscale pool with its Droplets via the dangerous endpoint", async () => {
    const seen: Array<{ url: string; headers: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seen.push({ url: String(input), headers: init?.headers });
      return jsonResponse({}, 202);
    }) as typeof fetch);
    await client().invokeAction(
      "autoscale-pool",
      `${ACC}:autoscale-pool:as-1`,
      "autoscale-delete-with-droplets",
      ACC,
    );
    expect(seen[0]!.url).toBe("https://api.digitalocean.com/v2/droplets/autoscale/as-1/dangerous");
    expect(JSON.stringify(seen[0]!.headers)).toContain("X-Dangerous");
  });
});

describe("app logs, spec and metrics", () => {
  it("tails the archived log URLs for the picked log type", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/apps/app-1/logs?type=BUILD"))
        return jsonResponse({ historic_urls: ["https://logs.example/build.log"], live_url: "" });
      if (url === "https://logs.example/build.log") return jsonResponse("step 1\nstep 2\nstep 3\n");
      return jsonResponse({}, 404);
    }) as typeof fetch);
    const logs = await client().getLogs("app", `${ACC}:app:app-1`, ACC, {
      tailLines: 2,
      container: "BUILD",
    });
    expect(logs.activeContainer).toBe("BUILD");
    expect(logs.containers).toContain("RUN");
    expect(logs.text).toBe("step 2\nstep 3\n");
  });

  it("round-trips the app spec through the manifest editor", async () => {
    const calls = installFetch((p) =>
      p === "/apps/app-1" ? { app: { spec: { name: "shop" } } } : undefined,
    );
    const c = client();
    expect(JSON.parse(await c.getManifest(`${ACC}:app:app-1`, ACC))).toEqual({ name: "shop" });
    await c.applyManifest(`${ACC}:app:app-1`, ACC, '{"name":"shop2"}');
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { spec: { name: "shop2" } } });
    await expect(c.applyManifest(`${ACC}:app:app-1`, ACC, "not json")).rejects.toThrow(/JSON/);
  });

  it("splits multi-series load balancer metrics by their varying label", async () => {
    installFetch((p) => {
      if (p.startsWith("/monitoring/metrics/load_balancer/frontend_http_responses"))
        return {
          data: {
            result: [
              { metric: { lb_id: "lb-1", code: "2xx" }, values: [[1, "5"]] },
              { metric: { lb_id: "lb-1", code: "5xx" }, values: [[1, "1"]] },
            ],
          },
        };
      if (p.startsWith("/monitoring/metrics/load_balancer/frontend_cpu_utilization"))
        return { data: { result: [{ metric: {}, values: [[1, "12"]] }] } };
      return undefined;
    });
    const series = await client().fetchMetricSeries(
      "load-balancer",
      `${ACC}:load-balancer:lb-1`,
      ACC,
      {
        startMs: 0,
        endMs: 1000,
      },
    );
    expect(series.map((s) => s.label).sort()).toEqual([
      "LB CPU",
      "Responses (2xx)",
      "Responses (5xx)",
    ]);
  });
});

describe("service detail rendering", () => {
  it("renders the app detail with logs, spec editor and rollback picker", () => {
    const c = client();
    const detail = c.renderDetail({
      id: `${ACC}:app:app-1`,
      pluginId: "digitalocean",
      resourceTypeId: "app",
      accountId: ACC,
      displayName: "shop",
      fields: { name: "shop", components: "api", activeDeploymentId: "d-2", phase: "ACTIVE" },
      resolvedOutputs: {
        __deployments__: JSON.stringify([
          { id: "d-2", phase: "ACTIVE", createdAt: "2026-09-02T10:00:00Z" },
          { id: "d-1", phase: "SUPERSEDED", createdAt: "2026-09-01T10:00:00Z" },
        ]),
      },
      secretStates: [],
      externalId: "app-1",
      createdAt: "",
      updatedAt: "",
    });
    expect(detail.logs).toBeDefined();
    expect(detail.manifestEditor?.language).toBe("json");
    const rollback = detail.headerActions?.find((a) => a.label === "Roll back…");
    const act = rollback?.action as { fields?: Array<{ options?: Array<{ id: string }> }> };
    expect(act.fields?.[0]?.options?.map((o) => o.id)).toEqual(["d-1"]);
  });
});
