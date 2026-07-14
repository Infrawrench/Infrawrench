import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { gcpGetCreateConfig, gcpCreateResource } from "../create-handlers.js";
import type { GcpCreateContext } from "../create-context.js";

type CtxOver = Partial<Omit<GcpCreateContext, "get" | "paginate">> & {
  get?: (url: string) => Promise<unknown>;
  paginate?: (baseUrl: string, key: string, params?: Record<string, string>) => Promise<unknown[]>;
};

function ctx(over: CtxOver = {}): GcpCreateContext {
  return {
    get: vi.fn(async () => ({}) as never),
    paginate: vi.fn(async () => []),
    token: vi.fn(async () => "tok"),
    project: "proj",
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
    machineTypeSpecCache: new Map(),
    ...(over as Partial<GcpCreateContext>),
  };
}

let fetchSpy: Mock;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

function ok(body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
}
function err(status = 500, body = "boom"): Response {
  return new Response(body, { status });
}
function bodyOf(i: number): Record<string, unknown> {
  return JSON.parse((fetchSpy.mock.calls[i]![1] as RequestInit).body as string);
}
function lastBody(): Record<string, unknown> {
  return bodyOf(fetchSpy.mock.calls.length - 1);
}

describe("compute-engine create", () => {
  function richCtx() {
    return ctx({
      get: vi.fn(async (url: string) => {
        if (url.includes("/zones/us-central1-a/machineTypes"))
          return {
            items: [
              { name: "e2-medium", guestCpus: 2, memoryMb: 4096 },
              { name: "n2-standard-4", guestCpus: 4, memoryMb: 16384 },
              { name: "custom-2-4096", guestCpus: 2, memoryMb: 4096 },
            ],
          };
        if (url.endsWith("/zones"))
          return {
            items: [
              { name: "us-central1-a", status: "UP", region: "x/us-central1" },
              { name: "down-z", status: "DOWN", region: "x/us-east1" },
            ],
          };
        if (url.includes("/global/images"))
          return { items: [{ name: "img1", selfLink: "sl1", description: "d", status: "READY" }] };
        if (url.includes("/aggregated/disks"))
          return {
            items: {
              "zones/z": {
                disks: [
                  {
                    name: "d1",
                    selfLink: "dsl1",
                    sizeGb: "10",
                    status: "READY",
                    type: "x/pd-ssd",
                    zone: "x/us-central1-a",
                  },
                  {
                    name: "d2",
                    selfLink: "dsl2",
                    sizeGb: "10",
                    status: "CREATING",
                    type: "x/pd-ssd",
                    zone: "x/z",
                  },
                ],
              },
            },
          };
        return {};
      }),
    });
  }

  it("gce-instance config builds zones/sizes/images/disks", async () => {
    const c = richCtx();
    const cfg = await gcpGetCreateConfig(c, "gce-instance");
    const sizes = (cfg.fields.find((f) => f.key === "machineType") as { sizes: unknown[] }).sizes;
    expect(sizes).toHaveLength(2); // custom filtered
    const disks = (cfg.fields.find((f) => f.key === "existingDisk") as { disks: unknown[] }).disks;
    expect(disks).toHaveLength(1); // only READY
    expect(c.machineTypeSpecCache.has("e2-medium")).toBe(true);
  });

  it("gce-instance create new-image + ssh + extra disk + firewall tags", async () => {
    const c = ctx({
      get: vi.fn(async () => ({ targetTags: ["http-server"] })),
    });
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(c, "gce-instance", "acct", {
      name: "vm1",
      zone: "us-central1-a",
      machineType: "e2-medium",
      bootSource: "new-image",
      image: "projects/x/img",
      diskGb: "20",
      sshPublicKey: "ssh-rsa AAAA me@host",
      addExtraDisk: "true",
      extraDiskSizeGb: "200",
      extraDiskType: "pd-ssd",
      tags: "a, b",
      firewall: "fw1",
    });
    const body = lastBody();
    expect((body.disks as unknown[]).length).toBe(2);
    expect((body.tags as { items: string[] }).items.sort()).toEqual(["a", "b", "http-server"]);
    expect(out.fields.sshUsername).toBe("me");
  });

  it("gce-instance create existing-disk + firewall fetch failure tolerated", async () => {
    const c = ctx({
      get: vi.fn(async () => {
        throw new Error("fw not found");
      }),
    });
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(c, "gce-instance", "acct", {
      name: "vm2",
      zone: "z",
      machineType: "e2-medium",
      bootSource: "existing-disk",
      existingDisk: "dsl1",
      firewall: "fw1",
    });
    const boot = (lastBody().disks as Array<{ source?: string }>)[0];
    expect(boot!.source).toBe("dsl1");
  });

  it("gce-instance create fails fast when no zone is given", async () => {
    await expect(
      gcpCreateResource(ctx(), "gce-instance", "acct", { name: "v", machineType: "m" }),
    ).rejects.toThrow(/no zone specified/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gce-instance error", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "gce-instance", "acct", { name: "v", zone: "z", machineType: "m" }),
    ).rejects.toThrow("GCP Compute API 500");
  });

  it("gce-disk config + create + error", async () => {
    const c = ctx({
      get: vi.fn(async () => ({
        items: [{ name: "us-central1-a", status: "UP", region: "x/us-central1" }],
      })),
    });
    expect((await gcpGetCreateConfig(c, "gce-disk")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "gce-disk", "acct", {
      name: "d1",
      zone: "z",
      sizeGb: "100",
      type: "pd-ssd",
    });
    expect(out.fields.sizeGb).toBe(100);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "gce-disk", "acct", {})).rejects.toThrow(
      "GCE Disk API 500",
    );
  });

  it("static-ip config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "static-ip")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "static-ip", "acct", {
      name: "ip1",
      region: "us-central1",
    });
    expect(out.externalId).toBe("us-central1/ip1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "static-ip", "acct", {})).rejects.toThrow(
      "Static IP API 500",
    );
  });

  it("instance-template config + create with ssh/tags + error", async () => {
    const c = richCtx();
    expect((await gcpGetCreateConfig(c, "instance-template")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "instance-template", "acct", {
      name: "tpl1",
      description: "desc",
      machineType: "e2-medium",
      image: "projects/x/family/debian-12",
      diskSizeGb: "20",
      sshPublicKey: "ssh-rsa AAAA me@host",
      tags: "web",
    });
    const props = lastBody().properties as { metadata?: unknown; tags?: { items: string[] } };
    expect(props.metadata).toBeDefined();
    expect(props.tags!.items).toEqual(["web"]);
    expect(out.resolvedOutputs.selfLink).toContain("/instanceTemplates/tpl1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "instance-template", "acct", {})).rejects.toThrow(
      "Instance Template create failed: 500",
    );
  });

  it("instance-group config + create + error", async () => {
    const c = ctx({ get: vi.fn(async () => ({ items: [] })) });
    expect((await gcpGetCreateConfig(c, "instance-group")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "instance-group", "acct", {
      name: "ig1",
      zone: "z",
      instanceTemplate: "https://x/instanceTemplates/tpl1",
      targetSize: "3",
    });
    expect(out.fields.instanceTemplate).toBe("tpl1");
    expect(out.fields.targetSize).toBe(3);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "instance-group", "acct", {})).rejects.toThrow(
      "Instance Group create failed: 500",
    );
  });
});

