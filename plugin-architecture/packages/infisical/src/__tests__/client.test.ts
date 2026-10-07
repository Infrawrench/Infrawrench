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
  return new InfisicalClient(
    { siteUrl: "eu.infisical.com/", clientId: "cid", clientSecret: "csecret" },
    services((call) => {
      if (call.url.endsWith("/api/v1/auth/universal-auth/login")) return { body: LOGIN };
      if (call.url.includes("/api/v1/projects") && !call.url.includes("/api/v1/projects/")) {
        return { body: { projects: [PROJECT] } };
      }
      return handler(call);
    }),
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
    expect(() => new InfisicalClient({ clientSecret: "x" })).toThrow(/clientId/);
    expect(() => new InfisicalClient({ clientId: "x" })).toThrow(/clientSecret/);
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
    // Per-project failures are tolerated in listings; a direct read surfaces the error.
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
