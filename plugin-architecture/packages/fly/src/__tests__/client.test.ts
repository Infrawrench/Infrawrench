import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlyClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch);
}

function router(routes: Array<[(url: string, init?: RequestInit) => boolean, unknown, number?]>) {
  return installFetch((url, init) => {
    for (const [pred, body, status] of routes) {
      if (pred(url, init)) return jsonResponse(body, status ?? 200);
    }
    throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
  });
}

const method = (i?: RequestInit) => i?.method ?? "GET";

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

const resourceTypes = plugin.resourceTypes;

function client(creds: Record<string, string> = { apiToken: "tok" }, services?: unknown) {
  return new FlyClient(creds, resourceTypes, services as never);
}

const APP_LIST = {
  apps: [
    { id: "a1", name: "app-one", machine_count: 2, volume_count: 1, network: "default" },
    { id: "a2", name: "app-two", machine_count: 0, volume_count: 0 },
  ],
  total_apps: 2,
};

const MACHINE = {
  id: "m1",
  name: "machine-one",
  state: "started",
  region: "iad",
  instance_id: "inst1",
  private_ip: "fdaa::1",
  config: { image: "nginx:latest" },
  created_at: "2024-01-01",
  updated_at: "2024-01-02",
};

const VOLUME = {
  id: "v1",
  name: "data",
  state: "created",
  size_gb: 10,
  region: "iad",
  encrypted: true,
  attached_machine_id: "",
  created_at: "2024-01-01",
};

