import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];

/** Queue of responders keyed by URL substring match, evaluated in order. */
type Responder = (url: string, init?: RequestInit) => unknown | { __status: number };

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

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function client(creds: Record<string, string> = { accessToken: "tok" }, services?: unknown) {
  return new VercelClient(creds, services as never);
}

describe("constructor", () => {
  it("throws without accessToken", () => {
    expect(() => new VercelClient({})).toThrow(/missing accessToken/);
  });

  it("sends Authorization header and base url", async () => {
    installFetch(() => jsonResponse({ projects: [] }));
    await client().listResources("vercel-project", ACCOUNT);
    expect(calls[0]!.url).toContain("https://api.vercel.com/v9/projects");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
  });

  it("appends teamId query param when configured", async () => {
    installFetch(() => jsonResponse({ projects: [] }));
    await client({ accessToken: "tok", teamId: "team_x" }).listResources("vercel-project", ACCOUNT);
    expect(calls[0]!.url).toContain("teamId=team_x");
    expect(calls[0]!.url).toContain("&"); // teamId appended after limit param uses & separator
  });
});

describe("caCert + host http service path", () => {
  it("routes through host http when caCert and services.http provided", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ projects: [] }) }));
    const spy = installFetch(() => jsonResponse({}));
    await client({ accessToken: "tok", caCert: "PEM" }, { http: { request } }).listResources(
      "vercel-project",
      ACCOUNT,
    );
    expect(request).toHaveBeenCalled();
    const arg = (request.mock.calls as unknown as [unknown[]])[0]![0] as {
      url: string;
      caCert?: string;
    };
    expect(arg.url).toContain("/v9/projects");
    expect(arg.caCert).toBe("PEM");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("listResources dispatch + mappers", () => {
  it("maps projects with pagination and derived fields", async () => {
    let page = 0;
    installFetch(() => {
      page += 1;
      if (page === 1) {
        return jsonResponse({
          projects: [
            {
              id: "p1",
              name: "proj-one",
              framework: "nextjs",
              nodeVersion: "20.x",
              serverlessFunctionRegion: "iad1",
              rootDirectory: null,
              buildCommand: "npm run build",
              outputDirectory: ".next",
              createdAt: 1700000000000,
              updatedAt: 1700000100000,
              live: true,
              link: { org: "acme", repo: "site" },
              alias: [{ domain: "acme.com" }],
              latestDeployments: [{ url: "dep.vercel.app" }],
            },
          ],
          pagination: { next: 1699999999999 },
        });
      }
      return jsonResponse({ projects: [], pagination: { next: null } });
    });
    const res = await client().listResources("vercel-project", ACCOUNT);
    expect(res).toHaveLength(1);
    const p = res[0]!;
    expect(p.id).toBe("acct-1:vercel-project:p1");
    expect(p.resourceTypeId).toBe("vercel-project");
    expect(p.externalId).toBe("p1");
    expect(p.fields["gitRepo"]).toBe("acme/site");
    expect(p.fields["productionUrl"]).toBe("https://acme.com");
    expect(p.fields["live"]).toBe(true);
    // second page fetched then stopped
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toContain("until=1699999999999");
  });

  it("falls back to latestDeployments url when no alias", async () => {
    installFetch(() =>
      jsonResponse({
        projects: [
          {
            id: "p2",
            name: "p2",
            createdAt: 1,
            latestDeployments: [{ url: "x.vercel.app" }],
          },
        ],
        pagination: { next: null },
      }),
    );
    const res = await client().listResources("vercel-project", ACCOUNT);
    expect(res[0]!.fields["productionUrl"]).toBe("https://x.vercel.app");
    expect(res[0]!.fields["gitRepo"]).toBeUndefined();
  });

  it("maps deployments", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [
          {
            uid: "d1",
            name: "dep",
            url: "dep.vercel.app",
            readyState: "READY",
            target: "production",
            source: "git",
            projectId: "p1",
            created: 1700000000000,
            ready: 1700000050000,
            inspectorUrl: "https://inspect",
            creator: { uid: "u1", email: "a@b.com" },
            meta: {
              githubCommitRef: "main",
              githubCommitSha: "abc",
              githubCommitMessage: "fix",
            },
            projectSettings: { framework: "nextjs" },
          },
        ],
        pagination: { next: null },
      }),
    );
    const res = await client().listResources("vercel-deployment", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:vercel-deployment:d1");
    expect(res[0]!.fields["url"]).toBe("https://dep.vercel.app");
    expect(res[0]!.fields["state"]).toBe("READY");
    expect(res[0]!.fields["gitBranch"]).toBe("main");
    expect(res[0]!.fields["creatorEmail"]).toBe("a@b.com");
  });

  it("maps deployment with minimal fields (username fallback, no url)", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [
          { uid: "d2", name: "n", url: null, created: 1, creator: { uid: "u", username: "bob" } },
        ],
        pagination: { next: null },
      }),
    );
    const res = await client().listResources("vercel-deployment", ACCOUNT);
    expect(res[0]!.displayName).toBe("n");
    expect(res[0]!.fields["creatorEmail"]).toBe("bob");
    expect(res[0]!.fields["state"]).toBe("UNKNOWN");
    expect(res[0]!.fields["url"]).toBeUndefined();
  });

  it("maps domains", async () => {
    installFetch(() =>
      jsonResponse({
        domains: [
          {
            id: "dom1",
            name: "example.com",
            verified: true,
            serviceType: "external",
            nameservers: ["ns1", "ns2"],
            intendedNameservers: ["ins1"],
            renew: true,
            expiresAt: 1800000000000,
            boughtAt: 1700000000000,
            createdAt: 1690000000000,
          },
        ],
        pagination: { next: null },
      }),
    );
    const res = await client().listResources("vercel-domain", ACCOUNT);
    expect(res[0]!.fields["nameservers"]).toBe("ns1, ns2");
    expect(res[0]!.fields["verified"]).toBe("true");
    expect(res[0]!.fields["renew"]).toBe("true");
  });

  it("maps domain with null renew/expiry", async () => {
    installFetch(() =>
      jsonResponse({
        domains: [
          {
            id: "dom2",
            name: "x.com",
            verified: false,
            serviceType: "zeit",
            nameservers: [],
            intendedNameservers: [],
            expiresAt: null,
            boughtAt: null,
            createdAt: 1,
          },
        ],
        pagination: { next: null },
      }),
    );
    const res = await client().listResources("vercel-domain", ACCOUNT);
    expect(res[0]!.fields["renew"]).toBeUndefined();
    expect(res[0]!.fields["expiresAt"]).toBe("—");
  });

  it("lists env vars across projects, skips projects that error", async () => {
    installFetch((url) => {
      if (url.includes("/v9/projects")) {
        return jsonResponse({
          projects: [
            { id: "p1", name: "one", createdAt: 1 },
            { id: "p2", name: "two", createdAt: 1 },
          ],
          pagination: { next: null },
        });
      }
      if (url.includes("/v10/projects/p1/env")) {
        return jsonResponse({
          envs: [
            {
              id: "e1",
              key: "API_KEY",
              value: "secret",
              type: "encrypted",
              target: ["production", "preview"],
              gitBranch: "main",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        });
      }
      // p2 -> forbidden
      return jsonResponse("forbidden", 403);
    });
    const res = await client().listResources("vercel-env-var", ACCOUNT);
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe("acct-1:vercel-env-var:p1/e1");
    expect(res[0]!.fields["target"]).toBe("production, preview");
    expect(res[0]!.fields["projectName"]).toBe("one");
    expect(res[0]!.parentResourceId).toBe("acct-1:vercel-project:p1");
  });

  it("env var falls back to composite id and string target", async () => {
    installFetch((url) => {
      if (url.includes("/v9/projects")) {
        return jsonResponse({
          projects: [{ id: "p1", name: "one", createdAt: 1 }],
          pagination: { next: null },
        });
      }
      return jsonResponse({ envs: [{ key: "FOO", type: "plain", target: "production" }] });
    });
    const res = await client().listResources("vercel-env-var", ACCOUNT);
    expect(res[0]!.externalId).toBe("p1/FOO");
    expect(res[0]!.fields["target"]).toBe("production");
  });

  it("env var handles missing envs array and undefined target", async () => {
    installFetch((url) => {
      if (url.includes("/v9/projects")) {
        return jsonResponse({
          projects: [{ id: "p1", name: "one", createdAt: 1 }],
          pagination: { next: null },
        });
      }
      return jsonResponse({});
    });
    const res = await client().listResources("vercel-env-var", ACCOUNT);
    expect(res).toHaveLength(0);
  });

  it("lists teams", async () => {
    installFetch(() =>
      jsonResponse({
        teams: [{ id: "t1", name: "Team", slug: "team", createdAt: 1, updatedAt: 2 }],
      }),
    );
    const res = await client().listResources("vercel-team", ACCOUNT);
    expect(res[0]!.id).toBe("acct-1:vercel-team:t1");
    expect(res[0]!.fields["slug"]).toBe("team");
  });

  it("returns empty teams when request fails", async () => {
    installFetch(() => jsonResponse("nope", 403));
    const res = await client().listResources("vercel-team", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("returns empty teams when teams field missing", async () => {
    installFetch(() => jsonResponse({}));
    const res = await client().listResources("vercel-team", ACCOUNT);
    expect(res).toEqual([]);
  });

  it("throws on unknown type", async () => {
    installFetch(() => jsonResponse({}));
    await expect(client().listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });

  it("paginate stops when dataKey is not an array", async () => {
    installFetch(() => jsonResponse({ projects: "notarray" }));
    const res = await client().listResources("vercel-project", ACCOUNT);
    expect(res).toEqual([]);
  });
});

describe("getResource", () => {
  it("fetches a single project directly", async () => {
    installFetch(() => jsonResponse({ id: "p1", name: "proj", createdAt: 1 }));
    const r = await client().getResource("vercel-project", "acct-1:vercel-project:p1", ACCOUNT);
    expect(r.externalId).toBe("p1");
    expect(calls[0]!.url).toContain("/v9/projects/p1");
  });

  it("falls back to listing for non-project types", async () => {
    installFetch(() =>
      jsonResponse({ teams: [{ id: "t1", name: "T", slug: "t", createdAt: 1, updatedAt: 1 }] }),
    );
    const r = await client().getResource("vercel-team", "acct-1:vercel-team:t1", ACCOUNT);
    expect(r.externalId).toBe("t1");
  });

  it("throws when fallback resource not found", async () => {
    installFetch(() => jsonResponse({ teams: [] }));
    await expect(
      client().getResource("vercel-team", "acct-1:vercel-team:missing", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveOutput", () => {
  async function setupProject() {
    installFetch(() =>
      jsonResponse({
        id: "p1",
        name: "proj",
        createdAt: 1,
        alias: [{ domain: "x.com" }],
      }),
    );
    return client();
  }

  it("resolves project outputs", async () => {
    const c = await setupProject();
    expect(
      await c.resolveOutput("vercel-project", "acct-1:vercel-project:p1", "projectId", ACCOUNT),
    ).toBe("p1");
    const c2 = await setupProject();
    expect(
      await c2.resolveOutput("vercel-project", "acct-1:vercel-project:p1", "projectName", ACCOUNT),
    ).toBe("proj");
    const c3 = await setupProject();
    expect(
      await c3.resolveOutput(
        "vercel-project",
        "acct-1:vercel-project:p1",
        "productionUrl",
        ACCOUNT,
      ),
    ).toBe("https://x.com");
  });

  it("resolves deployment outputs", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [
          { uid: "d1", name: "n", url: "u.app", created: 1, inspectorUrl: "https://i" },
        ],
        pagination: { next: null },
      }),
    );
    const c = client();
    expect(
      await c.resolveOutput(
        "vercel-deployment",
        "acct-1:vercel-deployment:d1",
        "deploymentId",
        ACCOUNT,
      ),
    ).toBe("d1");
  });

  it("resolves deployment url and inspectorUrl", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [
          { uid: "d1", name: "n", url: "u.app", created: 1, inspectorUrl: "https://i" },
        ],
        pagination: { next: null },
      }),
    );
    expect(
      await client().resolveOutput(
        "vercel-deployment",
        "acct-1:vercel-deployment:d1",
        "url",
        ACCOUNT,
      ),
    ).toBe("https://u.app");
    expect(
      await client().resolveOutput(
        "vercel-deployment",
        "acct-1:vercel-deployment:d1",
        "inspectorUrl",
        ACCOUNT,
      ),
    ).toBe("https://i");
  });

  it("resolves domain outputs", async () => {
    installFetch(() =>
      jsonResponse({
        domains: [
          {
            id: "dom1",
            name: "d.com",
            verified: true,
            serviceType: "x",
            nameservers: ["ns1"],
            intendedNameservers: [],
            createdAt: 1,
            expiresAt: null,
            boughtAt: null,
          },
        ],
        pagination: { next: null },
      }),
    );
    expect(
      await client().resolveOutput(
        "vercel-domain",
        "acct-1:vercel-domain:dom1",
        "domainName",
        ACCOUNT,
      ),
    ).toBe("d.com");
    expect(
      await client().resolveOutput(
        "vercel-domain",
        "acct-1:vercel-domain:dom1",
        "nameservers",
        ACCOUNT,
      ),
    ).toBe("ns1");
  });

  it("resolves env-var outputs", async () => {
    installFetch((url) => {
      if (url.includes("/v9/projects"))
        return jsonResponse({
          projects: [{ id: "p1", name: "one", createdAt: 1 }],
          pagination: { next: null },
        });
      return jsonResponse({
        envs: [{ id: "e1", key: "K", value: "V", type: "plain", target: "production" }],
      });
    });
    expect(
      await client().resolveOutput(
        "vercel-env-var",
        "acct-1:vercel-env-var:p1/e1",
        "envKey",
        ACCOUNT,
      ),
    ).toBe("K");
    installFetch((url) => {
      if (url.includes("/v9/projects"))
        return jsonResponse({
          projects: [{ id: "p1", name: "one", createdAt: 1 }],
          pagination: { next: null },
        });
      return jsonResponse({
        envs: [{ id: "e1", key: "K", value: "V", type: "plain", target: "production" }],
      });
    });
    expect(
      await client().resolveOutput(
        "vercel-env-var",
        "acct-1:vercel-env-var:p1/e1",
        "envValue",
        ACCOUNT,
      ),
    ).toBe("V");
  });

  it("resolves team outputs", async () => {
    installFetch(() =>
      jsonResponse({ teams: [{ id: "t1", name: "T", slug: "ts", createdAt: 1, updatedAt: 1 }] }),
    );
    expect(
      await client().resolveOutput("vercel-team", "acct-1:vercel-team:t1", "teamId", ACCOUNT),
    ).toBe("t1");
    installFetch(() =>
      jsonResponse({ teams: [{ id: "t1", name: "T", slug: "ts", createdAt: 1, updatedAt: 1 }] }),
    );
    expect(
      await client().resolveOutput("vercel-team", "acct-1:vercel-team:t1", "teamSlug", ACCOUNT),
    ).toBe("ts");
  });

  it("throws on unknown output key", async () => {
    installFetch(() => jsonResponse({ id: "p1", name: "n", createdAt: 1 }));
    await expect(
      client().resolveOutput("vercel-project", "acct-1:vercel-project:p1", "bogus", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  it("project stats", async () => {
    installFetch(() =>
      jsonResponse({
        id: "p1",
        name: "n",
        framework: "nextjs",
        nodeVersion: "20.x",
        serverlessFunctionRegion: "iad1",
        live: true,
        createdAt: 1,
      }),
    );
    const stats = await client().fetchDashboardStats(
      "vercel-project",
      "acct-1:vercel-project:p1",
      ACCOUNT,
    );
    const labels = stats.map((s) => s.label);
    expect(labels).toContain("Framework");
    expect(labels).toContain("Region");
    expect(labels).toContain("Node.js");
    const live = stats.find((s) => s.label === "Live");
    expect(live?.value).toBe("Yes");
    expect(live?.variant).toBe("status-healthy");
  });

  it("project stats when not live and no optional fields", async () => {
    installFetch(() => jsonResponse({ id: "p1", name: "n", createdAt: 1 }));
    const stats = await client().fetchDashboardStats(
      "vercel-project",
      "acct-1:vercel-project:p1",
      ACCOUNT,
    );
    const live = stats.find((s) => s.label === "Live");
    expect(live?.value).toBe("No");
    expect(live?.variant).toBe("status-degraded");
  });

  it("deployment stats with target", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [
          { uid: "d1", name: "n", url: "u", readyState: "BUILDING", target: "preview", created: 1 },
        ],
        pagination: { next: null },
      }),
    );
    const stats = await client().fetchDashboardStats(
      "vercel-deployment",
      "acct-1:vercel-deployment:d1",
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-degraded");
    expect(stats.find((s) => s.label === "Target")?.value).toBe("preview");
  });

  it("deployment stats error/unknown variants", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [{ uid: "d1", name: "n", url: "u", readyState: "ERROR", created: 1 }],
        pagination: { next: null },
      }),
    );
    let stats = await client().fetchDashboardStats(
      "vercel-deployment",
      "acct-1:vercel-deployment:d1",
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("status-error");

    installFetch(() =>
      jsonResponse({
        deployments: [{ uid: "d1", name: "n", url: "u", readyState: "WEIRD", created: 1 }],
        pagination: { next: null },
      }),
    );
    stats = await client().fetchDashboardStats(
      "vercel-deployment",
      "acct-1:vercel-deployment:d1",
      ACCOUNT,
    );
    expect(stats[0]!.variant).toBe("default");
  });

  it("domain stats", async () => {
    installFetch(() =>
      jsonResponse({
        domains: [
          {
            id: "dom1",
            name: "d.com",
            verified: true,
            serviceType: "external",
            nameservers: [],
            intendedNameservers: [],
            createdAt: 1,
            expiresAt: null,
            boughtAt: null,
          },
        ],
        pagination: { next: null },
      }),
    );
    const stats = await client().fetchDashboardStats(
      "vercel-domain",
      "acct-1:vercel-domain:dom1",
      ACCOUNT,
    );
    expect(stats[0]!.value).toBe("Yes");
    expect(stats[0]!.variant).toBe("status-healthy");
  });

  it("returns empty for env-var type", async () => {
    installFetch((url) => {
      if (url.includes("/v9/projects"))
        return jsonResponse({
          projects: [{ id: "p1", name: "one", createdAt: 1 }],
          pagination: { next: null },
        });
      return jsonResponse({
        envs: [{ id: "e1", key: "K", value: "V", type: "plain", target: "production" }],
      });
    });
    const stats = await client().fetchDashboardStats(
      "vercel-env-var",
      "acct-1:vercel-env-var:p1/e1",
      ACCOUNT,
    );
    expect(stats).toEqual([]);
  });
});