describe("cloudsql create", () => {
  it("config has version/region fields", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "cloudsql-instance");
    expect(cfg.fields[0]!.key).toBe("name");
    expect(cfg.fields.some((f) => f.key === "databaseVersion")).toBe(true);
  });

  it("creates public-IP instance with authorized networks", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "cloudsql-instance", "acct", {
      name: "db1",
      databaseVersion: "POSTGRES_15",
      region: "us-central1",
      rootPassword: "pw",
      publicIp: "true",
      authorizedNetworks: "1.2.3.4/32",
    });
    const settings = lastBody().settings as {
      ipConfiguration: { ipv4Enabled: boolean; authorizedNetworks?: unknown[] };
    };
    expect(settings.ipConfiguration.ipv4Enabled).toBe(true);
    expect(settings.ipConfiguration.authorizedNetworks).toHaveLength(1);
    expect(out.secretStates[0]!.fieldKey).toBe("rootPassword");
    expect(out.resolvedOutputs.connectionName).toBe("proj:us-central1:db1");
  });

  it("private-IP requires network", async () => {
    await expect(
      gcpCreateResource(ctx(), "cloudsql-instance", "acct", { name: "db", publicIp: "false" }),
    ).rejects.toThrow("a VPC network is required");
  });

  it("private-IP with network sets privateNetwork", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "cloudsql-instance", "acct", {
      name: "db",
      publicIp: "false",
      network: "projects/proj/global/networks/vpc1",
    });
    const settings = lastBody().settings as { ipConfiguration: { privateNetwork?: string } };
    expect(settings.ipConfiguration.privateNetwork).toBe("projects/proj/global/networks/vpc1");
  });

  it("error branch", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "cloudsql-instance", "acct", { name: "db", rootPassword: "p" }),
    ).rejects.toThrow("Cloud SQL API 500");
  });
});

