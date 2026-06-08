import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetlifyClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
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
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as typeof fetch);
}

/** Route by URL substring → response body. method-aware via predicate keys. */
function router(routes: Array<[(url: string, init?: RequestInit) => boolean, unknown, number?]>) {
  return installFetch((url, init) => {
    for (const [pred, body, status] of routes) {
      if (pred(url, init)) return jsonResponse(body, status ?? 200);
    }
    throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
  });
}

function method(init?: RequestInit): string {
  return init?.method ?? "GET";
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

function client(creds: Record<string, string> = { accessToken: "tok" }, services?: unknown) {
  return new NetlifyClient(creds, services as never);
}

const SITE = {
  id: "site1",
  name: "my-site",
  state: "current",
  plan: "pro",
  url: "http://s.netlify.app",
  ssl_url: "https://s.netlify.app",
  custom_domain: "example.com",
  domain_aliases: ["www.example.com"],
  functions_region: "us-east-1",
  ssl: true,
  force_ssl: true,
  managed_dns: true,
  account_name: "Acme",
  created_at: "2024-01-01",
  updated_at: "2024-01-02",
  build_settings: {
    repo_url: "https://github.com/a/b",
    repo_branch: "main",
    cmd: "build",
    dir: "dist",
  },
  published_deploy: { framework: "next", state: "current" },
};

describe("constructor", () => {
  it("throws without accessToken", () => {
    expect(() => new NetlifyClient({})).toThrow(/missing accessToken/);
  });

  it("sends auth + accept headers and base url", async () => {
    router([[(u) => u.includes("/sites"), [SITE]]]);
    await client().listResources("netlify-site", ACCOUNT);
    expect(calls[0]!.url).toContain("https://api.netlify.com/api/v1/sites");
    const h = calls[0]!.init?.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["Accept"]).toBe("application/json");
    expect(h["User-Agent"]).toBeUndefined();
  });

  it("uses host http when services.http is supplied", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify([SITE]) }));
    const spy = installFetch(() => jsonResponse({}));
    await client({ accessToken: "tok" }, { http: { request } }).listResources(
      "netlify-site",
      ACCOUNT,
    );
    expect(request).toHaveBeenCalled();
    const [requestArg] = (request.mock.calls as unknown as Array<[{ caCert?: string }]>)[0]!;
    expect(requestArg.caCert).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes caCert through host http when configured", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify([SITE]) }));
    const spy = installFetch(() => jsonResponse({}));
    await client({ accessToken: "tok", caCert: "PEM" }, { http: { request } }).listResources(
      "netlify-site",
      ACCOUNT,
    );
    expect(request).toHaveBeenCalled();
    expect(
      ((request.mock.calls as unknown as [unknown[]])[0]![0] as { caCert?: string }).caCert,
    ).toBe("PEM");
    expect(spy).not.toHaveBeenCalled();
  });

  it("routes legacy env calls through host http", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify([{ key: "K" }]) }));
    await client({ accessToken: "tok" }, { http: { request } }).createResource(
      "netlify-env-var",
      ACCOUNT,
      { siteId: "site1", key: "K", value: "V" },
    );
    expect(request).toHaveBeenCalled();
    const [requestArg] = (request.mock.calls as unknown as Array<[{ url: string }]>)[0]!;
    expect(requestArg.url).toContain("/sites/site1/env");
  });
});

