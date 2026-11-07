import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostServices } from "@infrawrench/plugin-base";
import { InfisicalClient } from "../client.js";
import { normalizeSiteUrl } from "../api.js";
import { parseStatusFeed } from "../status-feed.js";
import { infisicalTerraformExport } from "../terraform.js";

const ACCOUNT = "acct";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];

function services(handler: (call: Call) => { status?: number; body: unknown }): HostServices {
  return {
    http: {
      request: async (req) => {
        const call: Call = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        };
        calls.push(call);
        const res = handler(call);
        return {
          status: res.status ?? 200,
          headers: {},
          body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
      },
    },
  };
}

const LOGIN = {
  accessToken: "tok-1",
  expiresIn: 7200,
  accessTokenMaxTTL: 7200,
  tokenType: "Bearer",
};

const PROJECT = {
  id: "proj-1",
  name: "Backend",
  slug: "backend",
  type: "secret-manager",
  createdAt: "2026-01-01T00:00:00Z",
  environments: [
    { id: "env-dev", name: "Development", slug: "dev" },
    { id: "env-prod", name: "Production", slug: "prod" },
  ],
};

function client(handler: (call: Call) => { status?: number; body: unknown }) {
  return hostClient(
    new InfisicalClient(
      { siteUrl: "eu.infisical.com/", clientId: "cid", clientSecret: "csecret" },
      services((call) => {
        if (call.url.endsWith("/api/v1/auth/universal-auth/login")) return { body: LOGIN };
        if (call.url.includes("/api/v1/projects") && !call.url.includes("/api/v1/projects/")) {
          return { body: { projects: [PROJECT] } };
        }
        return handler(call);
      }),
    ),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("requires a client id and secret", () => {
    expect(() => hostClient(new InfisicalClient({ clientSecret: "x" }))).toThrow(/clientId/);
    expect(() => hostClient(new InfisicalClient({ clientId: "x" }))).toThrow(/clientSecret/);
  });

  it("normalizes the instance URL", () => {
    expect(normalizeSiteUrl("")).toBe("https://app.infisical.com");
    expect(normalizeSiteUrl("eu.infisical.com/")).toBe("https://eu.infisical.com");
    expect(normalizeSiteUrl("https://vault.acme.dev/api/")).toBe("https://vault.acme.dev");
    expect(normalizeSiteUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });
});

describe("auth", () => {
  it("logs in with Universal Auth once and sends the bearer token", async () => {
    const c = client(() => ({ body: {} }));
    await c.listResources("project", ACCOUNT);
    await c.listResources("environment", ACCOUNT);
    const logins = calls.filter((x) => x.url.endsWith("/universal-auth/login"));
    expect(logins).toHaveLength(1);
    expect(logins[0]!.url).toBe("https://eu.infisical.com/api/v1/auth/universal-auth/login");
    expect(JSON.parse(logins[0]!.body!)).toEqual({ clientId: "cid", clientSecret: "csecret" });
    const listing = calls.find((x) => x.url.endsWith("/api/v1/projects"))!;
    expect(listing.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("logs in again after a 401 and retries once", async () => {
    let first = true;
    const c = client((call) => {
      if (call.url.includes("/identities/details")) {
        if (first) {
          first = false;
          return { status: 401, body: { message: "Token expired" } };
        }
        return { body: { identityDetails: { organization: { id: "org-1" } } } };
      }
      return { body: { identities: [] } };
    });
    await expect(c.orgId()).resolves.toBe("org-1");
    expect(calls.filter((x) => x.url.endsWith("/universal-auth/login"))).toHaveLength(2);
  });

  it("attaches the HTTP status to API errors", async () => {
    const c = client(() => ({ status: 403, body: { message: "Permission denied" } }));
    const error = (await c.listResources("secret-sync", ACCOUNT).catch((e) => e)) as unknown;
    // A project the identity cannot read is skipped in listings; a direct read surfaces the error.
    expect(error).toEqual([]);
    const direct = await c
      .getResource("machine-identity", `${ACCOUNT}:machine-identity:id-1`, ACCOUNT)
      .catch((e: unknown) => e as Error & { status?: number });
    expect((direct as { status?: number }).status).toBe(403);
    expect((direct as Error).message).toContain("Permission denied");
  });
});

describe("listing", () => {
  it("maps projects and environments with parents", async () => {
    const c = client(() => ({ body: {} }));
    const [project] = await c.listResources("project", ACCOUNT);
    expect(project).toMatchObject({
      id: `${ACCOUNT}:project:proj-1`,
      displayName: "Backend",
      fields: { slug: "backend", environments: "dev, prod", type: "secret-manager" },
      resolvedOutputs: { projectId: "proj-1", slug: "backend" },
    });
    const envs = await c.listResources("environment", ACCOUNT);
    expect(envs.map((e) => e.externalId)).toEqual(["proj-1/env-dev", "proj-1/env-prod"]);
    expect(envs[0]!.parentResourceId).toBe(`${ACCOUNT}:project:proj-1`);
  });

  it("lists secrets without their values, per environment, recursively", async () => {
    const c = client((call) => {
      if (call.url.includes("/api/v4/secrets")) {
        const env = new URL(call.url).searchParams.get("environment");
        return {
          body: {
            secrets: [
              {
                id: `sec-${env}`,
                workspace: "proj-1",
                environment: env,
                secretKey: "DATABASE_URL",
                secretValue: "",
                secretValueHidden: true,
                secretPath: "/api",
                version: 3,
                type: "shared",
              },
              {
                id: "personal",
                workspace: "proj-1",
                environment: env,
                secretKey: "X",
                type: "personal",
              },
            ],
          },
        };
      }
      return { body: {} };
    });
    const secrets = await c.listResources("secret", ACCOUNT);
    expect(secrets).toHaveLength(2);
    expect(secrets[0]).toMatchObject({
      externalId: "sec-dev",
      displayName: "DATABASE_URL (dev:/api)",
      parentResourceId: `${ACCOUNT}:environment:proj-1/env-dev`,
      fields: { key: "DATABASE_URL", path: "/api", environment: "dev", version: 3 },
    });
    const query = new URL(calls.find((x) => x.url.includes("/api/v4/secrets"))!.url).searchParams;
    expect(query.get("viewSecretValue")).toBe("false");
    expect(query.get("recursive")).toBe("true");
    expect(query.get("projectId")).toBe("proj-1");
  });

  it("derives folder paths from recursive listings", async () => {
    const c = client((call) => {
      if (call.url.includes("/api/v2/folders")) {
        return {
          body: {
            folders: [
              { id: "f1", name: "api", relativePath: "/" },
              { id: "f2", name: "workers", relativePath: "/api" },
              { id: "f3", name: "jobs", relativePath: "/api/workers/jobs" },
            ],
          },
        };
      }
      return { body: {} };
    });
    const folders = await c.listResources("folder", ACCOUNT);
    expect(
      folders.filter((f) => f.fields["environment"] === "dev").map((f) => f.fields["path"]),
    ).toEqual(["/api", "/api/workers", "/api/workers/jobs"]);
    expect(folders[0]!.externalId).toBe("proj-1/dev/f1");
  });

  it("probes every folder path for dynamic secrets and encodes the path in the id", async () => {
    const c = client((call) => {
      if (call.url.includes("/api/v2/folders"))
        return { body: { folders: [{ id: "f1", name: "db", relativePath: "/" }] } };
      if (call.url.includes("/api/v1/dynamic-secrets")) {
        const params = new URL(call.url).searchParams;
        if (params.get("path") === "/db" && params.get("environmentSlug") === "prod") {
          return {
            body: {
              dynamicSecrets: [
                { id: "ds1", name: "pg-readonly", type: "sql-database", defaultTTL: "1h" },
              ],
            },
          };
        }
        return { body: { dynamicSecrets: [] } };
      }
      return { body: {} };
    });
    const list = await c.listResources("dynamic-secret", ACCOUNT);
    expect(list).toHaveLength(1);
    expect(list[0]!.externalId).toBe("proj-1/prod/%2Fdb/pg-readonly");
    expect(list[0]!.fields).toMatchObject({
      path: "/db",
      projectSlug: "backend",
      type: "sql-database",
    });
  });

  it("maps secret syncs with their destination name and status", async () => {
    const c = client((call) => {
      if (call.url.endsWith("/api/v1/secret-syncs/options")) {
        return {
          body: {
            secretSyncOptions: [{ name: "GitHub", destination: "github", canImportSecrets: false }],
          },
        };
      }
      if (call.url.includes("/api/v1/secret-syncs")) {
        return {
          body: {
            secretSyncs: [
              {
                id: "s1",
                name: "gh-prod",
                projectId: "proj-1",
                destination: "github",
                syncStatus: "failed",
                lastSyncMessage: "Bad credentials",
                isAutoSyncEnabled: true,
                connection: { name: "acme-gh" },
                environment: { slug: "prod" },
                folder: { path: "/" },
                destinationConfig: { scope: "repository", owner: "acme", repo: "api" },
              },
            ],
          },
        };
      }
      return { body: {} };
    });
    const [sync] = await c.listResources("secret-sync", ACCOUNT);
    expect(sync).toMatchObject({
      externalId: "github/s1",
      parentResourceId: `${ACCOUNT}:project:proj-1`,
      fields: {
        destination: "GitHub",
        connectionName: "acme-gh",
        syncStatus: "failed",
        destinationSummary: "scope=repository, owner=acme, repo=api",
      },
    });
    expect(c.renderSidebarItem(sync!).status?.status).toBe("error");
  });
});

describe("incomplete lists", () => {
  const certProject = { ...PROJECT, id: "cert-1", slug: "pki", type: "cert-manager" };

  /** `client`, with a certificate project alongside the secret one. */
  function certClient(handler: (call: Call) => { status?: number; body: unknown }) {
    return hostClient(
      new InfisicalClient(
        { siteUrl: "eu.infisical.com", clientId: "cid", clientSecret: "csecret" },
        services((call) => {
          if (call.url.endsWith("/universal-auth/login")) return { body: LOGIN };
          if (call.url.endsWith("/api/v1/projects")) return { body: { projects: [certProject] } };
          return handler(call);
        }),
      ),
    );
  }

  it("reads certificate authorities past the first page", async () => {
    const c = certClient((call) => {
      const offset = Number(new URL(call.url).searchParams.get("offset"));
      if (offset === 0)
        return {
          body: { cas: Array.from({ length: 100 }, (_, i) => ({ id: `ca-${i}`, name: "n" })) },
        };
      return { body: { cas: [{ id: "ca-last", name: "n" }] } };
    });
    expect(await c.listResources("certificate-authority", ACCOUNT)).toHaveLength(101);
  });

  it("fails rather than truncate certificate authorities at the cap", async () => {
    const c = certClient(() => ({
      body: { cas: Array.from({ length: 100 }, (_, i) => ({ id: `ca-${i}`, name: "n" })) },
    }));
    await expect(c.listResources("certificate-authority", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.url.includes("/cas"))).toHaveLength(100);
  });

  it("reads 50,000 certificates, and fails rather than truncate past that", async () => {
    const c = certClient((call) => {
      const { offset }: { offset: number } = JSON.parse(call.body!);
      return {
        body: {
          certificates: Array.from({ length: 100 }, (_, i) => ({ id: `c-${offset + i}` })),
          totalCount: 60_000,
        },
      };
    });
    await expect(c.listResources("certificate", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((x) => x.url.includes("/certificates/search"))).toHaveLength(500);
  });

  it("stops at the total the certificate search reports", async () => {
    const c = certClient(() => ({
      body: {
        certificates: Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}` })),
        totalCount: 100,
      },
    }));
    expect(await c.listResources("certificate", ACCOUNT)).toHaveLength(100);
    expect(calls.filter((x) => x.url.includes("/certificates/search"))).toHaveLength(1);
  });

  it("rejects a certificate page with its key renamed, first and later", async () => {
    const renamed = certClient(() => ({ body: { items: [] } }));
    await expect(renamed.listResources("certificate", ACCOUNT)).rejects.toThrow("is not a list");

    calls = [];
    const later = certClient((call) => {
      const { offset }: { offset: number } = JSON.parse(call.body!);
      if (offset > 0) return { body: { items: [] } };
      return { body: { certificates: Array.from({ length: 100 }, (_, i) => ({ id: `c-${i}` })) } };
    });
    await expect(later.listResources("certificate", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it.each([
    ["project", "/api/v1/projects"],
    ["folder", "/api/v2/folders"],
    ["secret", "/api/v4/secrets"],
    ["dynamic-secret", "/api/v1/dynamic-secrets"],
    ["secret-sync", "/api/v1/secret-syncs"],
    ["integration", "/integrations"],
    ["machine-identity", "/api/v1/identities"],
  ])("rejects a %s list with its key renamed, through every catch", async (typeId, route) => {
    const c = hostClient(
      new InfisicalClient(
        { siteUrl: "eu.infisical.com", clientId: "cid", clientSecret: "csecret" },
        services((call) => {
          const path = new URL(call.url).pathname;
          if (path.endsWith("/universal-auth/login")) return { body: LOGIN };
          if (path.endsWith(route)) return { body: { renamed: [] } };
          if (path === "/api/v1/projects") return { body: { projects: [PROJECT] } };
          if (path === "/api/v2/folders") return { body: { folders: [] } };
          if (path === "/api/v1/identities/details") {
            return { body: { identityDetails: { organization: { id: "org-1" } } } };
          }
          return { body: {} };
        }),
      ),
    );
    await expect(c.listResources(typeId, ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("fails a listing on a server error, which is not an empty project", async () => {
    const c = client(() => ({ status: 500, body: { message: "boom" } }));
    await expect(c.listResources("integration", ACCOUNT)).rejects.toThrow(/500/);
    await expect(c.listResources("secret", ACCOUNT)).rejects.toThrow(/500/);
  });

  it("does not read a failed folder listing as a project with only a root", async () => {
    const c = client((call) => {
      if (call.url.includes("/api/v2/folders")) return { status: 500, body: { message: "boom" } };
      return { body: { dynamicSecrets: [] } };
    });
    await expect(c.listResources("dynamic-secret", ACCOUNT)).rejects.toThrow(/500/);
  });

  it("keeps the rest of an environment when one dynamic secret path is denied", async () => {
    const c = client((call) => {
      if (call.url.includes("/api/v2/folders"))
        return { body: { folders: [{ id: "f1", name: "db", relativePath: "/" }] } };
      if (new URL(call.url).searchParams.get("path") === "/db")
        return { status: 403, body: { message: "denied" } };
      return { body: { dynamicSecrets: [{ id: "ds1", name: "root" }] } };
    });
    const list = await c.listResources("dynamic-secret", ACCOUNT);
    expect(list.map((d) => d.fields["path"])).toEqual(["/", "/"]);
  });
});

describe("paged reads for a view", () => {
  const pages = <T>(rows: T[], call: Call) => {
    const query = new URL(call.url).searchParams;
    const offset = Number(query.get("offset"));
    return rows.slice(offset, offset + Number(query.get("limit")));
  };

  it("offers every certificate profile in the create form, not the first 100", async () => {
    const profiles = Array.from({ length: 150 }, (_, i) => ({ id: `p-${i}`, slug: `s-${i}` }));
    const c = client((call) => ({
      body: { certificateProfiles: pages(profiles, call), totalCount: profiles.length },
    }));
    const config = await c.getCreateConfig("certificate", `${ACCOUNT}:project:proj-1`);
    const picker = config.fields.find((f) => f.key === "profileId");
    expect(picker?.options).toHaveLength(150);
    const requests = calls.filter((x) => x.url.includes("/certificate-profiles"));
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!.url).searchParams.get("enrollmentType")).toBe("api");
  });

  it("shows every identity of a project, not the first 100", async () => {
    const members = Array.from({ length: 120 }, (_, i) => ({
      identity: { name: `id-${i}` },
      roles: [{ role: "viewer" }],
    }));
    const c = client((call) => ({
      body: { identityMemberships: pages(members, call), totalCount: members.length },
    }));
    const [project] = await c.listResources("project", ACCOUNT);
    const enriched = await c.enrichDetail!(project!);
    const shown: unknown[] = JSON.parse(enriched.resolvedOutputs["__identities__"]!);
    expect(shown).toHaveLength(120);
  });

  it("keeps what it read of a view's list at the cap rather than show nothing", async () => {
    const c = client((call) => ({
      body: {
        certificateProfiles: Array.from({ length: 100 }, (_, i) => ({
          id: `p-${new URL(call.url).searchParams.get("offset")}-${i}`,
          slug: "s",
        })),
      },
    }));
    const config = await c.getCreateConfig("certificate", `${ACCOUNT}:project:proj-1`);
    expect(config.fields.find((f) => f.key === "profileId")?.options).toHaveLength(10_000);
  });
});

describe("certificates read by id", () => {
  const certProjects = [
    { ...PROJECT, id: "other", type: "cert-manager" },
    { ...PROJECT, id: "cert-1", type: "cert-manager" },
  ];
  const CERT = { id: "c1", commonName: "api.example.com", serialNumber: "ab:cd", status: "active" };

  function certClient(handler: (call: Call) => { status?: number; body: unknown }) {
    return hostClient(
      new InfisicalClient(
        { siteUrl: "eu.infisical.com", clientId: "cid", clientSecret: "csecret" },
        services((call) => {
          if (call.url.endsWith("/universal-auth/login")) return { body: LOGIN };
          if (call.url.endsWith("/api/v1/projects")) return { body: { projects: certProjects } };
          return handler(call);
        }),
      ),
    );
  }

  it("finds the project from the search row, as a listing has it", async () => {
    const c = certClient((call) => {
      if (call.url.includes("/projects/other/certificates/search"))
        return { body: { certificates: [] } };
      if (call.url.includes("/projects/cert-1/certificates/search")) {
        return { body: { certificates: [{ ...CERT, projectId: "cert-1" }] } };
      }
      return { body: { certificate: CERT } };
    });
    const resource = await c.getResource("certificate", `${ACCOUNT}:certificate:c1`, ACCOUNT);
    expect(resource.parentResourceId).toBe(`${ACCOUNT}:project:cert-1`);
    expect(resource.fields["projectId"]).toBe("cert-1");
    const search = calls.find((x) => x.url.includes("/cert-1/certificates/search"))!;
    expect(JSON.parse(search.body!)).toMatchObject({ search: "ab:cd" });
  });

  it("still reads the certificate when no project can be found", async () => {
    const c = certClient((call) => {
      if (call.url.includes("/certificates/search")) return { status: 500, body: {} };
      return { body: { certificate: CERT } };
    });
    const resource = await c.getResource("certificate", `${ACCOUNT}:certificate:c1`, ACCOUNT);
    expect(resource.displayName).toBe("api.example.com");
    expect(resource.parentResourceId).toBeUndefined();
  });

  it("gives a created certificate the project it was created in, field and parent", async () => {
    const c = certClient((call) => {
      if (call.method === "POST" && call.url.endsWith("/api/v1/cert-manager/certificates")) {
        return { body: { certificate: { certificateId: "c1" } } };
      }
      if (call.url.includes("/certificates/search")) throw new Error("no search was needed");
      return { body: { certificate: CERT } };
    });
    const resource = await c.createResource(
      "certificate",
      ACCOUNT,
      { profileId: "p1", commonName: "api.example.com" },
      `${ACCOUNT}:project:cert-1`,
    );
    expect(resource.fields["projectId"]).toBe("cert-1");
    expect(resource.parentResourceId).toBe(`${ACCOUNT}:project:cert-1`);
  });
});

describe("integrations read by id", () => {
  const INTEGRATION = {
    id: "i1",
    integration: "vercel",
    envId: "env-prod",
    environment: { id: "env-prod", slug: "prod", name: "Production" },
  };

  it("takes the project from the environment, as a listing has it", async () => {
    const c = client(() => ({ body: { integration: INTEGRATION } }));
    const resource = await c.getResource("integration", `${ACCOUNT}:integration:i1`, ACCOUNT);
    expect(resource.parentResourceId).toBe(`${ACCOUNT}:project:proj-1`);
  });

  it("still reads the integration when no project holds the environment", async () => {
    const c = client(() => ({
      body: { integration: { ...INTEGRATION, envId: "gone", environment: { id: "gone" } } },
    }));
    const resource = await c.getResource("integration", `${ACCOUNT}:integration:i1`, ACCOUNT);
    expect(resource.externalId).toBe("i1");
    expect(resource.parentResourceId).toBeUndefined();
  });
});

describe("a secret's value", () => {
  const SECRET = { id: "s1", workspace: "proj-1", environment: "dev", secretKey: "K" };
  const value = (secret: object) =>
    client(() => ({ body: { secret: { ...SECRET, ...secret } } })).resolveOutput(
      "secret",
      `${ACCOUNT}:secret:s1`,
      "value",
      ACCOUNT,
    );

  it("is returned when the identity may read it", async () => {
    await expect(value({ secretValue: "shh" })).resolves.toBe("shh");
  });

  it("refuses the flag where a server sends one", async () => {
    await expect(value({ secretValue: "", secretValueHidden: true })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("refuses the mask rather than hand it out as the value, with no flag", async () => {
    await expect(value({ secretValue: "<hidden-by-infisical>" })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("mutations", () => {
  it("renames and re-values a secret through the v4 PATCH", async () => {
    const c = client((call) => {
      if (call.url.includes("/api/v4/secrets/id/sec-1")) {
        return {
          body: {
            secret: {
              id: "sec-1",
              workspace: "proj-1",
              environment: "dev",
              secretKey: "OLD",
              secretPath: "/",
            },
          },
        };
      }
      if (call.method === "PATCH") return { body: { secret: { id: "sec-1" } } };
      return { body: {} };
    });
    await c.updateResource("secret", `${ACCOUNT}:secret:sec-1`, ACCOUNT, {
      key: "NEW",
      value: "v2",
    });
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url).toBe("https://eu.infisical.com/api/v4/secrets/OLD");
    expect(JSON.parse(patch.body!)).toMatchObject({
      projectId: "proj-1",
      environment: "dev",
      secretPath: "/",
      newSecretName: "NEW",
      secretValue: "v2",
    });
  });

  it("reports a change that went to approval instead of pretending it was created", async () => {
    const c = client((call) => {
      if (call.method === "POST" && call.url.includes("/api/v4/secrets/"))
        return { body: { approval: { id: "a1" } } };
      return { body: {} };
    });
    await expect(
      c.createResource("secret", ACCOUNT, { location: "proj-1|prod|/", key: "K", value: "v" }),
    ).rejects.toThrow(/approval/);
  });

  it("mints a Universal Auth client secret as a reveal-once env file", async () => {
    const c = client((call) => {
      if (call.url.endsWith("/client-secrets") && call.method === "POST")
        return { body: { clientSecret: "shh" } };
      if (call.url.includes("/universal-auth/identities/"))
        return { body: { identityUniversalAuth: { clientId: "ua-1" } } };
      return { body: {} };
    });
    const out = await c.exportCredential(
      "machine-identity",
      `${ACCOUNT}:machine-identity:id-1`,
      ACCOUNT,
      "universal-auth-client-secret",
    );
    expect(out.content).toContain("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=ua-1");
    expect(out.content).toContain("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=shh");
  });
});

describe("status feed", () => {
  it("keeps only unresolved incidents", () => {
    const body = JSON.stringify({
      page: { id: "p" },
      incidents: [
        {
          id: "a",
          name: "Old",
          status: "resolved",
          impact: "major",
          created_at: "2026-01-01T00:00:00Z",
          resolved_at: "2026-01-01T01:00:00Z",
          incident_updates: [],
        },
        {
          id: "b",
          name: "High error rates on secrets fetch",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-06T00:00:00Z",
          incident_updates: [],
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents.map((i) => i.externalId)).toEqual(["b"]);
  });
});

describe("terraform export", () => {
  it("maps a secret to a var-backed infisical_secret", () => {
    const out = infisicalTerraformExport.mapResource({
      id: "a:secret:s1",
      pluginId: "infisical",
      resourceTypeId: "secret",
      accountId: "a",
      displayName: "API_KEY",
      externalId: "s1",
      fields: { key: "API_KEY", environment: "prod", projectId: "proj-1", path: "/api" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("infisical_secret");
    expect(out?.resource.attributes["value"]).toEqual({
      kind: "ref",
      expr: "var.infisical_secret_prod_api_key",
    });
    expect(out?.variables?.[0]?.sensitive).toBe(true);
  });
});