describe("renderDetail", () => {
  function project(fields: Record<string, unknown> = {}) {
    return {
      id: "acct-1:vercel-project:p1",
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      accountId: ACCOUNT,
      displayName: "proj",
      externalId: "p1",
      fields: {
        name: "proj",
        live: true,
        productionUrl: "https://x.com",
        framework: "nextjs",
        ...fields,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
  }

  it("renders project detail with production url + visit action", () => {
    const view = client({ accessToken: "t", teamId: "team_x" }).renderDetail(project() as never);
    expect(view.title).toBe("proj");
    expect(view.subtitle).toContain("nextjs");
    const actionLabels = (view.headerActions ?? []).map((a) => a.label);
    expect(actionLabels).toContain("Visit Site");
    const open = view.headerActions?.find((a) => a.label === "Open in Vercel");
    expect((open?.action as { url: string }).url).toContain("team_x/");
  });

  it("renders project detail without production url", () => {
    const view = client().renderDetail(
      project({ productionUrl: "", live: false, framework: undefined }) as never,
    );
    const actionLabels = (view.headerActions ?? []).map((a) => a.label);
    expect(actionLabels).not.toContain("Visit Site");
    expect(view.subtitle).toBe("Vercel Project");
  });

  it("renders deployment detail with inspector + visit", () => {
    const r = {
      resourceTypeId: "vercel-deployment",
      displayName: "dep",
      externalId: "d1",
      fields: {
        state: "READY",
        url: "https://u",
        inspectorUrl: "https://i",
        target: "production",
        gitCommitSha: "abc",
      },
    };
    const view = client().renderDetail(r as never);
    const labels = (view.headerActions ?? []).map((a) => a.label);
    expect(labels).toContain("Open Inspector");
    expect(labels).toContain("Visit Deployment");
  });

  it("renders deployment detail without urls", () => {
    const r = {
      resourceTypeId: "vercel-deployment",
      displayName: "dep",
      externalId: "d1",
      fields: { state: "ERROR" },
    };
    const view = client().renderDetail(r as never);
    const labels = (view.headerActions ?? []).map((a) => a.label);
    expect(labels).toEqual(["Refresh"]);
  });

  it("renders domain detail", () => {
    const r = {
      resourceTypeId: "vercel-domain",
      displayName: "d.com",
      externalId: "dom1",
      fields: { name: "d.com", verified: "true", serviceType: "external", nameservers: "ns1" },
    };
    const view = client().renderDetail(r as never);
    expect(view.subtitle).toContain("Verified");
  });

  it("renders env-var detail", () => {
    const r = {
      resourceTypeId: "vercel-env-var",
      displayName: "K",
      externalId: "e1",
      fields: { key: "K", type: "encrypted", value: "v" },
    };
    const view = client().renderDetail(r as never);
    expect(view.subtitle).toContain("encrypted");
  });

  it("renders team detail", () => {
    const r = {
      resourceTypeId: "vercel-team",
      displayName: "T",
      externalId: "t1",
      fields: { name: "T", slug: "ts" },
    };
    const view = client().renderDetail(r as never);
    expect(view.subtitle).toContain("ts");
  });

  it("renders generic detail for unknown type", () => {
    const r = {
      resourceTypeId: "other",
      displayName: "x",
      externalId: "x",
      fields: { a: "1", b: 2 },
    };
    const view = client().renderDetail(r as never);
    expect(view.subtitle).toBe("other");
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

  it("deployment status", () => {
    expect(
      (item("vercel-deployment", { state: "READY" }).status as { status: string }).status,
    ).toBe("healthy");
    expect(
      (item("vercel-deployment", { state: "BUILDING" }).status as { status: string }).status,
    ).toBe("provisioning");
    expect(
      (item("vercel-deployment", { state: "CANCELED" }).status as { status: string }).status,
    ).toBe("error");
    expect(
      (item("vercel-deployment", { state: "OTHER" }).status as { status: string }).status,
    ).toBe("info");
  });

  it("domain status", () => {
    expect((item("vercel-domain", { verified: "true" }).status as { status: string }).status).toBe(
      "healthy",
    );
    expect((item("vercel-domain", { verified: "false" }).status as { status: string }).status).toBe(
      "degraded",
    );
  });

  it("project status", () => {
    expect((item("vercel-project", { live: true }).status as { status: string }).status).toBe(
      "healthy",
    );
    expect((item("vercel-project", { live: false }).status as { status: string }).status).toBe(
      "degraded",
    );
  });

  it("team and env-var status", () => {
    expect((item("vercel-team", {}).status as { status: string }).status).toBe("healthy");
    expect((item("vercel-env-var", {}).status as { status: string }).status).toBe("healthy");
  });
});

describe("getCreateConfig", () => {
  it("project config", async () => {
    const cfg = await client().getCreateConfig("vercel-project");
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("domain config", async () => {
    const cfg = await client().getCreateConfig("vercel-domain");
    expect(cfg.fields[0]!.key).toBe("name");
  });

  it("env-var config fetches projects for select", async () => {
    installFetch(() =>
      jsonResponse({
        projects: [{ id: "p1", name: "one", createdAt: 1 }],
        pagination: { next: null },
      }),
    );
    const cfg = await client().getCreateConfig("vercel-env-var");
    const project = cfg.fields.find((f) => f.key === "projectId");
    expect(project?.options?.[0]).toEqual({ id: "p1", label: "one" });
  });

  it("team config", async () => {
    const cfg = await client().getCreateConfig("vercel-team");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "slug"]);
  });

  it("throws for unknown type", async () => {
    await expect(client().getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates a project with optional fields", async () => {
    installFetch(() => jsonResponse({ id: "p1", name: "proj", framework: "nextjs", createdAt: 1 }));
    const r = await client().createResource("vercel-project", ACCOUNT, {
      name: "proj",
      framework: "nextjs",
      buildCommand: "build",
      outputDirectory: "out",
      rootDirectory: "root",
    });
    expect(r.externalId).toBe("p1");
    expect(calls[0]!.url).toContain("/v10/projects");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toEqual({
      name: "proj",
      framework: "nextjs",
      buildCommand: "build",
      outputDirectory: "out",
      rootDirectory: "root",
    });
  });

  it("creates project with only required name", async () => {
    installFetch(() => jsonResponse({ id: "p1", name: "proj", createdAt: 1 }));
    await client().createResource("vercel-project", ACCOUNT, { name: "proj" });
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ name: "proj" });
  });

  it("creates a domain (envelope) ", async () => {
    installFetch(() =>
      jsonResponse({ domain: { name: "ex.com", verified: true, serviceType: "external" } }),
    );
    const r = await client().createResource("vercel-domain", ACCOUNT, { name: "ex.com" });
    expect(r.externalId).toBe("ex.com");
    expect(r.fields["verified"]).toBe("true");
    expect(calls[0]!.url).toContain("/v5/domains");
  });

  it("creates a domain (no envelope, defaults)", async () => {
    installFetch(() => jsonResponse({ somethingElse: true }));
    const r = await client().createResource("vercel-domain", ACCOUNT, { name: "ex.com" });
    expect(r.externalId).toBe("ex.com");
    expect(r.fields["verified"]).toBe("false");
  });

  it("creates an env var", async () => {
    installFetch(() => jsonResponse({ id: "env_1" }));
    const r = await client().createResource("vercel-env-var", ACCOUNT, {
      projectId: "p1",
      key: "K",
      value: "V",
      type: "plain",
      target: "preview",
    });
    expect(r.externalId).toBe("env_1");
    expect(r.parentResourceId).toBe("acct-1:vercel-project:p1");
    expect(calls[0]!.url).toContain("/v10/projects/p1/env");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.target).toEqual(["preview"]);
  });

  it("creates env var with defaults and composite id", async () => {
    installFetch(() => jsonResponse({}));
    const r = await client().createResource("vercel-env-var", ACCOUNT, {
      projectId: "p1",
      key: "K",
      value: "V",
    });
    expect(r.externalId).toBe("p1/K");
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.type).toBe("encrypted");
    expect(body.target).toEqual(["production"]);
  });

  it("creates a team", async () => {
    installFetch(() => jsonResponse({ id: "t1", slug: "ts", name: "T" }));
    const r = await client().createResource("vercel-team", ACCOUNT, { name: "T", slug: "ts" });
    expect(r.externalId).toBe("t1");
    expect(r.resolvedOutputs).toEqual({ teamId: "t1", teamSlug: "ts" });
    expect(calls[0]!.url).toContain("/v1/teams");
  });

  it("creates a team falling back to provided slug", async () => {
    installFetch(() => jsonResponse({ id: "t1" }));
    const r = await client().createResource("vercel-team", ACCOUNT, { name: "T", slug: "myslug" });
    expect(r.fields["slug"]).toBe("myslug");
  });

  it("throws for unsupported type", async () => {
    await expect(client().createResource("vercel-deployment", ACCOUNT, {})).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("deleteResource", () => {
  it("deletes project", async () => {
    installFetch(() => jsonResponse(null, 204));
    await client().deleteResource("vercel-project", "acct-1:vercel-project:p1", ACCOUNT);
    expect(calls[0]!.url).toContain("/v9/projects/p1");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("deletes deployment", async () => {
    installFetch(() => jsonResponse(null, 204));
    await client().deleteResource("vercel-deployment", "acct-1:vercel-deployment:d1", ACCOUNT);
    expect(calls[0]!.url).toContain("/v13/deployments/d1");
  });

  it("deletes domain", async () => {
    installFetch(() => jsonResponse(null, 204));
    await client().deleteResource("vercel-domain", "acct-1:vercel-domain:dom1", ACCOUNT);
    expect(calls[0]!.url).toContain("/v6/domains/dom1");
  });

  it("deletes env var", async () => {
    installFetch(() => jsonResponse(null, 204));
    await client().deleteResource("vercel-env-var", "acct-1:vercel-env-var:p1/e1", ACCOUNT);
    expect(calls[0]!.url).toContain("/v9/projects/p1/env/e1");
  });

  it("throws on malformed env-var id (no slash)", async () => {
    installFetch(() => jsonResponse(null, 204));
    await expect(
      client().deleteResource("vercel-env-var", "acct-1:vercel-env-var:noslash", ACCOUNT),
    ).rejects.toThrow(/Invalid env var resource ID/);
  });

  it("throws on env-var id with empty parts", async () => {
    installFetch(() => jsonResponse(null, 204));
    await expect(
      client().deleteResource("vercel-env-var", "acct-1:vercel-env-var:/e1", ACCOUNT),
    ).rejects.toThrow(/Invalid env var resource ID/);
  });

  it("throws for unsupported type", async () => {
    await expect(
      client().deleteResource("vercel-team", "acct-1:vercel-team:t1", ACCOUNT),
    ).rejects.toThrow(/not supported/);
  });
});

describe("attachResource", () => {
  it("adds a domain to a project", async () => {
    installFetch((url) => {
      if (url.includes("/v5/domains")) {
        return jsonResponse({
          domains: [
            {
              id: "dom1",
              name: "example.com",
              verified: true,
              serviceType: "external",
              nameservers: [],
              intendedNameservers: [],
              expiresAt: null,
              boughtAt: null,
              createdAt: 1,
            },
          ],
        });
      }
      if (url.includes("/v9/projects/p1")) {
        return jsonResponse({ id: "p1", name: "proj", createdAt: 1 });
      }
      return jsonResponse({});
    });
    await client({ accessToken: "tok", teamId: "team_x" }).attachResource(
      "vercel-domain",
      "acct-1:vercel-domain:dom1",
      "vercel-project",
      "acct-1:vercel-project:p1",
      ACCOUNT,
    );
    const attachCall = calls.find((c) => c.url.includes("/v10/projects/p1/domains"));
    expect(attachCall).toBeTruthy();
    expect(attachCall!.url).toContain("teamId=team_x");
    expect(attachCall!.init?.method).toBe("POST");
    expect(JSON.parse(attachCall!.init?.body as string)).toEqual({ name: "example.com" });
  });

  it("throws for unsupported attach pair", async () => {
    installFetch(() => jsonResponse({}));
    await expect(
      client().attachResource(
        "vercel-env-var",
        "acct-1:vercel-env-var:p1/e1",
        "vercel-project",
        "acct-1:vercel-project:p1",
        ACCOUNT,
      ),
    ).rejects.toThrow(/attachResource not supported/);
  });
});

describe("error handling", () => {
  it("throws vendor error on non-ok response", async () => {
    installFetch(() => jsonResponse("boom", 500));
    await expect(client().listResources("vercel-project", ACCOUNT)).rejects.toThrow(
      /Vercel API error 500/,
    );
  });
});