describe("cloud-functions create", () => {
  it("config lists languages + runtimes", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "cloud-function");
    expect(cfg.fields[0]!.key).toBe("name");
    expect(cfg.fields.some((f) => f.key === "runtime_python")).toBe(true);
  });

  it("creates nodejs function (3-step flow)", async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ uploadUrl: "https://upload", storageSource: { bucket: "b" } }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({}));
    const c = ctx({ get: vi.fn(async () => ({ projectNumber: "12345" })) });
    const out = await gcpCreateResource(c, "cloud-function", "acct", {
      name: "fn1",
      region: "us-central1",
      language: "nodejs",
      runtime_nodejs: "nodejs24",
      entryPoint: "helloHttp",
      code_nodejs: "module.exports = {}",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect((fetchSpy.mock.calls[1]![1] as RequestInit).method).toBe("PUT");
    const createBody = bodyOf(2) as {
      buildConfig: { serviceAccount?: string };
      serviceConfig: Record<string, unknown>;
    };
    expect(createBody.buildConfig.serviceAccount).toContain("12345-compute");
    expect(out.fields.runtime).toBe("nodejs24");
  });

  it("python/go/java archives build", async () => {
    for (const lang of ["python", "go", "java"]) {
      fetchSpy.mockReset();
      fetchSpy
        .mockResolvedValueOnce(ok({ uploadUrl: "https://upload", storageSource: {} }))
        .mockResolvedValueOnce(ok({}))
        .mockResolvedValueOnce(ok({}));
      const c = ctx({
        get: vi.fn(async () => {
          throw new Error("no project number");
        }),
      });
      const fields: Record<string, string> = {
        name: "fn",
        region: "us-central1",
        language: lang,
        entryPoint: "h",
      };
      fields[`runtime_${lang}`] =
        lang === "go" ? "go124" : lang === "java" ? "java21" : "python312";
      fields[`code_${lang}`] = "code";
      const out = await gcpCreateResource(c, "cloud-function", "acct", fields);
      expect(out.fields.region).toBe("us-central1");
    }
  });

  it("unsupported language throws", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ uploadUrl: "u", storageSource: {} }));
    await expect(
      gcpCreateResource(ctx(), "cloud-function", "acct", {
        name: "f",
        language: "ruby",
        code_ruby: "x",
      }),
    ).rejects.toThrow('unsupported language "ruby"');
  });

  it("generateUploadUrl error", async () => {
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "cloud-function", "acct", {
        name: "f",
        language: "nodejs",
        code_nodejs: "x",
      }),
    ).rejects.toThrow("generateUploadUrl failed");
  });

  it("upload error", async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ uploadUrl: "u", storageSource: {} }))
      .mockResolvedValueOnce(err());
    await expect(
      gcpCreateResource(ctx(), "cloud-function", "acct", {
        name: "f",
        language: "nodejs",
        code_nodejs: "x",
      }),
    ).rejects.toThrow("source upload failed");
  });

  it("create error", async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({ uploadUrl: "u", storageSource: {} }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(err());
    const c = ctx({ get: vi.fn(async () => ({})) });
    await expect(
      gcpCreateResource(c, "cloud-function", "acct", {
        name: "f",
        language: "nodejs",
        code_nodejs: "x",
      }),
    ).rejects.toThrow("Cloud Functions create failed");
  });
});