describe("listResources sites + pagination", () => {
  it("maps a site and paginates across pages", async () => {
    let call = 0;
    installFetch(() => {
      call++;
      if (call === 1) return jsonResponse(new Array(100).fill(SITE));
      return jsonResponse([SITE]); // 2nd page < 100 stops loop
    });
    const res = await client().listResources("netlify-site", ACCOUNT);
    expect(res).toHaveLength(101);
    const s = res[0]!;
    expect(s.id).toBe("acct-1:netlify-site:site1");
    expect(s.fields["framework"]).toBe("next");
    expect(s.fields["state"]).toBe("current");
    expect(s.fields["domainAliases"]).toBe("www.example.com");
    expect(s.fields["repoUrl"]).toBe("https://github.com/a/b");
    expect(s.resolvedOutputs["siteId"]).toBe("site1");
  });

  it("handles null list response", async () => {
    installFetch(() => jsonResponse(null));
    const res = await client().listResources("netlify-site", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("maps site with minimal fields", async () => {
    installFetch(() => jsonResponse([{ id: "s2", name: "", created_at: "x", updated_at: "y" }]));
    const res = await client().listResources("netlify-site", ACCOUNT);
    expect(res[0]!.displayName).toBe("s2");
    expect(res[0]!.fields["framework"]).toBe("");
    expect(res[0]!.fields["ssl"]).toBe(false);
  });

  it("throws on unknown type", async () => {
    await expect(client().listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("deploys / forms / build hooks / env vars (per-site fan-out)", () => {
  const DEPLOY = {
    id: "dep1",
    state: "ready",
    context: "production",
    branch: "main",
    commit_ref: "abcdef123456",
    commit_url: "https://commit",
    title: "Deploy title",
    deploy_ssl_url: "https://dep.ssl",
    ssl_url: "https://ssl",
    error_message: "",
    framework: "next",
    draft: false,
    locked: false,
    skipped: false,
    created_at: "2024-01-01",
    updated_at: "2024-01-02",
    published_at: "2024-01-03",
  };

  it("lists deploys, skipping sites that error", async () => {
    router([
      [
        (u) => u.endsWith("/sites") || u.includes("/sites?"),
        [SITE, { id: "site2", name: "two", created_at: "x", updated_at: "y" }],
      ],
      [(u) => u.includes("/sites/site1/deploys"), [DEPLOY]],
      [(u) => u.includes("/sites/site2/deploys"), "forbidden", 403],
    ]);
    const res = await client().listResources("netlify-deploy", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:netlify-deploy:dep1");
    expect(res[0]!.displayName).toBe("Deploy title");
    expect(res[0]!.fields["url"]).toBe("https://dep.ssl");
    expect(res[0]!.parentResourceId).toBe("acct-1:netlify-site:site1");
    // per_page=5 query passed
    const deployCall = calls.find((c) => c.url.includes("/deploys"));
    expect(deployCall?.url).toContain("per_page=5");
  });

  it("deploy label falls back to short ref then id", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/deploys"), [SITE]],
      [
        (u) => u.includes("/deploys"),
        [
          {
            id: "longdeployid123",
            state: "error",
            commit_ref: "abcdef1234",
            created_at: "x",
            updated_at: "y",
          },
        ],
      ],
    ]);
    const res = await client().listResources("netlify-deploy", ACCOUNT);
    expect(res[0]!.displayName).toBe("abcdef12");
  });

  it("deploy label falls back to id slice when no title/ref", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/deploys"), [SITE]],
      [
        (u) => u.includes("/deploys"),
        [{ id: "deployidxxxxxx", state: "ready", created_at: "x", updated_at: "y" }],
      ],
    ]);
    const res = await client().listResources("netlify-deploy", ACCOUNT);
    expect(res[0]!.displayName).toBe("deployid");
    expect(res[0]!.fields["url"]).toBe("");
  });

  it("lists forms", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/forms"), [SITE]],
      [
        (u) => u.includes("/forms"),
        [
          {
            id: "form1",
            name: "Contact",
            submission_count: 5,
            paths: ["/a", "/b"],
            created_at: "x",
          },
        ],
      ],
    ]);
    const res = await client().listResources("netlify-form", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:netlify-form:site1/form1");
    expect(res[0]!.fields["paths"]).toBe("/a, /b");
    expect(res[0]!.fields["submissionCount"]).toBe(5);
  });

  it("skips forms for sites that error", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/forms"), [SITE]],
      [(u) => u.includes("/forms"), "no", 500],
    ]);
    const res = await client().listResources("netlify-form", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("lists build hooks", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/build_hooks"), [SITE]],
      [
        (u) => u.includes("/build_hooks"),
        [{ id: "hook1", title: "CMS", branch: "main", url: "https://hook", created_at: "x" }],
      ],
    ]);
    const res = await client().listResources("netlify-build-hook", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:netlify-build-hook:site1/hook1");
    expect(res[0]!.resolvedOutputs["hookUrl"]).toBe("https://hook");
  });

  it("build hook minimal fields fall back to id + iso timestamps", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/build_hooks"), [SITE]],
      [(u) => u.includes("/build_hooks"), [{ id: "hook2" }]],
    ]);
    const res = await client().listResources("netlify-build-hook", ACCOUNT);
    expect(res[0]!.displayName).toBe("hook2");
    expect(res[0]!.createdAt).toMatch(/T/);
  });

  it("lists env vars with context dedupe", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/env"), [SITE]],
      [
        (u) => u.includes("/env"),
        [
          {
            key: "API",
            scopes: ["builds"],
            values: [{ context: "production" }, { context: "production" }, { context: "dev" }],
            is_secret: true,
            updated_at: "x",
          },
        ],
      ],
    ]);
    const res = await client().listResources("netlify-env-var", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:netlify-env-var:site1/API");
    expect(res[0]!.fields["contexts"]).toBe("production, dev");
    expect(res[0]!.fields["isSecret"]).toBe(true);
  });

  it("env var with no values yields empty contexts", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/env"), [SITE]],
      [(u) => u.includes("/env"), [{ key: "K" }]],
    ]);
    const res = await client().listResources("netlify-env-var", ACCOUNT);
    expect(res[0]!.fields["contexts"]).toBe("");
    expect(res[0]!.fields["scopes"]).toBe("");
  });
});