describe("constructor", () => {
  it("throws without apiToken", () => {
    expect(() => new FlyClient({})).toThrow(/missing apiToken/);
  });

  it("defaults orgSlug to personal and sends auth header", async () => {
    router([[(u) => u.includes("/v1/apps"), APP_LIST]]);
    await client().listResources("app", ACCOUNT);
    expect(calls[0]!.url).toBe("https://api.machines.dev/v1/apps?org_slug=personal");
    const h = calls[0]!.init?.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Bearer tok");
  });

  it("uses provided orgSlug", async () => {
    router([[(u) => u.includes("/v1/apps"), APP_LIST]]);
    await client({ apiToken: "tok", orgSlug: "my-org" }).listResources("app", ACCOUNT);
    expect(calls[0]!.url).toContain("org_slug=my-org");
  });

  it("routes through host http when caCert + services.http", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify(APP_LIST) }));
    const spy = installFetch(() => jsonResponse({}));
    await client({ apiToken: "tok", caCert: "PEM" }, { http: { request } }).listResources(
      "app",
      ACCOUNT,
    );
    expect(
      ((request.mock.calls as unknown as Array<[unknown]>)[0]![0] as { caCert?: string }).caCert,
    ).toBe("PEM");
    expect(spy).not.toHaveBeenCalled();
  });

  it("routes through host http when services.http is available", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify(APP_LIST) }));
    const spy = installFetch(() => jsonResponse({}));
    await client({ apiToken: "tok" }, { http: { request } }).listResources("app", ACCOUNT);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.machines.dev/v1/apps?org_slug=personal",
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("listResources", () => {
  it("lists apps, defaulting a missing status to deployed", async () => {
    router([[(u) => u.includes("/v1/apps?"), APP_LIST]]);
    const res = await client().listResources("app", ACCOUNT);
    expect(res).toHaveLength(2);
    expect(res[0]!.id).toBe("acct-1:app:app-one");
    expect(res[0]!.fields["status"]).toBe("deployed");
    expect(res[0]!.fields["machineCount"]).toBe(2);
    expect(res[0]!.resolvedOutputs["appName"]).toBe("app-one");
  });

  it("handles missing apps array", async () => {
    router([[(u) => u.includes("/v1/apps"), {}]]);
    const res = await client().listResources("app", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("lists machines across apps, skipping failures", async () => {
    router([
      [(u) => u.includes("/v1/apps?"), APP_LIST],
      [(u) => u.includes("/v1/apps/app-one/machines"), [MACHINE]],
      [(u) => u.includes("/v1/apps/app-two/machines"), "boom", 500],
    ]);
    const res = await client().listResources("machine", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:machine:app-one/m1");
    expect(res[0]!.fields["image"]).toBe("nginx:latest");
    expect(res[0]!.resolvedOutputs["privateIp"]).toBe("fdaa::1");
  });

  it("machine maps image from image_ref fallback and null machines", async () => {
    router([
      [(u) => u.includes("/v1/apps?"), { apps: [{ id: "a1", name: "app-one" }], total_apps: 1 }],
      [
        (u) => u.includes("/machines"),
        [
          {
            id: "m2",
            name: "",
            state: "stopped",
            region: "lhr",
            image_ref: { repository: "repo/img" },
          },
        ],
      ],
    ]);
    const res = await client().listResources("machine", ACCOUNT);
    expect(res[0]!.displayName).toBe("m2");
    expect(res[0]!.fields["image"]).toBe("repo/img");
  });

  it("lists volumes across apps, skipping failures", async () => {
    router([
      [(u) => u.includes("/v1/apps?"), APP_LIST],
      [(u) => u.includes("/v1/apps/app-one/volumes"), [VOLUME]],
      [(u) => u.includes("/v1/apps/app-two/volumes"), "boom", 500],
    ]);
    const res = await client().listResources("volume", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:volume:app-one/v1");
    expect(res[0]!.fields["sizeGb"]).toBe(10);
  });

  it("lists certificates from Fly's response envelope", async () => {
    router([
      [(u) => u.includes("/v1/apps?"), { apps: [{ id: "a1", name: "app-one" }], total_apps: 1 }],
      [
        (u) => u.includes("/v1/apps/app-one/certificates"),
        {
          certificates: [
            {
              hostname: "example.com",
              configured: true,
              acme_dns_configured: true,
              dns_provider: "flydns",
            },
          ],
        },
      ],
    ]);
    const res = await client().listResources("certificate", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:certificate:app-one/example.com");
    expect(res[0]!.fields["configured"]).toBe(true);
    expect(res[0]!.fields["dnsProvider"]).toBe("flydns");
  });

  it("throws on unknown type", async () => {
    await expect(client().listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("getResource", () => {
  it("fetches an app directly", async () => {
    router([
      [
        (u) => u.includes("/v1/apps/app-one"),
        {
          id: "a1",
          name: "app-one",
          status: "deployed",
          organization: { name: "Org", slug: "org" },
          machine_count: 2,
          volume_count: 1,
          network: "default",
          created_at: "2024",
        },
      ],
    ]);
    const r = await client().getResource("app", "acct-1:app:app-one", ACCOUNT);
    expect(r.fields["organization"]).toBe("org");
    expect(r.fields["status"]).toBe("deployed");
  });

  it("app maps defaults when fields missing", async () => {
    router([[(u) => u.includes("/v1/apps/x"), { id: "a", name: "x", status: undefined }]]);
    const r = await client().getResource("app", "acct-1:app:x", ACCOUNT);
    expect(r.fields["status"]).toBe("pending");
    expect(r.fields["organization"]).toBe("");
  });

  it("throws when app name cannot be parsed", async () => {
    await expect(client().getResource("app", "", ACCOUNT)).rejects.toThrow(/Cannot parse app name/);
  });

  it("fetches a machine directly", async () => {
    router([[(u) => u.includes("/v1/apps/app-one/machines/m1"), MACHINE]]);
    const r = await client().getResource("machine", "acct-1:machine:app-one/m1", ACCOUNT);
    expect(r.externalId).toBe("app-one/m1");
  });

  it("fetches a volume directly", async () => {
    router([[(u) => u.includes("/v1/apps/app-one/volumes/v1"), VOLUME]]);
    const r = await client().getResource("volume", "acct-1:volume:app-one/v1", ACCOUNT);
    expect(r.externalId).toBe("app-one/v1");
  });

  it("throws on unparseable machine id", async () => {
    await expect(
      client().getResource("machine", "acct-1:machine:noslash", ACCOUNT),
    ).rejects.toThrow(/Cannot parse machine resource ID/);
  });

  it("throws on unparseable volume id", async () => {
    await expect(client().getResource("volume", "acct-1:volume:noslash", ACCOUNT)).rejects.toThrow(
      /Cannot parse volume resource ID/,
    );
  });

  it("throws on unknown type", async () => {
    await expect(client().getResource("nope", "acct-1:nope:x", ACCOUNT)).rejects.toThrow(
      /unknown resource type/,
    );
  });
});

describe("resolveOutput", () => {
  it("machine privateIp", async () => {
    router([[(u) => u.includes("/machines/m1"), MACHINE]]);
    expect(
      await client().resolveOutput("machine", "acct-1:machine:app-one/m1", "privateIp", ACCOUNT),
    ).toBe("fdaa::1");
  });

  it("machine unknown output throws", async () => {
    router([[(u) => u.includes("/machines/m1"), MACHINE]]);
    await expect(
      client().resolveOutput("machine", "acct-1:machine:app-one/m1", "bogus", ACCOUNT),
    ).rejects.toThrow(/unknown output/);
  });

  it("app appName (no fetch)", async () => {
    expect(await client().resolveOutput("app", "acct-1:app:my-app", "appName", ACCOUNT)).toBe(
      "my-app",
    );
  });

  it("throws for unknown type/output", async () => {
    await expect(
      client().resolveOutput("volume", "acct-1:volume:a/v", "x", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("getCreateConfig", () => {
  it("app config", async () => {
    const cfg = await client().getCreateConfig("app");
    expect(cfg.fields[0]!.key).toBe("name");
    expect(cfg.fields.find((f) => f.key === "network")?.required).toBe(false);
  });

  it("machine config without parent has app picker + regions", async () => {
    router([[(u) => u.includes("/v1/platform/regions"), "boom", 500]]);
    const cfg = await client().getCreateConfig("machine");
    expect(cfg.fields[0]!.key).toBe("appName");
    const region = cfg.fields.find((f) => f.key === "region");
    expect(region?.kind).toBe("region-picker");
    expect((region as { regions?: unknown[] }).regions?.length).toBeGreaterThan(10);
  });

  it("machine config with parent omits app picker", async () => {
    router([[(u) => u.includes("/v1/platform/regions"), "boom", 500]]);
    const cfg = await client().getCreateConfig("machine", "acct-1:app:app-one");
    expect(cfg.fields.find((f) => f.key === "appName")).toBeUndefined();
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("volume config without parent uses an app resource picker", async () => {
    router([[(u) => u.includes("/v1/platform/regions"), { regions: [] }]]);
    const cfg = await client().getCreateConfig("volume");
    const app = cfg.fields.find((f) => f.key === "appName");
    expect(app?.kind).toBe("resource-picker");
    expect(app?.associationSources).toEqual([
      { pluginId: "fly", resourceTypeId: "app", outputKey: "appName" },
    ]);
    expect(cfg.fields.map((f) => f.key)).toContain("snapshotRetention");
  });

  it("region pickers use the live platform list and drop deprecated regions", async () => {
    router([
      [
        (u) => u.includes("/v1/platform/regions"),
        {
          regions: [
            { code: "iad", name: "Ashburn, Virginia (US)" },
            { code: "old", name: "Gone", deprecated: true },
            { code: "zzz", name: "Paid Place", requires_paid_plan: true },
          ],
        },
      ],
    ]);
    const cfg = await client().getCreateConfig("volume");
    const region = cfg.fields.find((f) => f.key === "region");
    expect(region?.regions?.map((r) => r.id)).toEqual(["iad", "zzz"]);
    expect(region?.regions?.[0]?.flag).toBeTruthy();
    expect(region?.regions?.[1]?.location).toBe("Paid Place (paid plans)");
  });

  it("region pickers fall back to the static table when the call fails", async () => {
    router([[(u) => u.includes("/v1/platform/regions"), "boom", 500]]);
    const cfg = await client().getCreateConfig("machine", "acct-1:app:app-one");
    const region = cfg.fields.find((f) => f.key === "region");
    expect(region?.regions?.some((r) => r.id === "iad")).toBe(true);
  });

  it("volume config with parent omits app field", async () => {
    router([[(u) => u.includes("/v1/platform/regions"), { regions: [] }]]);
    const cfg = await client().getCreateConfig("volume", "acct-1:app:app-one");
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("certificate config without parent has app picker", async () => {
    const cfg = await client().getCreateConfig("certificate");
    expect(cfg.fields[0]!.key).toBe("appName");
    expect(cfg.fields[0]!.kind).toBe("resource-picker");
    expect(cfg.fields.find((f) => f.key === "hostname")).toBeTruthy();
  });

  it("certificate config with parent omits app field", async () => {
    const cfg = await client().getCreateConfig("certificate", "acct-1:app:app-one");
    expect(cfg.fields.find((f) => f.key === "appName")).toBeUndefined();
    expect(cfg.fields[0]!.key).toBe("hostname");
  });

  it("throws for unknown type", async () => {
    await expect(client().getCreateConfig("nope")).rejects.toThrow(/No create config/);
  });
});

describe("createResource", () => {
  it("creates an app (POST then GET)", async () => {
    router([
      [(u, i) => method(i) === "POST" && u.endsWith("/v1/apps"), { id: "a1" }],
      [(u) => u.includes("/v1/apps/new-app"), { id: "a1", name: "new-app", status: "pending" }],
    ]);
    const r = await client().createResource("app", ACCOUNT, { name: "new-app" });
    expect(r.externalId).toBe("new-app");
    const postBody = JSON.parse(calls[0]!.init?.body as string);
    expect(postBody).toEqual({ app_name: "new-app", org_slug: "personal" });
  });

  it("creates an app with optional private network", async () => {
    router([
      [(u, i) => method(i) === "POST" && u.endsWith("/v1/apps"), { id: "a1" }],
      [(u) => u.includes("/v1/apps/new-app"), { id: "a1", name: "new-app", status: "pending" }],
    ]);
    await client().createResource("app", ACCOUNT, { name: "new-app", network: "isolated" });
    const postBody = JSON.parse(calls[0]!.init?.body as string);
    expect(postBody).toEqual({
      app_name: "new-app",
      org_slug: "personal",
      network: "isolated",
    });
  });

  it("creates a machine with name and parent app", async () => {
    router([[(u, i) => method(i) === "POST" && u.includes("/app-one/machines"), MACHINE]]);
    const r = await client().createResource(
      "machine",
      ACCOUNT,
      { name: "mc", region: "iad", image: "nginx" },
      "acct-1:app:app-one",
    );
    expect(r.externalId).toBe("app-one/m1");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.region).toBe("iad");
    expect(body.config.image).toBe("nginx");
    expect(body.name).toBe("mc");
  });

  it("creates a machine from appName field, no name", async () => {
    router([[(u, i) => method(i) === "POST" && u.includes("/myapp/machines"), MACHINE]]);
    await client().createResource("machine", ACCOUNT, {
      appName: "myapp",
      region: "lhr",
      image: "img",
    });
    expect(JSON.parse(calls[0]!.init?.body as string).name).toBeUndefined();
  });

  it("throws when machine missing appName", async () => {
    await expect(
      client().createResource("machine", ACCOUNT, { region: "iad", image: "x" }),
    ).rejects.toThrow(/appName is required to create a machine/);
  });

  it("creates a volume", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/app-one/volumes"),
        {
          id: "v9",
          name: "data",
          state: "created",
          size_gb: 5,
          region: "iad",
          encrypted: true,
          created_at: "2024",
        },
      ],
    ]);
    const r = await client().createResource(
      "volume",
      ACCOUNT,
      { name: "data", region: "iad", sizeGb: "5" },
      "acct-1:app:app-one",
    );
    expect(r.id).toBe("acct-1:volume:app-one/v9");
    expect(r.fields["sizeGb"]).toBe(5);
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.size_gb).toBe(5);
  });

  it("creates a volume with defaults from response fallbacks", async () => {
    router([[(u, i) => method(i) === "POST" && u.includes("/app-one/volumes"), { id: "v9" }]]);
    const r = await client().createResource(
      "volume",
      ACCOUNT,
      { name: "data", region: "iad", sizeGb: "" },
      "acct-1:app:app-one",
    );
    expect(r.fields["state"]).toBe("created");
    expect(JSON.parse(calls[0]!.init?.body as string).size_gb).toBe(1);
  });

  it("creates an ACME certificate", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/app-one/certificates/acme"),
        { hostname: "example.com", configured: false, acme_requested: true, status: "pending" },
      ],
    ]);
    const r = await client().createResource(
      "certificate",
      ACCOUNT,
      { hostname: "example.com" },
      "acct-1:app:app-one",
    );
    expect(r.id).toBe("acct-1:certificate:app-one/example.com");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({ hostname: "example.com" });
  });

  it("requires appName and hostname to create a certificate", async () => {
    await expect(
      client().createResource("certificate", ACCOUNT, { hostname: "example.com" }),
    ).rejects.toThrow(/appName is required/);
    await expect(
      client().createResource("certificate", ACCOUNT, { appName: "app-one" }),
    ).rejects.toThrow(/hostname is required/);
  });

  it("throws when volume missing appName", async () => {
    await expect(
      client().createResource("volume", ACCOUNT, { name: "d", region: "iad", sizeGb: "1" }),
    ).rejects.toThrow(/appName is required to create a volume/);
  });

  it("throws for unsupported type", async () => {
    await expect(client().createResource("nope", ACCOUNT, {})).rejects.toThrow(/not supported/);
  });
});

describe("deleteResource", () => {
  const ok = () => router([[() => true, null, 204]]);

  it("deletes app", async () => {
    ok();
    await client().deleteResource("app", "acct-1:app:app-one", ACCOUNT);
    expect(calls[0]!.url).toContain("/v1/apps/app-one");
    expect(method(calls[0]!.init)).toBe("DELETE");
  });

  it("deletes machine", async () => {
    ok();
    await client().deleteResource("machine", "acct-1:machine:app-one/m1", ACCOUNT);
    expect(calls[0]!.url).toContain("/v1/apps/app-one/machines/m1");
  });

  it("deletes volume", async () => {
    ok();
    await client().deleteResource("volume", "acct-1:volume:app-one/v1", ACCOUNT);
    expect(calls[0]!.url).toContain("/v1/apps/app-one/volumes/v1");
  });

  it("deletes certificate hostname", async () => {
    ok();
    await client().deleteResource("certificate", "acct-1:certificate:app-one/example.com", ACCOUNT);
    expect(calls[0]!.url).toContain("/v1/apps/app-one/certificates/example.com");
    expect(method(calls[0]!.init)).toBe("DELETE");
  });

  it("throws on unparseable app id", async () => {
    await expect(client().deleteResource("app", "", ACCOUNT)).rejects.toThrow(
      /Cannot parse app name/,
    );
  });

  it("throws for unsupported type", async () => {
    await expect(client().deleteResource("nope", "acct-1:nope:x", ACCOUNT)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("attachResource (volume → machine)", () => {
  const VOL = { id: "v1", name: "data", state: "created", size_gb: 10, region: "iad" };
  const MACH = {
    id: "m1",
    name: "mc",
    state: "started",
    region: "iad",
    config: { image: "nginx" },
  };

  function setup(volReg = "iad", machReg = "iad", existingMounts: unknown[] = []) {
    router([
      [(u) => u.includes("/volumes/v1"), { ...VOL, region: volReg }],
      [
        (u, i) => u.includes("/machines/m1") && method(i) === "GET",
        { ...MACH, region: machReg, config: { image: "nginx", mounts: existingMounts } },
      ],
      [(u, i) => u.includes("/machines/m1") && method(i) === "POST", { ok: true }],
    ]);
  }

  it("attaches volume to machine, preserving config", async () => {
    setup();
    await client().attachResource(
      "volume",
      "acct-1:volume:app-one/v1",
      "machine",
      "acct-1:machine:app-one/m1",
      ACCOUNT,
    );
    const post = calls.find((c) => method(c.init) === "POST" && c.url.includes("/machines/m1"));
    expect(post).toBeTruthy();
    const body = JSON.parse(post!.init?.body as string);
    expect(body.config.image).toBe("nginx");
    expect(body.config.mounts[0].volume).toBe("v1");
    expect(body.config.mounts[0].path).toBe("/mnt/data");
  });

  it("is a no-op when already mounted", async () => {
    setup("iad", "iad", [{ volume: "v1", path: "/mnt/data" }]);
    await client().attachResource(
      "volume",
      "acct-1:volume:app-one/v1",
      "machine",
      "acct-1:machine:app-one/m1",
      ACCOUNT,
    );
    const post = calls.find((c) => method(c.init) === "POST" && c.url.includes("/machines/m1"));
    expect(post).toBeUndefined();
  });

  it("throws on region mismatch", async () => {
    setup("iad", "lhr");
    await expect(
      client().attachResource(
        "volume",
        "acct-1:volume:app-one/v1",
        "machine",
        "acct-1:machine:app-one/m1",
        ACCOUNT,
      ),
    ).rejects.toThrow(/does not match machine region/);
  });

  it("throws on app mismatch", async () => {
    router([
      [(u) => u.includes("/apps/appA/volumes/v1"), VOL],
      [(u) => u.includes("/apps/appB/machines/m1"), MACH],
    ]);
    await expect(
      client().attachResource(
        "volume",
        "acct-1:volume:appA/v1",
        "machine",
        "acct-1:machine:appB/m1",
        ACCOUNT,
      ),
    ).rejects.toThrow(/can only mount on machines of the same app/);
  });

  it("throws for unsupported attach pairing", async () => {
    await expect(client().attachResource("machine", "x", "volume", "y", ACCOUNT)).rejects.toThrow(
      /attachResource not supported/,
    );
  });
});

describe("fetchDashboardStats", () => {
  it("app stats deployed/healthy", async () => {
    router([
      [
        (u) => u.includes("/v1/apps/app-one"),
        { id: "a", name: "app-one", status: "deployed", machine_count: 3, volume_count: 1 },
      ],
    ]);
    const stats = await client().fetchDashboardStats("app", "acct-1:app:app-one", ACCOUNT);
    expect(stats[0]!).toEqual({ label: "Status", value: "deployed", variant: "status-healthy" });
    expect(stats.find((s) => s.label === "Machines")?.value).toBe("3");
  });

  it("app stats non-deployed degraded", async () => {
    router([
      [(u) => u.includes("/v1/apps/app-one"), { id: "a", name: "app-one", status: "suspended" }],
    ]);
    const stats = await client().fetchDashboardStats("app", "acct-1:app:app-one", ACCOUNT);
    expect(stats[0]!.variant).toBe("status-degraded");
  });

  it("machine stats with image", async () => {
    router([[(u) => u.includes("/machines/m1"), MACHINE]]);
    const stats = await client().fetchDashboardStats(
      "machine",
      "acct-1:machine:app-one/m1",
      ACCOUNT,
    );
    expect(stats[0]!).toEqual({ label: "State", value: "started", variant: "status-healthy" });
    expect(stats.find((s) => s.label === "Region")?.value).toContain("iad");
    expect(stats.find((s) => s.label === "Image")?.value).toBe("nginx:latest");
  });

  it("machine stats stopped → error variant, no image", async () => {
    router([
      [(u) => u.includes("/machines/m1"), { id: "m1", name: "n", state: "stopped", region: "zzz" }],
    ]);
    const stats = await client().fetchDashboardStats(
      "machine",
      "acct-1:machine:app-one/m1",
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-error");
    expect(stats.find((s) => s.label === "Region")?.value).toBe("zzz");
    expect(stats.find((s) => s.label === "Image")).toBeUndefined();
  });

  it("volume stats", async () => {
    router([[(u) => u.includes("/volumes/v1"), VOLUME]]);
    const stats = await client().fetchDashboardStats("volume", "acct-1:volume:app-one/v1", ACCOUNT);
    expect(stats[0]!).toEqual({ label: "Size", value: "10 GB" });
  });
});

describe("fetchMetricSeries", () => {
  it("returns empty for unsupported type", async () => {
    expect(
      await client().fetchMetricSeries("certificate", "acct-1:certificate:a/h", ACCOUNT),
    ).toEqual([]);
  });

  it("queries prometheus and aggregates series for a machine", async () => {
    router([
      [(u) => u.includes("/machines/m1"), MACHINE],
      [
        (u) => u.includes("/prometheus/"),
        {
          data: {
            result: [
              {
                metric: {},
                values: [
                  [1000, "1"],
                  [1060, "2"],
                ],
              },
              { metric: {}, values: [[1000, "3"]] },
            ],
          },
        },
      ],
    ]);
    const series = await client().fetchMetricSeries(
      "machine",
      "acct-1:machine:app-one/m1",
      ACCOUNT,
      {
        startMs: 1_000_000,
        endMs: 2_000_000,
      },
    );
    expect(series.length).toBeGreaterThan(0);
    const cpu = series.find((s) => s.label === "CPU");
    expect(cpu).toBeTruthy();
    // ts=1000s → 1_000_000ms, summed 1+3=4
    expect(cpu!.points[0]).toEqual({ timestamp: 1_000_000, value: 4 });
    expect(series.map((s) => s.label)).toEqual(
      expect.arrayContaining(["HTTP Requests", "Response Time p95", "Memory Used"]),
    );
    // CPU is converted from centiseconds to cores
    const cpuCall = calls.find((c) => decodeURIComponent(c.url).includes("fly_instance_cpu"));
    expect(decodeURIComponent(cpuCall!.url.replace(/\+/g, " "))).toContain("/ 100");
    // prometheus query included machine instance filter
    const promCall = calls.find((c) => c.url.includes("/prometheus/"));
    expect(decodeURIComponent(promCall!.url)).toContain('instance="inst1"');
  });

  it("returns empty when appName cannot be resolved", async () => {
    router([
      [(u) => u.includes("/machines/m1"), { id: "m1", name: "n", state: "started", region: "iad" }],
    ]);
    // machine with empty appName field: appName derived from fields["appName"] which mapMachine sets, so force via app type with empty name
    const res = await client().fetchMetricSeries("machine", "acct-1:machine:/m1", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("skips series when prometheus returns non-ok or empty", async () => {
    router([
      [(u) => u.includes("/machines/m1"), MACHINE],
      [(u) => u.includes("/prometheus/"), "fail", 500],
    ]);
    const series = await client().fetchMetricSeries(
      "machine",
      "acct-1:machine:app-one/m1",
      ACCOUNT,
    );
    expect(series).toEqual([]);
  });

  it("routes prometheus metrics through host http when available", async () => {
    const request = vi.fn(async (req: { url: string }) => {
      if (req.url.includes("/v1/apps/app-one")) {
        return {
          status: 200,
          body: JSON.stringify({ id: "a", name: "app-one", status: "deployed" }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          data: { result: [{ metric: {}, values: [[1000, "2"]] }] },
        }),
      };
    });
    const spy = installFetch(() => jsonResponse({}));
    const series = await client({ apiToken: "tok" }, { http: { request } }).fetchMetricSeries(
      "app",
      "acct-1:app:app-one",
      ACCOUNT,
    );
    expect(series.length).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("https://api.fly.io/prometheus/personal/api/v1/query_range"),
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("handles app-level metrics without instance filter", async () => {
    router([
      [(u) => u.includes("/v1/apps/app-one"), { id: "a", name: "app-one", status: "deployed" }],
      [(u) => u.includes("/prometheus/"), { data: { result: [] } }],
    ]);
    const series = await client().fetchMetricSeries("app", "acct-1:app:app-one", ACCOUNT);
    expect(series).toEqual([]);
    const promCall = calls.find((c) => c.url.includes("/prometheus/"));
    expect(decodeURIComponent(promCall!.url)).not.toContain("instance=");
  });
});

describe("renderDetail", () => {
  function res(
    typeId: string,
    fields: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    return {
      id: `acct-1:${typeId}:x`,
      pluginId: "fly",
      resourceTypeId: typeId,
      accountId: ACCOUNT,
      displayName: "disp",
      externalId: "x",
      fields,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
      ...extra,
    } as never;
  }

  it("app detail with network", () => {
    const view = client().renderDetail(
      res("app", {
        name: "a",
        status: "deployed",
        organization: "org",
        machineCount: 2,
        volumeCount: 1,
        network: "default",
      }),
    );
    expect((view.status as { status: string }).status).toBe("healthy");
    expect(view.subtitle).toContain("org");
  });

  it("app detail degraded without network", () => {
    const view = client().renderDetail(res("app", { name: "a", status: "pending" }));
    expect((view.status as { status: string }).status).toBe("degraded");
  });

  it("machine detail with image, instance, privateIp", () => {
    const view = client().renderDetail(
      res(
        "machine",
        {
          name: "m",
          state: "started",
          region: "iad",
          image: "nginx",
          appName: "app-one",
          instanceId: "i1",
        },
        { resolvedOutputs: { privateIp: "fdaa::1" } },
      ),
    );
    expect((view.status as { status: string }).status).toBe("healthy");
    expect(view.subtitle).toContain("Ashburn");
  });

  it("machine detail minimal", () => {
    const view = client().renderDetail(
      res("machine", { state: "stopped", region: "unknownreg", appName: "app" }),
    );
    expect((view.status as { status: string }).status).toBe("error");
    expect(view.subtitle).toContain("unknownreg");
  });

  it("volume detail created/healthy", () => {
    const view = client().renderDetail(
      res("volume", {
        name: "data",
        state: "created",
        region: "iad",
        sizeGb: 10,
        appName: "app",
        encrypted: true,
        attachedMachineId: "",
      }),
    );
    expect((view.status as { status: string }).status).toBe("healthy");
  });

  it("volume detail non-created/error", () => {
    const view = client().renderDetail(
      res("volume", {
        name: "data",
        state: "deleting",
        region: "iad",
        sizeGb: 10,
        appName: "app",
        encrypted: true,
        attachedMachineId: "",
      }),
    );
    expect((view.status as { status: string }).status).toBe("error");
  });
});

describe("renderSidebarItem", () => {
  function item(typeId: string, fields: Record<string, unknown>) {
    return client().renderSidebarItem({
      id: "id",
      displayName: "x",
      resourceTypeId: typeId,
      fields,
    } as never);
  }
  it("machine states", () => {
    expect((item("machine", { state: "started" }).status as { status: string }).status).toBe(
      "healthy",
    );
    expect((item("machine", { state: "starting" }).status as { status: string }).status).toBe(
      "provisioning",
    );
    expect((item("machine", { state: "stopping" }).status as { status: string }).status).toBe(
      "degraded",
    );
    expect((item("machine", { state: "destroyed" }).status as { status: string }).status).toBe(
      "error",
    );
    expect((item("machine", { state: "weird" }).status as { status: string }).status).toBe("info");
  });
  it("app + volume + default", () => {
    expect((item("app", { status: "deployed" }).status as { status: string }).status).toBe(
      "healthy",
    );
    expect((item("app", { status: "x" }).status as { status: string }).status).toBe("degraded");
    expect((item("volume", { state: "created" }).status as { status: string }).status).toBe(
      "healthy",
    );
    expect((item("volume", { state: "x" }).status as { status: string }).status).toBe("error");
    expect((item("other", {}).status as { status: string }).status).toBe("info");
  });
});

describe("error handling", () => {
  it("throws vendor error on non-ok", async () => {
    router([[(u) => u.includes("/v1/apps"), "boom", 503]]);
    await expect(client().listResources("app", ACCOUNT)).rejects.toThrow(/Fly API error 503/);
  });
});

describe("IP assignments", () => {
  it("lists via /ip_assignments and derives the address type", async () => {
    router([
      [(u) => u.includes("/v1/apps?"), { apps: [{ id: "a1", name: "app-one" }], total_apps: 1 }],
      [
        (u) => u.endsWith("/v1/apps/app-one/ip_assignments"),
        {
          ips: [
            { ip: "1.2.3.4", region: "global", shared: true },
            { ip: "2a09::1", region: "global", service_name: "web" },
            { ip: "fdaa::3", network: { name: "", org_slug: "personal" } },
            { ip: "5.6.7.8", region: "iad", egress: true },
          ],
        },
      ],
    ]);
    const res = await client().listResources("ip-allocation", ACCOUNT);
    expect(res.map((r) => r.fields["type"])).toEqual([
      "shared_v4",
      "v6",
      "private_v6",
      "egress_v4",
    ]);
    expect(res[1]!.fields["serviceName"]).toBe("web");
    expect(res[2]!.fields["private"]).toBe(true);
    expect(res[0]!.id).toBe("acct-1:ip-allocation:app-one/1.2.3.4");
  });

  it("assigns an address with type, region for egress, and service", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.endsWith("/v1/apps/app-one/ip_assignments"),
        { ip: null, ip_pair: { v4: "9.9.9.9", v6: "2a09::9" }, region: "fra", egress: true },
      ],
    ]);
    const res = await client().createResource(
      "ip-allocation",
      ACCOUNT,
      { type: "egress_pair", region: "fra", serviceName: "" },
      "acct-1:app:app-one",
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ type: "egress_pair", org_slug: "personal", region: "fra" });
    expect(res.fields["address"]).toBe("9.9.9.9");
  });

  it("releases an address", async () => {
    router([[(u, i) => method(i) === "DELETE", {}]]);
    await client().deleteResource("ip-allocation", "acct-1:ip-allocation:app-one/1.2.3.4", ACCOUNT);
    expect(calls[0]!.url).toContain("/v1/apps/app-one/ip_assignments/1.2.3.4");
  });
});

describe("certificates (Machines API shapes)", () => {
  it("maps the detail shape: issuer, earliest expiry, validation errors", async () => {
    router([
      [
        (u) => u.includes("/certificates/www.example.com"),
        {
          hostname: "www.example.com",
          status: "active",
          configured: true,
          validation: { dns_configured: true, alpn_configured: false },
          validation_errors: [{ code: "x", message: "CNAME missing" }],
          certificates: [
            {
              source: "fly",
              status: "active",
              expires_at: "2026-12-01T00:00:00Z",
              issued: [
                { certificate_authority: "lets_encrypt", expires_at: "2026-11-01T00:00:00Z" },
              ],
            },
          ],
        },
      ],
    ]);
    const res = await client().getResource(
      "certificate",
      "acct-1:certificate:app-one/www.example.com",
      ACCOUNT,
    );
    expect(res.fields["certificateAuthority"]).toBe("lets_encrypt");
    expect(res.fields["expires"]).toBe("2026-11-01T00:00:00Z");
    expect(res.fields["source"]).toBe("fly");
    expect(res.fields["acmeDnsConfigured"]).toBe(true);
    expect(res.fields["acmeAlpnConfigured"]).toBe(false);
    expect(res.fields["validationErrors"]).toBe("CNAME missing");
  });

  it("follows next_cursor when listing", async () => {
    let page = 0;
    installFetch((url) => {
      if (url.includes("/v1/apps?")) {
        return jsonResponse({ apps: [{ id: "a1", name: "app-one" }], total_apps: 1 });
      }
      page += 1;
      return jsonResponse(
        page === 1
          ? { certificates: [{ hostname: "a.example.com" }], next_cursor: "c2" }
          : { certificates: [{ hostname: "b.example.com" }] },
      );
    });
    const res = await client().listResources("certificate", ACCOUNT);
    expect(res.map((r) => r.displayName)).toEqual(["a.example.com", "b.example.com"]);
    expect(calls.some((c) => c.url.includes("cursor=c2"))).toBe(true);
  });

  it("check action re-validates DNS", async () => {
    router([[(u, i) => method(i) === "POST" && u.endsWith("/check"), {}]]);
    await client().invokeAction(
      "certificate",
      "acct-1:certificate:app-one/www.example.com",
      "check",
      ACCOUNT,
    );
    expect(calls[0]!.url).toContain("/v1/apps/app-one/certificates/www.example.com/check");
  });
});

describe("app secrets", () => {
  it("lists names and digests without requesting values", async () => {
    router([
      [(u) => u.includes("/v1/apps?"), { apps: [{ id: "a1", name: "app-one" }], total_apps: 1 }],
      [
        (u) => u.endsWith("/v1/apps/app-one/secrets"),
        { secrets: [{ name: "DATABASE_URL", digest: "abc", created_at: "2026-01-01" }] },
      ],
    ]);
    const res = await client().listResources("app-secret", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:app-secret:app-one/DATABASE_URL");
    expect(res[0]!.fields["digest"]).toBe("abc");
    expect(res[0]!.fields["value"]).toBeUndefined();
    expect(calls.every((c) => !c.url.includes("show_secrets"))).toBe(true);
  });

  it("creates, updates, and deletes a secret", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/secrets/API_KEY"),
        { name: "API_KEY", digest: "d1" },
      ],
      [(u, i) => method(i) === "GET" && u.includes("/secrets/API_KEY"), { name: "API_KEY" }],
      [(u, i) => method(i) === "DELETE", { version: 3 }],
    ]);
    const created = await client().createResource("app-secret", ACCOUNT, {
      appName: "app-one",
      name: "API_KEY",
      value: "s3cret",
    });
    expect(created.displayName).toBe("API_KEY");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ value: "s3cret" });

    calls = [];
    await client().updateResource("app-secret", created.id, ACCOUNT, { value: "rotated" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ value: "rotated" });

    calls = [];
    await client().updateResource("app-secret", created.id, ACCOUNT, {});
    expect(calls.every((c) => method(c.init) === "GET")).toBe(true);

    calls = [];
    await client().deleteResource("app-secret", created.id, ACCOUNT);
    expect(calls[0]!.url).toContain("/v1/apps/app-one/secrets/API_KEY");
  });
});

describe("machines: sizes, actions, events", () => {
  it("creates a machine with a guest size and memory override", async () => {
    router([[(u, i) => method(i) === "POST" && u.endsWith("/machines"), MACHINE]]);
    await client().createResource("machine", ACCOUNT, {
      appName: "app-one",
      region: "iad",
      image: "nginx",
      size: "performance-2x",
      memoryMb: "8192",
    });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.config.guest).toEqual({ cpu_kind: "performance", cpus: 2, memory_mb: 8192 });
  });

  it("maps guest, cordon, and host status", async () => {
    router([
      [
        (u) => u.includes("/machines/m1"),
        {
          ...MACHINE,
          cordoned: true,
          host_status: "unreachable",
          config: { image: "x", guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 } },
        },
      ],
    ]);
    const res = await client().getResource("machine", "acct-1:machine:app-one/m1", ACCOUNT);
    expect(res.fields).toMatchObject({
      cpuKind: "shared",
      cpus: 1,
      memoryMb: 256,
      cordoned: true,
      hostStatus: "unreachable",
    });
    const detail = client().renderDetail(res);
    const labels = (detail.headerActions ?? []).map((a) => a.label);
    expect(labels).toEqual(expect.arrayContaining(["Restart", "Suspend", "Uncordon", "Stop"]));
    expect(detail.logs).toBeTruthy();
  });

  it.each(["restart", "suspend", "cordon", "uncordon"])("invokes %s", async (action) => {
    router([[(u, i) => method(i) === "POST", {}]]);
    await client().invokeAction("machine", "acct-1:machine:app-one/m1", action, ACCOUNT);
    expect(calls[0]!.url).toContain(`/v1/apps/app-one/machines/m1/${action}`);
  });

  it("renders machine events as logs, oldest first", async () => {
    router([
      [
        (u) => u.includes("/machines/m1/events"),
        [
          {
            type: "exit",
            status: "stopped",
            source: "flyd",
            timestamp: 2000,
            request: { exit_event: { exit_code: 137 } },
          },
          { type: "start", status: "started", source: "user", timestamp: 1000 },
        ],
      ],
    ]);
    const logs = await client().getLogs("machine", "acct-1:machine:app-one/m1", ACCOUNT, {
      tailLines: 500,
    });
    expect(calls[0]!.url).toContain("limit=50");
    const lines = logs.text.trim().split("\n");
    expect(lines[0]).toContain("start");
    expect(lines[1]).toContain("exit_code=137");
    expect(logs.containers).toEqual(["events"]);
  });
});

describe("volumes: extend, settings, snapshots", () => {
  it("extends a volume and updates snapshot settings", async () => {
    router([
      [(u, i) => method(i) === "GET" && u.endsWith("/volumes/v1"), VOLUME],
      [(u, i) => method(i) === "PUT", {}],
    ]);
    await client().updateResource("volume", "acct-1:volume:app-one/v1", ACCOUNT, {
      sizeGb: "20",
      snapshotRetention: "14",
      autoBackupEnabled: "false",
    });
    const extend = calls.find((c) => c.url.endsWith("/extend"));
    expect(JSON.parse(String(extend!.init?.body))).toEqual({ size_gb: 20 });
    const settings = calls.find((c) => method(c.init) === "PUT" && c.url.endsWith("/volumes/v1"));
    expect(JSON.parse(String(settings!.init?.body))).toEqual({
      auto_backup_enabled: false,
      snapshot_retention: 14,
    });
  });

  it("refuses to shrink a volume", async () => {
    router([[(u) => u.endsWith("/volumes/v1"), VOLUME]]);
    await expect(
      client().updateResource("volume", "acct-1:volume:app-one/v1", ACCOUNT, { sizeGb: "5" }),
    ).rejects.toThrow(/only grow/);
  });

  it("snapshots on demand and lists snapshots in the detail view", async () => {
    router([
      [(u, i) => method(i) === "POST" && u.endsWith("/snapshots"), {}],
      [
        (u) => u.endsWith("/snapshots"),
        [{ id: "vs_1", status: "created", size: 123, created_at: "2026-01-01" }],
      ],
    ]);
    await client().invokeAction("volume", "acct-1:volume:app-one/v1", "snapshot", ACCOUNT);
    expect(calls[0]!.init?.method).toBe("POST");
    const base = {
      id: "acct-1:volume:app-one/v1",
      resourceTypeId: "volume",
      displayName: "data",
      fields: { state: "created", region: "iad" },
      resolvedOutputs: {},
    } as never;
    const enriched = await client().enrichDetail(base);
    const detail = client().renderDetail(enriched);
    const snap = detail.sections.find((sec) => sec.title === "Snapshots");
    expect(snap).toBeTruthy();
  });

  it("queries volume usage metrics by volume id", async () => {
    router([
      [(u) => u.includes("/volumes/v1"), VOLUME],
      [
        (u) => u.includes("/prometheus/"),
        { data: { result: [{ metric: {}, values: [[1, "42"]] }] } },
      ],
    ]);
    const series = await client().fetchMetricSeries("volume", "acct-1:volume:app-one/v1", ACCOUNT);
    expect(series.map((s) => s.label)).toEqual(["Disk Used", "Volume Size"]);
    expect(decodeURIComponent(calls.find((c) => c.url.includes("prometheus"))!.url)).toContain(
      'id="v1"',
    );
  });
});

describe("managed postgres", () => {
  const CLUSTER = {
    id: "pg_1",
    name: "main-db",
    status: "ready",
    plan: "basic",
    region: "iad",
    pg_major_version: "17",
    cpus: 2,
    cpu_kind: "shared",
    memory_mb: 1024,
    disk_size_gb: 10,
    replicas: 1,
    attached_apps: [{ name: "app-one" }],
    endpoints: {
      primary: {
        direct: { host: "direct.flympg.net", port: 5432 },
        pooler: { host: "pooler.flympg.net", port: 6432 },
      },
    },
  };

  it("lists clusters for the org", async () => {
    router([
      [
        (u) => u.includes("/v1/postgres?org_slug=personal"),
        { data: [{ id: "pg_1", name: "main-db", status: "creating", plan: "basic" }] },
      ],
    ]);
    const res = await client().listResources("postgres-cluster", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:postgres-cluster:pg_1");
    expect(res[0]!.fields["status"]).toBe("creating");
  });

  it("maps endpoints to outputs and resolves them", async () => {
    router([[(u) => u.endsWith("/v1/postgres/pg_1"), { data: CLUSTER }]]);
    const res = await client().getResource(
      "postgres-cluster",
      "acct-1:postgres-cluster:pg_1",
      ACCOUNT,
    );
    expect(res.resolvedOutputs).toMatchObject({
      host: "direct.flympg.net",
      port: "5432",
      poolerHost: "pooler.flympg.net",
    });
    expect(res.fields["attachedApps"]).toBe("app-one");
    expect(
      await client().resolveOutput(
        "postgres-cluster",
        "acct-1:postgres-cluster:pg_1",
        "poolerPort",
        ACCOUNT,
      ),
    ).toBe("6432");
  });

  it("creates a cluster with the documented body", async () => {
    router([[(u, i) => method(i) === "POST" && u.endsWith("/v1/postgres"), { data: CLUSTER }]]);
    await client().createResource("postgres-cluster", ACCOUNT, {
      name: "main-db",
      region: "iad",
      plan: "launch",
      pgMajorVersion: "16",
      diskSizeGb: "40",
      poolMode: "session",
      postgisEnabled: "true",
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      org_slug: "personal",
      region: "iad",
      plan: "launch",
      name: "main-db",
      pg_major_version: "16",
      disk_size_gb: 40,
      pool_mode: "session",
      postgis_enabled: true,
    });
  });

  it("offers only MPG-capable regions", async () => {
    router([
      [
        (u) => u.includes("/v1/platform/regions"),
        {
          regions: [
            { code: "iad", mpg_available: true },
            { code: "jnb", mpg_available: false },
          ],
        },
      ],
    ]);
    const cfg = await client().getCreateConfig("postgres-cluster");
    expect(cfg.fields.find((f) => f.key === "region")?.regions?.map((r) => r.id)).toEqual(["iad"]);
  });

  it("backs up, attaches an app, and deletes", async () => {
    router([[() => true, {}]]);
    await client().invokeAction(
      "postgres-cluster",
      "acct-1:postgres-cluster:pg_1",
      "backup",
      ACCOUNT,
    );
    expect(calls[0]!.url).toContain("/v1/postgres/pg_1/backups");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ type: "full" });
    await client().attachResource(
      "postgres-cluster",
      "acct-1:postgres-cluster:pg_1",
      "app",
      "acct-1:app:app-one",
      ACCOUNT,
    );
    expect(calls[1]!.url).toContain("/v1/postgres/pg_1/attachments");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ app_name: "app-one" });
    await client().deleteResource("postgres-cluster", "acct-1:postgres-cluster:pg_1", ACCOUNT);
    expect(calls[2]!.init?.method).toBe("DELETE");
  });

  it("enriches a ready cluster with databases, users, and backups", async () => {
    router([
      [(u) => u.endsWith("/v1/postgres/pg_1"), { data: CLUSTER }],
      [(u) => u.endsWith("/databases"), { data: [{ name: "fly-db" }] }],
      [(u) => u.endsWith("/users"), { data: [{ username: "app", role: "writer" }] }],
      [(u) => u.endsWith("/backups"), "unavailable", 503],
    ]);
    const base = await client().getResource(
      "postgres-cluster",
      "acct-1:postgres-cluster:pg_1",
      ACCOUNT,
    );
    const enriched = await client().enrichDetail(base);
    const titles = client()
      .renderDetail(enriched)
      .sections.map((sec) => sec.title);
    expect(titles).toEqual(expect.arrayContaining(["Databases", "Users"]));
    expect(titles).not.toContain("Backups");
  });
});

describe("app deploy token", () => {
  it("mints an app-scoped token", async () => {
    router([
      [(u, i) => method(i) === "POST" && u.endsWith("/deploy_token"), { token: "FlyV1 abc" }],
    ]);
    const cred = await client().exportCredential(
      "app",
      "acct-1:app:app-one",
      ACCOUNT,
      "deploy-token",
    );
    expect(calls[0]!.url).toContain("/v1/apps/app-one/deploy_token");
    expect(cred.content).toBe("FlyV1 abc");
    expect(cred.fields?.[0]?.sensitive).toBe(true);
  });
});