describe("networking create", () => {
  it("vpc-network config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "vpc-network")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "vpc-network", "acct", {
      name: "vpc1",
      autoCreateSubnetworks: "false",
    });
    expect(lastBody().autoCreateSubnetworks).toBe(false);
    expect(out.fields.autoCreateSubnetworks).toBe(false);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "vpc-network", "acct", {})).rejects.toThrow(
      "VPC Network API 500",
    );
  });

  it("subnet config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "subnet")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "subnet", "acct", {
      name: "s1",
      region: "us-central1",
      network: "vpc1",
      ipCidrRange: "10.0.0.0/24",
    });
    expect(lastBody().network).toBe("projects/proj/global/networks/vpc1");
    expect(out.externalId).toBe("us-central1/s1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "subnet", "acct", {})).rejects.toThrow("Subnet API 500");
  });

  it("firewall-rule config + create (icmp drops ports) + selfLink network", async () => {
    expect((await gcpGetCreateConfig(ctx(), "firewall-rule")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "firewall-rule", "acct", {
      name: "fw1",
      network: "https://x/networks/vpc1",
      protocol: "icmp",
      ports: "80",
      sourceRanges: "0.0.0.0/0",
    });
    const allowed = (lastBody().allowed as Array<{ ports?: unknown }>)[0];
    expect(allowed!.ports).toBeUndefined(); // icmp drops ports
    expect(out.fields.network).toBe("vpc1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "firewall-rule", "acct", {})).rejects.toThrow(
      "Firewall API 500",
    );
  });

  it("firewall-rule tcp keeps ports + bare network name", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "firewall-rule", "acct", {
      name: "fw2",
      network: "vpc1",
      protocol: "tcp",
      ports: "80, 443",
    });
    const body = lastBody();
    expect(body.network).toBe("projects/proj/global/networks/vpc1");
    expect((body.allowed as Array<{ ports: string[] }>)[0]!.ports).toEqual(["80", "443"]);
  });

  it("cloud-router config + create + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "cloud-router")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "cloud-router", "acct", {
      name: "r1",
      region: "us-central1",
      network: "vpc1",
    });
    expect(out.resolvedOutputs.selfLink).toContain("/routers/r1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "cloud-router", "acct", {})).rejects.toThrow(
      "Cloud Router API 500",
    );
  });

  it("cloud-nat config + create (selfLink router) + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "cloud-nat")).fields[0]!.key).toBe("name");
    const c = ctx({ get: vi.fn(async () => ({ nats: [] })) });
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(c, "cloud-nat", "acct", {
      name: "nat1",
      router: "https://x/projects/proj/regions/us-west1/routers/r1",
    });
    expect(out.fields.region).toBe("us-west1");
    expect(out.fields.router).toBe("r1");
    expect((lastBody().nats as unknown[]).length).toBe(1);
    expect((c.get as Mock).mock.calls[0]![0]).toContain("/regions/us-west1/routers/r1");
    const c2 = ctx({ get: vi.fn(async () => ({})) });
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(c2, "cloud-nat", "acct", { name: "n", router: "r1" }),
    ).rejects.toThrow("Cloud NAT create failed: 500");
  });

  it("ssl-certificate config + create produces dnsRecords + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "ssl-certificate")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "ssl-certificate", "acct", {
      name: "cert1",
      domains: "a.com, b.com",
    });
    expect(out.resolvedOutputs.dnsRecords).toContain("_acme-challenge.a.com.");
    expect(out.fields.domains).toBe("a.com, b.com");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "ssl-certificate", "acct", {})).rejects.toThrow(
      "SSL Certificate create failed: 500",
    );
  });

  it("backend-service config + create with cdn/healthcheck + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "backend-service")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "backend-service", "acct", {
      name: "bs1",
      protocol: "HTTP",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      enableCDN: "true",
      healthCheck: "hc1",
      portName: "http",
    });
    const body = lastBody();
    expect(body.enableCDN).toBe(true);
    expect(body.healthChecks).toEqual(["projects/proj/global/healthChecks/hc1"]);
    expect(out.fields.healthCheckCount).toBe(1);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "backend-service", "acct", {})).rejects.toThrow(
      "Backend Service create failed: 500",
    );
  });

  it("backend-service CDN suppressed for TCP", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "backend-service", "acct", {
      name: "bs2",
      protocol: "TCP",
      loadBalancingScheme: "EXTERNAL",
      enableCDN: "true",
    });
    expect(lastBody().enableCDN).toBeUndefined();
    expect(out.fields.enableCDN).toBe(false);
  });

  it("forwarding-rule config (text when no proxies) + create + error", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "forwarding-rule");
    expect((cfg.fields.find((f) => f.key === "target") as { kind: string }).kind).toBe("text");
    const c = ctx({
      get: vi.fn(async (url: string) =>
        url.includes("HttpProxies") ? { items: [{ name: "hp1", selfLink: "sl" }] } : { items: [] },
      ),
    });
    const cfg2 = await gcpGetCreateConfig(c, "forwarding-rule");
    expect((cfg2.fields.find((f) => f.key === "target") as { kind: string }).kind).toBe("select");
    fetchSpy.mockResolvedValue(ok({}));
    const out = await gcpCreateResource(ctx(), "forwarding-rule", "acct", {
      name: "fr1",
      target: "https://x/targetHttpProxies/hp1",
      IPProtocol: "TCP",
      portRange: "80-80",
    });
    expect(out.fields.target).toBe("hp1");
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "forwarding-rule", "acct", {})).rejects.toThrow(
      "Forwarding Rule create failed: 500",
    );
  });

  it("health-check config + create variants + error", async () => {
    expect((await gcpGetCreateConfig(ctx(), "health-check")).fields[0]!.key).toBe("name");
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "health-check", "acct", {
      name: "hc1",
      type: "HTTPS",
      port: "443",
    });
    expect((lastBody().httpsHealthCheck as { port: number }).port).toBe(443);
    fetchSpy.mockResolvedValue(ok({}));
    await gcpCreateResource(ctx(), "health-check", "acct", {
      name: "hc2",
      type: "TCP",
      port: "22",
    });
    expect((lastBody().tcpHealthCheck as { port: number }).port).toBe(22);
    fetchSpy.mockResolvedValue(err());
    await expect(gcpCreateResource(ctx(), "health-check", "acct", {})).rejects.toThrow(
      "Health Check API 500",
    );
  });
});