describe("DNS zones + records", () => {
  const ZONE = {
    id: "zone1",
    name: "example.com",
    domain: "example.com",
    dns_servers: ["ns1", "ns2"],
    supported_record_types: ["A", "CNAME"],
    ipv6_enabled: true,
    dedicated: false,
    account_name: "Acme",
    created_at: "x",
    updated_at: "y",
  };

  it("lists zones", async () => {
    router([[(u) => u.includes("/dns_zones") && !u.includes("/dns_records"), [ZONE]]]);
    const res = await client().listResources("netlify-dns-zone", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:netlify-dns-zone:zone1");
    expect(res[0]!.fields["dnsServers"]).toBe("ns1, ns2");
    expect(res[0]!.fields["supportedRecordTypes"]).toBe("A, CNAME");
  });

  it("zone with missing arrays", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [{ id: "z2", name: "z", created_at: "x", updated_at: "y" }],
      ],
    ]);
    const res = await client().listResources("netlify-dns-zone", ACCOUNT);
    expect(res[0]!.fields["dnsServers"]).toBe("");
    expect(res[0]!.resolvedOutputs["domain"]).toBe("z");
  });

  it("lists records across zones, skipping unreadable", async () => {
    router([
      [
        (u) => u.includes("/dns_zones") && !u.includes("/dns_records"),
        [ZONE, { id: "z2", name: "z2", created_at: "x", updated_at: "y" }],
      ],
      [
        (u) => u.includes("/dns_zones/zone1/dns_records"),
        [{ id: "rec1", hostname: "www", type: "A", value: "1.2.3.4", ttl: 300, priority: 0 }],
      ],
      [(u) => u.includes("/dns_zones/z2/dns_records"), "no", 403],
    ]);
    const res = await client().listResources("netlify-dns-record", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:netlify-dns-record:zone1/rec1");
    expect(res[0]!.displayName).toBe("A www");
    expect(res[0]!.fields["content"]).toBe("1.2.3.4");
  });

  it("record label falls back to id", async () => {
    router([
      [(u) => u.includes("/dns_zones") && !u.includes("/dns_records"), [ZONE]],
      [(u) => u.includes("/dns_records"), [{ id: "recX" }]],
    ]);
    const res = await client().listResources("netlify-dns-record", ACCOUNT);
    expect(res[0]!.displayName).toBe("recX");
  });
});