describe("cloud-build create", () => {
  it("config builds repo options from connections + CSR", async () => {
    const c = ctx({
      paginate: vi.fn(async (url: string) => {
        if (url.includes("/connections") && !url.includes("/repositories"))
          return [{ name: "projects/proj/locations/us-central1/connections/conn1" }];
        if (url.includes("/repositories"))
          return [
            { name: "projects/proj/locations/us-central1/connections/conn1/repositories/repo1" },
          ];
        if (url.includes("/repos")) return [{ name: "projects/proj/repos/csr1" }];
        return [];
      }),
      get: vi.fn(async () => ({
        repositories: [{ name: "r", remoteUri: "https://github.com/o/x.git" }],
      })),
    });
    const cfg = await gcpGetCreateConfig(c, "cloud-build-trigger");
    expect(cfg.fields[0]!.key).toBe("name");
    const repoField = cfg.fields.find((f) => f.key === "repository");
    expect((repoField as { kind: string }).kind).toBe("select");
  });

  it("config falls back to text repo field with no connections", async () => {
    const cfg = await gcpGetCreateConfig(ctx(), "cloud-build-trigger");
    const repoField = cfg.fields.find((f) => f.key === "repository");
    expect((repoField as { kind: string }).kind).toBe("text");
  });

  it("creates push-branch trigger (2nd gen repo)", async () => {
    fetchSpy.mockResolvedValue(ok({ id: "trig123" }));
    const out = await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t1",
      region: "us-central1",
      eventType: "push-branch",
      repository: "projects/proj/locations/us-central1/connections/c/repositories/r",
      branchPattern: "^main$",
      configType: "yaml",
      configLocation: "repository",
      filename: "cloudbuild.yaml",
    });
    expect(out.externalId).toBe("us-central1/trig123");
    const body = lastBody();
    expect(body.repositoryEventConfig).toBeDefined();
    expect(body.filename).toBe("cloudbuild.yaml");
    expect(fetchSpy.mock.calls[0]![0]).toContain("/locations/us-central1/triggers");
  });

  it("creates CSR push-branch trigger (triggerTemplate, global endpoint)", async () => {
    fetchSpy.mockResolvedValue(ok({ id: "t2" }));
    const out = await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t2",
      region: "global",
      eventType: "push-branch",
      repository: "csr:myrepo",
      branchPattern: ".*",
    });
    expect((lastBody().triggerTemplate as { repoName: string }).repoName).toBe("myrepo");
    expect(fetchSpy.mock.calls[0]![0]).toContain("/projects/proj/triggers");
    expect(out.externalId).toBe("global/t2");
  });

  it("inline yaml build config + service account injects logging", async () => {
    fetchSpy.mockResolvedValue(ok({ id: "t3" }));
    await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t3",
      eventType: "push-branch",
      repository: "projects/proj/locations/us/connections/c/repositories/r",
      configType: "yaml",
      configLocation: "inline",
      inlineConfig: "steps:\n  - name: busybox\n",
      serviceAccount: "sa@proj.iam.gserviceaccount.com",
    });
    const build = lastBody().build as { options: { logging: string }; steps: unknown[] };
    expect(build.options.logging).toBe("CLOUD_LOGGING_ONLY");
  });

  it("dockerfile + substitutions + approval", async () => {
    fetchSpy.mockResolvedValue(ok({ id: "t4" }));
    await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t4",
      eventType: "push-tag",
      repository: "projects/proj/locations/us/connections/c/repositories/r",
      tagPattern: "^v",
      configType: "dockerfile",
      dockerfileImage: "gcr.io/p/img",
      substitutions: JSON.stringify([{ key: "_FOO", value: "bar" }]),
      requireApproval: "yes",
    });
    const body = lastBody();
    expect((body.build as { images: string[] }).images).toEqual(["gcr.io/p/img"]);
    expect(body.substitutions).toEqual({ _FOO: "bar" });
    expect((body.approvalConfig as { approvalRequired: boolean }).approvalRequired).toBe(true);
  });

  it("buildpacks config", async () => {
    fetchSpy.mockResolvedValue(ok({ id: "t5" }));
    await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t5",
      eventType: "pull-request",
      repository: "projects/proj/locations/us/connections/c/repositories/r",
      configType: "buildpacks",
      buildpacksImage: "gcr.io/p/bp",
    });
    expect(
      (lastBody().build as { steps: Array<{ entrypoint: string }> }).steps[0]!.entrypoint,
    ).toBe("pack");
  });

  it("pubsub + webhook + manual triggers need repository", async () => {
    await expect(
      gcpCreateResource(ctx(), "cloud-build-trigger", "acct", { name: "t", eventType: "pubsub" }),
    ).rejects.toThrow("Pub/Sub topic is required");
    await expect(
      gcpCreateResource(ctx(), "cloud-build-trigger", "acct", { name: "t", eventType: "manual" }),
    ).rejects.toThrow("need a source repository");
  });

  it("creates pubsub trigger with topic + gitFileSource", async () => {
    fetchSpy.mockResolvedValue(ok({ id: "t6" }));
    await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t6",
      eventType: "pubsub",
      pubsubTopic: "mytopic",
      repository: "projects/proj/locations/us/connections/c/repositories/r",
      filename: "cloudbuild.yaml",
    });
    const body = lastBody();
    expect((body.pubsubConfig as { topic: string }).topic).toBe("projects/proj/topics/mytopic");
    expect(body.gitFileSource).toBeDefined();
  });

  it("link: repository auto-links first", async () => {
    fetchSpy
      .mockResolvedValueOnce(ok({})) // link
      .mockResolvedValueOnce(ok({ id: "t7" })); // create
    await gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
      name: "t7",
      eventType: "push-branch",
      repository: "link:projects/proj/locations/us/connections/c|https://github.com/o/x.git",
      branchPattern: "^main$",
    });
    expect(fetchSpy.mock.calls[0]![0]).toContain("/repositories?repositoryId=");
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  it("malformed link + connection-only path + create error", async () => {
    await expect(
      gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
        name: "t",
        eventType: "push-branch",
        repository: "link:bad",
      }),
    ).rejects.toThrow("Malformed link option");
    await expect(
      gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
        name: "t",
        eventType: "push-branch",
        repository: "projects/proj/locations/us/connections/c",
      }),
    ).rejects.toThrow("is a connection path");
    fetchSpy.mockResolvedValue(err());
    await expect(
      gcpCreateResource(ctx(), "cloud-build-trigger", "acct", {
        name: "t",
        eventType: "push-branch",
        repository: "projects/proj/locations/us/connections/c/repositories/r",
      }),
    ).rejects.toThrow("Cloud Build Trigger create failed");
  });
});