describe("getResource", () => {
  it("fetches a site directly", async () => {
    router([[(u) => u.includes("/sites/site1"), SITE]]);
    const r = await client().getResource("netlify-site", "acct-1:netlify-site:site1", ACCOUNT);
    expect(r.externalId).toBe("site1");
    expect(calls[0]!.url).toContain("/sites/site1");
  });

  it("falls back to list for non-site types", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [{ id: "zone1", name: "n", created_at: "x", updated_at: "y" }],
      ],
    ]);
    const r = await client().getResource(
      "netlify-dns-zone",
      "acct-1:netlify-dns-zone:zone1",
      ACCOUNT,
    );
    expect(r.externalId).toBe("zone1");
  });

  it("throws when not found", async () => {
    router([[(u) => u.includes("/dns_zones"), []]]);
    await expect(
      client().getResource("netlify-dns-zone", "acct-1:netlify-dns-zone:missing", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveOutput", () => {
  it("site outputs (direct fetch)", async () => {
    const setup = () => router([[(u) => u.includes("/sites/site1"), SITE]]);
    setup();
    expect(
      await client().resolveOutput("netlify-site", "acct-1:netlify-site:site1", "siteId", ACCOUNT),
    ).toBe("site1");
    setup();
    expect(
      await client().resolveOutput(
        "netlify-site",
        "acct-1:netlify-site:site1",
        "siteName",
        ACCOUNT,
      ),
    ).toBe("my-site");
    setup();
    expect(
      await client().resolveOutput("netlify-site", "acct-1:netlify-site:site1", "url", ACCOUNT),
    ).toBe("http://s.netlify.app");
    setup();
    expect(
      await client().resolveOutput("netlify-site", "acct-1:netlify-site:site1", "sslUrl", ACCOUNT),
    ).toBe("https://s.netlify.app");
    setup();
    expect(
      await client().resolveOutput(
        "netlify-site",
        "acct-1:netlify-site:site1",
        "deployHook",
        ACCOUNT,
      ),
    ).toBe("");
  });

  it("deploy outputs", async () => {
    const setup = () =>
      router([
        [(u) => u.includes("/sites") && !u.includes("/deploys"), [SITE]],
        [
          (u) => u.includes("/deploys"),
          [
            {
              id: "dep1",
              state: "ready",
              deploy_ssl_url: "https://d",
              created_at: "x",
              updated_at: "y",
            },
          ],
        ],
      ]);
    setup();
    expect(
      await client().resolveOutput(
        "netlify-deploy",
        "acct-1:netlify-deploy:dep1",
        "deployId",
        ACCOUNT,
      ),
    ).toBe("dep1");
    setup();
    expect(
      await client().resolveOutput(
        "netlify-deploy",
        "acct-1:netlify-deploy:dep1",
        "deployUrl",
        ACCOUNT,
      ),
    ).toBe("https://d");
  });

  it("form / zone / record / hook / env outputs", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/forms"), [SITE]],
      [(u) => u.includes("/forms"), [{ id: "form1", name: "Contact", created_at: "x" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-form",
        "acct-1:netlify-form:site1/form1",
        "formId",
        ACCOUNT,
      ),
    ).toBe("form1");
    router([
      [(u) => u.includes("/sites") && !u.includes("/forms"), [SITE]],
      [(u) => u.includes("/forms"), [{ id: "form1", name: "Contact", created_at: "x" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-form",
        "acct-1:netlify-form:site1/form1",
        "formName",
        ACCOUNT,
      ),
    ).toBe("Contact");

    router([
      [
        (u) => u.includes("/dns_zones"),
        [{ id: "zone1", name: "n", domain: "d.com", created_at: "x", updated_at: "y" }],
      ],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-dns-zone",
        "acct-1:netlify-dns-zone:zone1",
        "domain",
        ACCOUNT,
      ),
    ).toBe("d.com");
    router([
      [
        (u) => u.includes("/dns_zones"),
        [{ id: "zone1", name: "n", domain: "d.com", created_at: "x", updated_at: "y" }],
      ],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-dns-zone",
        "acct-1:netlify-dns-zone:zone1",
        "zoneId",
        ACCOUNT,
      ),
    ).toBe("zone1");

    router([
      [
        (u) => u.includes("/dns_zones") && !u.includes("/dns_records"),
        [{ id: "zone1", name: "n", created_at: "x", updated_at: "y" }],
      ],
      [(u) => u.includes("/dns_records"), [{ id: "rec1", hostname: "www", type: "A" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-dns-record",
        "acct-1:netlify-dns-record:zone1/rec1",
        "recordId",
        ACCOUNT,
      ),
    ).toBe("rec1");
    router([
      [
        (u) => u.includes("/dns_zones") && !u.includes("/dns_records"),
        [{ id: "zone1", name: "n", created_at: "x", updated_at: "y" }],
      ],
      [(u) => u.includes("/dns_records"), [{ id: "rec1", hostname: "www", type: "A" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-dns-record",
        "acct-1:netlify-dns-record:zone1/rec1",
        "hostname",
        ACCOUNT,
      ),
    ).toBe("www");

    router([
      [(u) => u.includes("/sites") && !u.includes("/build_hooks"), [SITE]],
      [(u) => u.includes("/build_hooks"), [{ id: "hook1", title: "t", url: "https://h" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-build-hook",
        "acct-1:netlify-build-hook:site1/hook1",
        "hookId",
        ACCOUNT,
      ),
    ).toBe("hook1");
    router([
      [(u) => u.includes("/sites") && !u.includes("/build_hooks"), [SITE]],
      [(u) => u.includes("/build_hooks"), [{ id: "hook1", title: "t", url: "https://h" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-build-hook",
        "acct-1:netlify-build-hook:site1/hook1",
        "hookUrl",
        ACCOUNT,
      ),
    ).toBe("https://h");

    router([
      [(u) => u.includes("/sites") && !u.includes("/env"), [SITE]],
      [(u) => u.includes("/env"), [{ key: "MYKEY" }]],
    ]);
    expect(
      await client().resolveOutput(
        "netlify-env-var",
        "acct-1:netlify-env-var:site1/MYKEY",
        "envKey",
        ACCOUNT,
      ),
    ).toBe("MYKEY");
  });

  it("throws on unknown output", async () => {
    router([[(u) => u.includes("/sites/site1"), SITE]]);
    await expect(
      client().resolveOutput("netlify-site", "acct-1:netlify-site:site1", "bogus", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  it("site stats with domain + framework", async () => {
    router([[(u) => u.includes("/sites/site1"), SITE]]);
    const stats = await client().fetchDashboardStats(
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    expect(stats[0]).toEqual({ label: "State", value: "current", variant: "status-healthy" });
    expect(stats.find((s) => s.label === "Domain")?.value).toBe("example.com");
    expect(stats.find((s) => s.label === "Framework")?.value).toBe("next");
  });

  it("site stats error variant, no optional fields", async () => {
    router([
      [
        (u) => u.includes("/sites/site1"),
        { id: "site1", name: "n", state: "error", created_at: "x", updated_at: "y" },
      ],
    ]);
    const stats = await client().fetchDashboardStats(
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-error");
    expect(stats).toHaveLength(1);
  });

  it("site stats default variant", async () => {
    router([
      [
        (u) => u.includes("/sites/site1"),
        { id: "site1", name: "n", state: "building", created_at: "x", updated_at: "y" },
      ],
    ]);
    const stats = await client().fetchDashboardStats(
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("default");
  });

  it("dns zone stats", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [{ id: "zone1", name: "n", domain: "d.com", created_at: "x", updated_at: "y" }],
      ],
    ]);
    const stats = await client().fetchDashboardStats(
      "netlify-dns-zone",
      "acct-1:netlify-dns-zone:zone1",
      ACCOUNT,
    );
    expect(stats[0]!.value).toBe("d.com");
  });

  it("returns empty for form type", async () => {
    router([
      [(u) => u.includes("/sites") && !u.includes("/forms"), [SITE]],
      [(u) => u.includes("/forms"), [{ id: "form1", name: "C", created_at: "x" }]],
    ]);
    const stats = await client().fetchDashboardStats(
      "netlify-form",
      "acct-1:netlify-form:site1/form1",
      ACCOUNT,
    );
    expect(stats).toEqual([]);
  });
});

describe("attachResource", () => {
  it("attaches a DNS zone domain as the site's primary custom domain", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [
          {
            id: "zone1",
            name: "example.com",
            domain: "example.com",
            created_at: "x",
            updated_at: "y",
          },
        ],
      ],
      [
        (u, init) => u.includes("/sites/site1") && method(init) === "GET",
        { ...SITE, custom_domain: "", domain_aliases: [] },
      ],
      [(u, init) => u.includes("/sites/site1") && method(init) === "PATCH", SITE],
    ]);
    await client().attachResource(
      "netlify-dns-zone",
      "acct-1:netlify-dns-zone:zone1",
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    const patch = calls.find((c) => c.url.includes("/sites/site1") && method(c.init) === "PATCH");
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch!.init!.body as string)).toEqual({ custom_domain: "example.com" });
  });

  it("adds a DNS zone domain as an alias when the site has a custom domain", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [
          {
            id: "zone1",
            name: "alias.com",
            domain: "alias.com",
            created_at: "x",
            updated_at: "y",
          },
        ],
      ],
      [
        (u, init) => u.includes("/sites/site1") && method(init) === "GET",
        { ...SITE, custom_domain: "example.com", domain_aliases: ["www.example.com"] },
      ],
      [(u, init) => u.includes("/sites/site1") && method(init) === "PATCH", SITE],
    ]);
    await client().attachResource(
      "netlify-dns-zone",
      "acct-1:netlify-dns-zone:zone1",
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    const patch = calls.find((c) => c.url.includes("/sites/site1") && method(c.init) === "PATCH");
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch!.init!.body as string)).toEqual({
      domain_aliases: ["www.example.com", "alias.com"],
    });
  });

  it("does not patch when the domain is already attached", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [
          {
            id: "zone1",
            name: "www.example.com",
            domain: "www.example.com",
            created_at: "x",
            updated_at: "y",
          },
        ],
      ],
      [
        (u, init) => u.includes("/sites/site1") && method(init) === "GET",
        { ...SITE, custom_domain: "example.com", domain_aliases: ["www.example.com"] },
      ],
    ]);
    await client().attachResource(
      "netlify-dns-zone",
      "acct-1:netlify-dns-zone:zone1",
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    expect(calls.some((c) => method(c.init) === "PATCH")).toBe(false);
  });

  it("publishes a deploy to a site", async () => {
    router([
      [(u) => u.includes("/sites?"), [SITE]],
      [
        (u, i) => u.includes("/sites/site1/deploys") && method(i) === "GET",
        [
          {
            id: "dep1",
            site_id: "site1",
            state: "ready",
            deploy_ssl_url: "https://dep1.netlify.app",
            created_at: "x",
            updated_at: "y",
          },
        ],
      ],
      [(u, i) => u.includes("/sites/site1") && method(i) === "GET", SITE],
      [
        (u, i) => u.includes("/sites/site1/deploys/dep1/restore") && method(i) === "POST",
        {
          id: "dep1",
          site_id: "site1",
          state: "ready",
          created_at: "x",
          updated_at: "y",
        },
      ],
    ]);
    await client().attachResource(
      "netlify-deploy",
      "acct-1:netlify-deploy:dep1",
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    expect(
      calls.some(
        (c) => c.url.includes("/sites/site1/deploys/dep1/restore") && method(c.init) === "POST",
      ),
    ).toBe(true);
  });

  it("imports a build hook URL as a site env var", async () => {
    router([
      [(u) => u.includes("/sites?"), [SITE]],
      [
        (u, i) => u.includes("/sites/site1/build_hooks") && method(i) === "GET",
        [{ id: "hook1", title: "CMS", url: "https://hooks.netlify.com/hook" }],
      ],
      [(u, i) => u.includes("/sites/site1") && method(i) === "GET", SITE],
      [(u, i) => u.includes("/sites/site1/env") && method(i) === "POST", [{ key: "K" }]],
    ]);
    await client().attachResource(
      "netlify-build-hook",
      "acct-1:netlify-build-hook:site1/hook1",
      "netlify-site",
      "acct-1:netlify-site:site1",
      ACCOUNT,
    );
    const envCall = calls.find(
      (c) => c.url.includes("/sites/site1/env") && method(c.init) === "POST",
    );
    expect(envCall).toBeTruthy();
    expect(JSON.parse(envCall!.init!.body as string)).toEqual([
      {
        key: "NETLIFY_BUILD_HOOK_URL",
        scopes: ["builds", "functions", "runtime", "post-processing"],
        values: [{ context: "all", value: "https://hooks.netlify.com/hook" }],
      },
    ]);
  });

  it("throws for an unsupported attach pair", async () => {
    await expect(
      client().attachResource(
        "netlify-dns-record",
        "acct-1:netlify-dns-record:zone1/rec1",
        "netlify-site",
        "acct-1:netlify-site:site1",
        ACCOUNT,
      ),
    ).rejects.toThrow(/attachResource not supported/);
  });
});

describe("renderDetail", () => {
  function res(typeId: string, fields: Record<string, unknown>, displayName = "x") {
    return {
      id: "id",
      pluginId: "netlify",
      resourceTypeId: typeId,
      accountId: ACCOUNT,
      displayName,
      externalId: "ext",
      fields,
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    } as never;
  }

  it("site detail with build settings + open action", () => {
    const view = client().renderDetail(
      res("netlify-site", {
        name: "n",
        state: "current",
        customDomain: "ex.com",
        sslUrl: "https://s",
        plan: "pro",
        accountName: "Acme",
        functionsRegion: "us",
        repoUrl: "https://repo",
        repoBranch: "main",
        buildCommand: "build",
        publishDir: "dist",
        framework: "next",
        ssl: true,
        forceSsl: true,
        managedDns: true,
        createdAt: "x",
        updatedAt: "y",
      }),
    );
    expect(view.subtitle).toBe("Netlify Site");
    expect(view.sections.find((s) => "title" in s && s.title === "Build Settings")).toBeTruthy();
    expect((view.headerActions ?? []).map((a) => a.label)).toContain("Open Site");
  });

  it("site detail without build settings or url", () => {
    const view = client().renderDetail(res("netlify-site", { name: "n", state: "current" }));
    expect(view.sections.find((s) => "title" in s && s.title === "Build Settings")).toBeUndefined();
    expect((view.headerActions ?? []).map((a) => a.label)).not.toContain("Open Site");
  });

  it("deploy detail with all fields + open", () => {
    const view = client().renderDetail(
      res("netlify-deploy", {
        state: "ready",
        context: "production",
        branch: "main",
        commitRef: "abcdef123456",
        title: "t",
        framework: "next",
        errorMessage: "oops",
        url: "https://d",
        draft: true,
        locked: true,
        createdAt: "x",
        publishedAt: "y",
      }),
    );
    expect((view.headerActions ?? []).map((a) => a.label)).toContain("Open");
    expect(view.subtitle).toContain("production");
  });

  it("deploy detail minimal", () => {
    const view = client().renderDetail(res("netlify-deploy", { state: "error" }));
    expect((view.headerActions ?? []).map((a) => a.label)).toEqual(["Refresh"]);
  });

  it("form detail", () => {
    const view = client().renderDetail(
      res("netlify-form", { name: "Contact", submissionCount: 3, paths: "/a", createdAt: "x" }),
    );
    expect(view.subtitle).toBe("Netlify Form");
  });

  it("dns zone detail", () => {
    const view = client().renderDetail(
      res("netlify-dns-zone", {
        name: "z",
        domain: "d.com",
        dnsServers: "ns",
        supportedRecordTypes: "A",
        ipv6Enabled: true,
        dedicated: true,
        accountName: "Acme",
        createdAt: "x",
        updatedAt: "y",
      }),
    );
    expect(view.subtitle).toBe("Netlify DNS Zone");
  });

  it("dns record detail (shared helper)", () => {
    const view = client().renderDetail(
      res("netlify-dns-record", { name: "www", type: "A", content: "1.2.3.4", ttl: 300 }),
    );
    expect(view.title).toBeDefined();
  });

  it("build hook detail", () => {
    const view = client().renderDetail(
      res("netlify-build-hook", { title: "CMS", branch: "main", url: "https://h", createdAt: "x" }),
    );
    expect(view.subtitle).toBe("Build Hook");
  });

  it("env var detail secret + non-secret", () => {
    const secret = client().renderDetail(
      res("netlify-env-var", {
        key: "K",
        scopes: "builds",
        contexts: "all",
        isSecret: true,
        updatedAt: "x",
      }),
    );
    expect(secret.subtitle).toContain("secret");
    const visible = client().renderDetail(res("netlify-env-var", { key: "K", isSecret: false }));
    expect(visible.subtitle).toBe("Environment Variable");
  });

  it("generic fallback for unknown type", () => {
    const view = client().renderDetail(res("other", {}));
    expect(view.subtitle).toBe("other");
    expect(view.sections).toEqual([]);
  });
});

describe("renderSidebarItem", () => {
  function res(typeId: string, fields: Record<string, unknown>) {
    return client().renderSidebarItem({
      id: "id",
      displayName: "disp",
      resourceTypeId: typeId,
      fields,
    } as never);
  }

  it("dns record uses shared sidebar", () => {
    const item = res("netlify-dns-record", { name: "www", type: "A", content: "1.2.3.4" });
    expect(item.id).toBe("id");
  });

  it("deploy sidebar with context", () => {
    const item = res("netlify-deploy", { state: "ready", context: "production" });
    expect(item.label).toContain("production");
    expect((item.status as { status: string }).status).toBe("healthy");
  });

  it("deploy sidebar without context falls back to 'deploy'", () => {
    const item = res("netlify-deploy", { state: "skipped" });
    expect(item.label).toContain("deploy");
    expect((item.status as { status: string }).status).toBe("degraded");
  });

  it("env var sidebar secret label", () => {
    const item = res("netlify-env-var", { key: "K", isSecret: true });
    expect(item.label).toBe("K (secret)");
  });

  it("env var sidebar visible", () => {
    const item = res("netlify-env-var", { key: "K", isSecret: false });
    expect(item.label).toBe("K");
  });

  it("default sidebar uses state mapping", () => {
    expect((res("netlify-site", { state: "current" }).status as { status: string }).status).toBe(
      "healthy",
    );
    expect((res("netlify-site", { state: "building" }).status as { status: string }).status).toBe(
      "provisioning",
    );
    expect((res("netlify-site", { state: "error" }).status as { status: string }).status).toBe(
      "error",
    );
    expect((res("netlify-site", { state: "weird" }).status as { status: string }).status).toBe(
      "info",
    );
  });

  it("default sidebar info when no state", () => {
    expect((res("netlify-site", {}).status as { status: string }).status).toBe("info");
  });
});

describe("getCreateConfig", () => {
  it("site config", async () => {
    const cfg = await client().getCreateConfig("netlify-site");
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("dns zone config", async () => {
    const cfg = await client().getCreateConfig("netlify-dns-zone");
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("dns record config without parent fetches zones", async () => {
    router([
      [
        (u) => u.includes("/dns_zones"),
        [{ id: "zone1", name: "ex.com", created_at: "x", updated_at: "y" }],
      ],
    ]);
    const cfg = await client().getCreateConfig("netlify-dns-record");
    const zone = cfg.fields.find((f) => f.key === "zoneId");
    expect(zone?.options?.[0]).toEqual({ id: "zone1", label: "ex.com" });
    expect(zone?.defaultValue).toBe("zone1");
  });

  it("dns record config with parent omits zone field", async () => {
    const cfg = await client().getCreateConfig(
      "netlify-dns-record",
      "acct-1:netlify-dns-zone:zone1",
    );
    expect(cfg.fields.find((f) => f.key === "zoneId")).toBeUndefined();
    expect(cfg.fields[0]!.key).toBe("type");
  });

  it("dns record config handles null zones", async () => {
    router([[(u) => u.includes("/dns_zones"), null]]);
    const cfg = await client().getCreateConfig("netlify-dns-record");
    const zone = cfg.fields.find((f) => f.key === "zoneId");
    expect(zone?.options).toEqual([]);
    expect(zone?.defaultValue).toBeUndefined();
  });

  it("build hook config fetches sites", async () => {
    router([[(u) => u.includes("/sites"), [SITE]]]);
    const cfg = await client().getCreateConfig("netlify-build-hook");
    expect(cfg.fields.find((f) => f.key === "siteId")?.defaultValue).toBe("site1");
  });

  it("build hook config with parent omits site field", async () => {
    const cfg = await client().getCreateConfig("netlify-build-hook", "acct-1:netlify-site:site1");
    expect(cfg.fields[0]!.key).toBe("title");
  });

  it("env var config fetches sites", async () => {
    router([[(u) => u.includes("/sites"), [SITE]]]);
    const cfg = await client().getCreateConfig("netlify-env-var");
    expect(cfg.fields.find((f) => f.key === "siteId")?.options?.[0]?.label).toBe("my-site");
  });

  it("env var config with parent omits site field", async () => {
    const cfg = await client().getCreateConfig("netlify-env-var", "acct-1:netlify-site:site1");
    expect(cfg.fields[0]!.key).toBe("key");
  });

  it("throws for unknown type", async () => {
    await expect(client().getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates a site", async () => {
    router([[(u, i) => method(i) === "POST" && u.endsWith("/sites"), SITE]]);
    const r = await client().createResource("netlify-site", ACCOUNT, { name: "my-site" });
    expect(r.externalId).toBe("site1");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({ name: "my-site" });
  });

  it("creates a dns zone", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.endsWith("/dns_zones"),
        { id: "zone1", name: "ex.com", created_at: "x", updated_at: "y" },
      ],
    ]);
    const r = await client().createResource("netlify-dns-zone", ACCOUNT, { name: "ex.com" });
    expect(r.externalId).toBe("zone1");
  });

  it("creates a dns record with ttl, from field zoneId", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/dns_zones/zone1/dns_records"),
        { id: "rec1", hostname: "www", type: "A", value: "1.2.3.4" },
      ],
    ]);
    const r = await client().createResource("netlify-dns-record", ACCOUNT, {
      zoneId: "zone1",
      type: "A",
      hostname: "www",
      value: "1.2.3.4",
      ttl: "300",
    });
    expect(r.externalId).toBe("rec1");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.ttl).toBe(300);
  });

  it("creates a dns record using parent zoneId, no ttl", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/dns_records"),
        { id: "rec1", hostname: "@", type: "TXT" },
      ],
    ]);
    const r = await client().createResource(
      "netlify-dns-record",
      ACCOUNT,
      { type: "TXT", hostname: "@", value: "v" },
      "acct-1:netlify-dns-zone:zone9",
    );
    expect(calls[0]!.url).toContain("/dns_zones/zone9/dns_records");
    expect(JSON.parse(calls[0]!.init?.body as string).ttl).toBeUndefined();
    expect(r.id).toContain("zone9");
  });

  it("throws when dns record missing zoneId", async () => {
    await expect(
      client().createResource("netlify-dns-record", ACCOUNT, {
        type: "A",
        hostname: "www",
        value: "v",
      }),
    ).rejects.toThrow(/zoneId is required/);
  });

  it("creates a build hook", async () => {
    router([
      [
        (u, i) => method(i) === "POST" && u.includes("/build_hooks"),
        { id: "hook1", title: "CMS", url: "https://h" },
      ],
    ]);
    const r = await client().createResource("netlify-build-hook", ACCOUNT, {
      siteId: "site1",
      title: "CMS",
      branch: "main",
    });
    expect(r.externalId).toBe("hook1");
    expect(JSON.parse(calls[0]!.init?.body as string).branch).toBe("main");
  });

  it("creates a build hook without branch from parent", async () => {
    router([
      [(u, i) => method(i) === "POST" && u.includes("/build_hooks"), { id: "hook1", title: "CMS" }],
    ]);
    await client().createResource(
      "netlify-build-hook",
      ACCOUNT,
      { title: "CMS" },
      "acct-1:netlify-site:siteP",
    );
    expect(calls[0]!.url).toContain("/sites/siteP/build_hooks");
    expect(JSON.parse(calls[0]!.init?.body as string).branch).toBeUndefined();
  });

  it("throws when build hook missing siteId", async () => {
    await expect(
      client().createResource("netlify-build-hook", ACCOUNT, { title: "X" }),
    ).rejects.toThrow(/siteId is required/);
  });

  it("creates an env var (legacy POST)", async () => {
    router([[(u, i) => method(i) === "POST" && u.includes("/sites/site1/env"), [{ key: "K" }]]]);
    const r = await client().createResource("netlify-env-var", ACCOUNT, {
      siteId: "site1",
      key: "K",
      value: "V",
      context: "production",
    });
    expect(r.id).toBe("acct-1:netlify-env-var:site1/K");
    expect(r.fields["contexts"]).toBe("production");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect((body as unknown[])[0]).toEqual(
      expect.objectContaining({ values: [{ context: "production", value: "V" }] }),
    );
  });

  it("creates env var with default context from parent", async () => {
    router([[(u, i) => method(i) === "POST" && u.includes("/env"), [{ key: "K" }]]]);
    const r = await client().createResource(
      "netlify-env-var",
      ACCOUNT,
      { key: "K", value: "V" },
      "acct-1:netlify-site:siteP",
    );
    expect(r.fields["contexts"]).toBe("all");
    expect(r.parentResourceId).toBe("acct-1:netlify-site:siteP");
  });

  it("throws when env var missing siteId", async () => {
    await expect(
      client().createResource("netlify-env-var", ACCOUNT, { key: "K", value: "V" }),
    ).rejects.toThrow(/siteId is required/);
  });

  it("throws for unsupported create type", async () => {
    await expect(client().createResource("netlify-deploy", ACCOUNT, {})).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("deleteResource", () => {
  const ok = () => router([[() => true, null, 204]]);

  it("deletes site", async () => {
    ok();
    await client().deleteResource("netlify-site", "acct-1:netlify-site:site1", ACCOUNT);
    expect(calls[0]!.url).toContain("/sites/site1");
    expect(method(calls[0]!.init)).toBe("DELETE");
  });

  it("deletes deploy", async () => {
    ok();
    await client().deleteResource("netlify-deploy", "acct-1:netlify-deploy:dep1", ACCOUNT);
    expect(calls[0]!.url).toContain("/deploys/dep1");
  });

  it("deletes form", async () => {
    ok();
    await client().deleteResource("netlify-form", "acct-1:netlify-form:site1/form1", ACCOUNT);
    expect(calls[0]!.url).toContain("/sites/site1/forms/form1");
  });

  it("throws on bad form id", async () => {
    await expect(
      client().deleteResource("netlify-form", "acct-1:netlify-form:onlyone", ACCOUNT),
    ).rejects.toThrow(/parse form ID/);
  });

  it("deletes dns zone", async () => {
    ok();
    await client().deleteResource("netlify-dns-zone", "acct-1:netlify-dns-zone:zone1", ACCOUNT);
    expect(calls[0]!.url).toContain("/dns_zones/zone1");
  });

  it("deletes dns record", async () => {
    ok();
    await client().deleteResource(
      "netlify-dns-record",
      "acct-1:netlify-dns-record:zone1/rec1",
      ACCOUNT,
    );
    expect(calls[0]!.url).toContain("/dns_zones/zone1/dns_records/rec1");
  });

  it("throws on bad dns record id", async () => {
    await expect(
      client().deleteResource("netlify-dns-record", "acct-1:netlify-dns-record:onlyone", ACCOUNT),
    ).rejects.toThrow(/parse DNS record ID/);
  });

  it("deletes build hook", async () => {
    ok();
    await client().deleteResource(
      "netlify-build-hook",
      "acct-1:netlify-build-hook:site1/hook1",
      ACCOUNT,
    );
    expect(calls[0]!.url).toContain("/sites/site1/build_hooks/hook1");
  });

  it("throws on bad build hook id", async () => {
    await expect(
      client().deleteResource("netlify-build-hook", "acct-1:netlify-build-hook:onlyone", ACCOUNT),
    ).rejects.toThrow(/parse build hook ID/);
  });

  it("deletes env var (legacy)", async () => {
    ok();
    await client().deleteResource(
      "netlify-env-var",
      "acct-1:netlify-env-var:site1/MY KEY",
      ACCOUNT,
    );
    expect(calls[0]!.url).toContain("/sites/site1/env/MY%20KEY");
  });

  it("throws on bad env var id", async () => {
    await expect(
      client().deleteResource("netlify-env-var", "acct-1:netlify-env-var:noslash", ACCOUNT),
    ).rejects.toThrow(/parse env var/);
  });

  it("throws for unsupported delete type", async () => {
    await expect(client().deleteResource("nope", "acct-1:nope:x", ACCOUNT)).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("error handling", () => {
  it("throws vendor error on non-ok", async () => {
    router([[() => true, "boom", 500]]);
    await expect(client().listResources("netlify-site", ACCOUNT)).rejects.toThrow(
      /Netlify API error 500/,
    );
  });
});
