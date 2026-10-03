import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const api = {
  databases: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    createToken: vi.fn(),
  },
  groups: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  locations: {
    list: vi.fn(),
  },
};

type CreateClientArgs = Parameters<(typeof import("@tursodatabase/api"))["createClient"]>;

const createClient = vi.fn((..._args: CreateClientArgs) => api);

vi.mock("@tursodatabase/api", () => ({
  createClient: (...args: CreateClientArgs) => createClient(...args),
}));

import { TursoClient } from "../client.js";

const ACCOUNT = "acct1";
const creds = { apiToken: "tok", organizationName: "myorg" };

function makeClient() {
  return new TursoClient(creds);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Routes = Record<string, unknown>;

/**
 * Route `fetch` by `"METHOD /path"` (query string ignored). Unrouted calls
 * answer 404 so a test that forgets a route fails loudly instead of hitting
 * the network.
 */
function routeFetch(routes: Routes) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    if (key in routes) return response(routes[key]);
    return response({ error: `unrouted ${key}` }, 404);
  });
}

const DB_PATH = "/v1/organizations/myorg/databases";

function response(json: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

describe("constructor", () => {
  it("throws without apiToken", () => {
    expect(() => new TursoClient({ organizationName: "o" })).toThrow(/missing apiToken/);
  });

  it("throws without organizationName", () => {
    expect(() => new TursoClient({ apiToken: "t" })).toThrow(/missing organizationName/);
  });

  it("constructs api client with org+token", () => {
    makeClient();
    expect(createClient).toHaveBeenCalledWith({ org: "myorg", token: "tok" });
  });
});

describe("listResources", () => {
  it("maps databases with their configuration", async () => {
    routeFetch({
      [`GET ${DB_PATH}`]: {
        databases: [
          {
            Name: "mydb",
            DbId: "uuid-1",
            Hostname: "mydb-myorg.turso.io",
            group: "default",
            primaryRegion: "aws-us-east-1",
            regions: ["aws-us-east-1"],
            delete_protection: true,
            block_reads: false,
            block_writes: false,
            parent: { name: "prod", branched_at: "2026-09-01T00:00:00Z" },
          },
        ],
      },
      [`GET ${DB_PATH}/mydb/configuration`]: {
        size_limit: "1gb",
        delete_protection: true,
        block_reads: false,
        block_writes: true,
        allowed_ips: ["10.0.0.0/8", "203.0.113.7"],
        allowed_aws_vpc_ids: [],
      },
    });
    const client = makeClient();
    const res = await client.listResources("turso-database", ACCOUNT);
    expect(res[0]!).toMatchObject({
      id: "acct1:turso-database:mydb",
      pluginId: "turso",
      externalId: "mydb",
      fields: {
        name: "mydb",
        dbId: "uuid-1",
        group: "default",
        regions: "aws-us-east-1",
        deleteProtection: true,
        blockWrites: true,
        sizeLimit: "1gb",
        allowedIps: "10.0.0.0/8, 203.0.113.7",
        allowedAwsVpcIds: "",
        parent: "prod",
      },
    });
  });

  it("maps databases with missing optional fields and no configuration", async () => {
    routeFetch({ [`GET ${DB_PATH}`]: { databases: [{ Name: "d", Hostname: "h" }] } });
    const client = makeClient();
    const res = await client.listResources("turso-database", ACCOUNT);
    expect(res[0]!.fields).toMatchObject({
      group: "",
      primaryRegion: "",
      regions: "",
      sizeLimit: "",
      allowedIps: "",
      deleteProtection: false,
    });
  });

  it("maps groups", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/groups": {
        groups: [
          {
            name: "g1",
            uuid: "g-uuid",
            primary: "iad",
            locations: ["iad", "lhr"],
            delete_protection: true,
          },
        ],
      },
    });
    const client = makeClient();
    const res = await client.listResources("turso-group", ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:turso-group:g1",
      externalId: "g1",
      fields: {
        name: "g1",
        uuid: "g-uuid",
        primaryLocation: "iad",
        locations: "iad, lhr",
        deleteProtection: true,
      },
    });
  });

  it("maps org-level API tokens with their owner, keyed by id", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/api-tokens": {
        tokens: [
          {
            id: "tok-1",
            name: "ci",
            organization: "myorg",
            group: "default",
            scopes: ["db:create", "db:mint-token"],
            owner: { username: "alice", email: "alice@example.com" },
            created_at: "2026-05-21",
          },
        ],
      },
    });
    const client = makeClient();
    const res = await client.listResources("turso-api-token", ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:turso-api-token:tok-1",
      externalId: "tok-1",
      displayName: "ci",
      fields: {
        scopes: "db:create, db:mint-token",
        ownerUsername: "alice",
        group: "default",
        createdAt: "2026-05-21",
      },
    });
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });

  it("maps organization invites through the v2 REST API", async () => {
    const fetchMock = routeFetch({
      "GET /v2/organizations/myorg/invites": {
        invites: [
          { id: 7, email: "new@example.com", role: "viewer", created_at: "2026-09-01T00:00:00Z" },
        ],
      },
    });
    const client = makeClient();
    const res = await client.listResources("turso-organization-invite", ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:turso-organization-invite:new@example.com",
      externalId: "new@example.com",
      fields: { email: "new@example.com", role: "viewer", createdAt: "2026-09-01T00:00:00Z" },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.turso.tech/v2/organizations/myorg/invites");
    expect((init as { headers: Record<string, string> }).headers["Authorization"]).toBe(
      "Bearer tok",
    );
  });
});

describe("getResource", () => {
  it("returns found", async () => {
    routeFetch({ [`GET ${DB_PATH}`]: { databases: [{ Name: "d", Hostname: "h" }] } });
    const client = makeClient();
    const r = await client.getResource("turso-database", "acct1:turso-database:d", ACCOUNT);
    expect(r.externalId).toBe("d");
  });

  it("throws not found", async () => {
    routeFetch({ [`GET ${DB_PATH}`]: { databases: [] } });
    const client = makeClient();
    await expect(
      client.getResource("turso-database", "acct1:turso-database:x", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveOutput", () => {
  it("resolves database connection string with token", async () => {
    api.databases.createToken.mockResolvedValue({ jwt: "abc def" });
    const client = makeClient();
    const cs = await client.resolveOutput(
      "turso-database",
      "acct1:turso-database:mydb",
      "connectionString",
      ACCOUNT,
    );
    expect(api.databases.createToken).toHaveBeenCalledWith("mydb");
    expect(cs).toBe("libsql://mydb-myorg.turso.io?authToken=abc%20def");
  });

  it("resolves database hostname and dbName", async () => {
    routeFetch({ [`GET ${DB_PATH}`]: { databases: [{ Name: "mydb", Hostname: "h.turso.io" }] } });
    const client = makeClient();
    const id = "acct1:turso-database:mydb";
    expect(await client.resolveOutput("turso-database", id, "hostname", ACCOUNT)).toBe(
      "h.turso.io",
    );
    expect(await client.resolveOutput("turso-database", id, "dbName", ACCOUNT)).toBe("mydb");
  });

  it("resolves group outputs", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/groups": {
        groups: [{ name: "g1", primary: "iad", locations: ["iad"] }],
      },
    });
    const client = makeClient();
    const id = "acct1:turso-group:g1";
    expect(await client.resolveOutput("turso-group", id, "groupName", ACCOUNT)).toBe("g1");
    expect(await client.resolveOutput("turso-group", id, "primaryLocation", ACCOUNT)).toBe("iad");
  });

  it("throws for unresolvable", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/groups": {
        groups: [{ name: "g1", primary: "iad", locations: ["iad"] }],
      },
    });
    const client = makeClient();
    await expect(
      client.resolveOutput("turso-group", "acct1:turso-group:g1", "weird", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("lifecycle operations", () => {
  it("creates and deletes organization invites through v2", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ invited: { email: "new@example.com", role: "member", organization: "myorg" } }),
      )
      .mockResolvedValueOnce(response({}));

    const client = makeClient();
    const invite = await client.createResource("turso-organization-invite", ACCOUNT, {
      email: "new@example.com",
      role: "member",
    });
    expect(invite).toMatchObject({
      externalId: "new@example.com",
      fields: { email: "new@example.com", role: "member" },
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.turso.tech/v2/organizations/myorg/invites",
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      email: "new@example.com",
      role: "member",
    });

    await client.deleteResource(
      "turso-organization-invite",
      "acct1:turso-organization-invite:new@example.com",
      ACCOUNT,
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.turso.tech/v2/organizations/myorg/invites/new%40example.com",
    );
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe("DELETE");
  });

  it("routes direct organization REST calls through host http services", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ invites: [{ email: "new@example.com", role: "member" }] }),
    });
    const client = new TursoClient(creds, { http: { request } });

    const invites = await client.listResources("turso-organization-invite", ACCOUNT);

    expect(invites[0]).toMatchObject({
      externalId: "new@example.com",
      fields: { email: "new@example.com", role: "member" },
    });
    expect(request).toHaveBeenCalledWith({
      url: "https://api.turso.tech/v2/organizations/myorg/invites",
      method: "GET",
      headers: {
        Authorization: "Bearer tok",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  });

  it("updates and removes organization members", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ member: { username: "alice", email: "alice@example.com", role: "admin" } }),
      )
      .mockResolvedValueOnce(response({}));

    const client = makeClient();
    const updated = await client.updateResource(
      "turso-organization-member",
      "acct1:turso-organization-member:alice",
      ACCOUNT,
      { role: "admin" },
    );
    expect(updated.fields).toMatchObject({ username: "alice", role: "admin" });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      role: "admin",
    });

    await client.deleteResource(
      "turso-organization-member",
      "acct1:turso-organization-member:alice",
      ACCOUNT,
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.turso.tech/v1/organizations/myorg/members/alice",
    );
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe("DELETE");
  });

  it("refuses to grant ownership", async () => {
    const client = makeClient();
    await expect(
      client.updateResource(
        "turso-organization-member",
        "acct1:turso-organization-member:alice",
        ACCOUNT,
        { role: "owner" },
      ),
    ).rejects.toThrow(/ownership/);
  });

  it("revokes org API tokens by id", async () => {
    const fetchMock = routeFetch({
      "DELETE /v1/organizations/myorg/api-tokens/tok-1": { token: "tok-1" },
    });
    const client = makeClient();
    await client.deleteResource("turso-api-token", "acct1:turso-api-token:tok-1", ACCOUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates database and group auth tokens", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}));
    const client = makeClient();

    await client.invalidateDatabaseAuthTokens("acct1:turso-database:app-db");
    await client.invalidateGroupAuthTokens("acct1:turso-group:default");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.turso.tech/v1/organizations/myorg/databases/app-db/auth/rotate",
      "https://api.turso.tech/v1/organizations/myorg/groups/default/auth/rotate",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      "POST",
      "POST",
    ]);
  });
});

describe("invokeAction", () => {
  it("dispatches database and group actions to their routes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}));
    const client = makeClient();

    await client.invokeAction(
      "turso-database",
      "acct1:turso-database:app",
      "rotate-tokens",
      ACCOUNT,
    );
    await client.invokeAction("turso-group", "acct1:turso-group:g1", "rotate-tokens", ACCOUNT);
    await client.invokeAction("turso-group", "acct1:turso-group:g1", "unarchive", ACCOUNT);
    await client.invokeAction("turso-group", "acct1:turso-group:g1", "update-version", ACCOUNT);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.turso.tech/v1/organizations/myorg/databases/app/auth/rotate",
      "https://api.turso.tech/v1/organizations/myorg/groups/g1/auth/rotate",
      "https://api.turso.tech/v1/organizations/myorg/groups/g1/unarchive",
      "https://api.turso.tech/v1/organizations/myorg/groups/g1/update",
    ]);
  });

  it("rejects unknown actions", async () => {
    const client = makeClient();
    await expect(
      client.invokeAction("turso-database", "acct1:turso-database:app", "nope", ACCOUNT),
    ).rejects.toThrow(/unknown action/);
  });
});

describe("updateResource (configuration)", () => {
  it("patches only the configuration that changed", async () => {
    const fetchMock = routeFetch({
      [`GET ${DB_PATH}`]: { databases: [{ Name: "app", Hostname: "h" }] },
      [`GET ${DB_PATH}/app/configuration`]: {
        size_limit: "0",
        delete_protection: false,
        block_reads: false,
        block_writes: false,
        allowed_ips: ["10.0.0.0/8"],
        allowed_aws_vpc_ids: [],
      },
      [`PATCH ${DB_PATH}/app/configuration`]: {},
    });
    const client = makeClient();
    await client.updateResource("turso-database", "acct1:turso-database:app", ACCOUNT, {
      deleteProtection: "true",
      blockReads: "false",
      blockWrites: "false",
      sizeLimit: "1gb",
      allowedIps: "10.0.0.0/8",
      allowedAwsVpcIds: "",
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({
      delete_protection: true,
      size_limit: "1gb",
    });
  });

  it("clears an allow-list only when the user empties it", async () => {
    const fetchMock = routeFetch({
      [`GET ${DB_PATH}`]: { databases: [{ Name: "app", Hostname: "h" }] },
      [`GET ${DB_PATH}/app/configuration`]: { allowed_ips: ["10.0.0.0/8"] },
      [`PATCH ${DB_PATH}/app/configuration`]: {},
    });
    const client = makeClient();
    await client.updateResource("turso-database", "acct1:turso-database:app", ACCOUNT, {
      allowedIps: "",
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ allowed_ips: [] });
  });

  it("skips the PATCH when nothing changed", async () => {
    const fetchMock = routeFetch({
      [`GET ${DB_PATH}`]: { databases: [{ Name: "app", Hostname: "h" }] },
      [`GET ${DB_PATH}/app/configuration`]: { delete_protection: true },
    });
    const client = makeClient();
    await client.updateResource("turso-database", "acct1:turso-database:app", ACCOUNT, {
      deleteProtection: "true",
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("toggles group delete protection", async () => {
    const fetchMock = routeFetch({
      "PATCH /v1/organizations/myorg/groups/g1/configuration": { delete_protection: true },
      "GET /v1/organizations/myorg/groups": { groups: [{ name: "g1", delete_protection: true }] },
    });
    const client = makeClient();
    const res = await client.updateResource("turso-group", "acct1:turso-group:g1", ACCOUNT, {
      deleteProtection: "true",
    });
    expect(res.fields["deleteProtection"]).toBe(true);
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ delete_protection: true });
  });
});

describe("fetchQuotas", () => {
  it("pairs the current plan's quotas with org usage", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/plans": {
        plans: [
          { name: "starter", quotas: { rowsRead: 1, storage: 1 } },
          {
            name: "developer",
            quotas: {
              rowsRead: 2_500_000_000,
              rowsWritten: 25_000_000,
              databases: null,
              storage: 9_000_000_000,
              groups: 0,
            },
          },
        ],
      },
      "GET /v1/organizations/myorg/subscription": { subscription: { plan: "developer" } },
      "GET /v1/organizations/myorg/usage": {
        organization: { usage: { rows_read: 100, rows_written: 5, storage_bytes: 4096 } },
      },
    });
    const client = makeClient();
    const quotas = await client.fetchQuotas(ACCOUNT);
    expect(quotas.map((q) => q.id)).toEqual(["rows-read", "rows-written", "storage"]);
    expect(quotas[2]).toMatchObject({ limit: 9_000_000_000, used: 4096, unit: "bytes" });
  });

  it("throws when the plan publishes no quotas", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/plans": { plans: [] },
      "GET /v1/organizations/myorg/subscription": { subscription: { plan: "enterprise" } },
      "GET /v1/organizations/myorg/usage": { organization: { usage: {} } },
    });
    const client = makeClient();
    await expect(client.fetchQuotas(ACCOUNT)).rejects.toThrow(/no quotas/);
  });
});

describe("enrichDetail", () => {
  it("adds usage and top queries to a database", async () => {
    routeFetch({
      [`GET ${DB_PATH}/app/usage`]: {
        database: {
          total: { rows_read: 10, rows_written: 2, storage_bytes: 8192, bytes_synced: 0 },
        },
      },
      [`GET ${DB_PATH}/app/stats`]: {
        top_queries: [{ query: "SELECT 1", rows_read: 1, rows_written: 0 }],
      },
    });
    const client = makeClient();
    const enriched = await client.enrichDetail({
      id: "acct1:turso-database:app",
      pluginId: "turso",
      resourceTypeId: "turso-database",
      accountId: ACCOUNT,
      displayName: "app",
      fields: { name: "app" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(enriched.fields).toMatchObject({ usageRowsRead: 10, usageStorageBytes: 8192 });
    const detail = client.renderDetail(enriched);
    const titles = detail.sections.map((s) => ("title" in s ? s.title : ""));
    expect(titles).toContain("Usage (current billing month)");
    expect(titles).toContain("Top Queries");
  });
});

describe("fetchDashboardStats", () => {
  it("database stats with sleeping and usage", async () => {
    routeFetch({
      [`GET ${DB_PATH}`]: {
        databases: [
          { Name: "d", Hostname: "h", group: "default", primaryRegion: "iad", sleeping: true },
        ],
      },
      [`GET ${DB_PATH}/d/usage`]: {
        database: { total: { rows_read: 1234, rows_written: 5, storage_bytes: 2048 } },
      },
    });
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "turso-database",
      "acct1:turso-database:d",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "Group", value: "default" });
    expect(stats[1]!.value).toContain("Ashburn");
    expect(stats.find((s) => s.label === "Rows Read")?.value).toBe("1,234");
    expect(stats[stats.length - 1]).toMatchObject({
      value: "sleeping",
      variant: "status-degraded",
    });
  });

  it("database stats without usage", async () => {
    routeFetch({
      [`GET ${DB_PATH}`]: {
        databases: [{ Name: "d", Hostname: "h", group: "g", primaryRegion: "iad" }],
      },
    });
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "turso-database",
      "acct1:turso-database:d",
      ACCOUNT,
    );
    expect(stats).toHaveLength(2);
  });

  it("group stats", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/groups": {
        groups: [{ name: "g1", primary: "iad", locations: ["iad", "lhr"] }],
      },
    });
    const client = makeClient();
    const stats = await client.fetchDashboardStats("turso-group", "acct1:turso-group:g1", ACCOUNT);
    expect(stats[0]!.value).toContain("Ashburn");
    expect(stats[1]!.label).toBe("Locations");
  });
});

describe("renderDetail", () => {
  const base = { pluginId: "turso", accountId: ACCOUNT, resolvedOutputs: {}, secretStates: [] };

  it("renders database detail (active)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "turso-database",
      displayName: "mydb",
      externalId: "mydb",
      fields: {
        hostname: "h.turso.io",
        group: "default",
        primaryRegion: "iad",
        regions: "iad, lhr",
        version: "1",
        isSchema: true,
        schema: "parent",
        sleeping: false,
      },
    } as never);
    expect(d.title).toBe("mydb");
    expect(d.status).toMatchObject({ status: "healthy" });
    expect(d.sqlEditor).toBeTruthy();
  });

  it("renders database detail (sleeping, no regions/schema)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "turso-database",
      displayName: "mydb",
      fields: { hostname: "h", sleeping: true, isSchema: false, regions: "", schema: "" },
    } as never);
    expect(d.status).toMatchObject({ status: "degraded" });
  });

  it("renders group detail", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "turso-group",
      displayName: "g1",
      fields: { primaryLocation: "iad", locations: "iad, lhr", version: "1" },
    } as never);
    expect(d.subtitle).toBe("Turso Group");
  });

  it("renders group detail with empty locations", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "turso-group",
      displayName: "g1",
      fields: { primaryLocation: "iad", locations: "" },
    } as never);
    expect(d.title).toBe("g1");
  });

  it("renders generic detail", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "other",
      displayName: "o",
      fields: {},
    } as never);
    expect(d.sections).toEqual([]);
  });
});

describe("renderSidebarItem", () => {
  it("database sleeping -> degraded", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "d",
      resourceTypeId: "turso-database",
      fields: { sleeping: true },
    } as never);
    expect(item.status).toMatchObject({ status: "degraded" });
  });

  it("database active -> healthy", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "d",
      resourceTypeId: "turso-database",
      fields: { sleeping: false },
    } as never);
    expect(item.status).toMatchObject({ status: "healthy" });
  });

  it("group -> info", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "g",
      resourceTypeId: "turso-group",
      fields: {},
    } as never);
    expect(item.status).toMatchObject({ status: "info" });
  });
});

describe("getCreateConfig", () => {
  it("database config lists groups and copy sources", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/groups": {
        groups: [{ name: "g1", primary: "iad", locations: ["iad"] }],
      },
      [`GET ${DB_PATH}`]: { databases: [{ Name: "prod", group: "g1" }] },
    });
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-database");
    const group = cfg.fields.find((f) => f.key === "group");
    expect(group).toMatchObject({ defaultValue: "g1" });
    const seed = cfg.fields.find((f) => f.key === "seedDatabase");
    expect(seed?.options?.map((o) => o.id)).toEqual(["", "prod"]);
    expect(cfg.fields.find((f) => f.key === "seedTimestamp")?.kind).toBe("datetime");
  });

  it("database config with no groups omits default", async () => {
    routeFetch({
      "GET /v1/organizations/myorg/groups": { groups: [] },
      [`GET ${DB_PATH}`]: { databases: [] },
    });
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-database");
    const group = cfg.fields.find((f) => f.key === "group");
    expect(group).not.toHaveProperty("defaultValue");
  });

  it("group config offers Turso's live locations", async () => {
    api.locations.list.mockResolvedValue([
      { code: "aws-us-east-1", description: "AWS US East (Virginia)" },
      { code: "aws-eu-west-1", description: "AWS EU West (Ireland)" },
    ]);
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-group");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "location", "extensions"]);
    const location = cfg.fields.find((f) => f.key === "location");
    expect(location?.regions?.map((r) => r.id)).toEqual(["aws-us-east-1", "aws-eu-west-1"]);
    expect(location?.defaultValue).toBe("aws-us-east-1");
  });

  it("group config falls back to the static table", async () => {
    api.locations.list.mockRejectedValue(new Error("offline"));
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-group");
    const location = cfg.fields.find((f) => f.key === "location");
    expect(location?.regions?.length).toBeGreaterThan(6);
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates database with group and schema flag", async () => {
    const fetchMock = routeFetch({
      [`POST ${DB_PATH}`]: {
        database: { Name: "newdb", DbId: "u", Hostname: "newdb-myorg.turso.io" },
      },
    });
    const client = makeClient();
    const res = await client.createResource("turso-database", ACCOUNT, {
      name: "newdb",
      group: "default",
      isSchema: "true",
    });
    expect(res.id).toBe("acct1:turso-database:newdb");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      name: "newdb",
      group: "default",
      is_schema: true,
    });
    expect(res.fields.isSchema).toBe(true);
  });

  it("branches a database at a point in time", async () => {
    const fetchMock = routeFetch({
      [`POST ${DB_PATH}`]: { database: { Name: "restore", Hostname: "h" } },
    });
    const client = makeClient();
    const res = await client.createResource("turso-database", ACCOUNT, {
      name: "restore",
      group: "default",
      seedDatabase: "prod",
      seedTimestamp: "2026-10-01T12:00:00Z",
      sizeLimit: "1gb",
      isSchema: "true",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      name: "restore",
      group: "default",
      size_limit: "1gb",
      seed: { type: "database", name: "prod", timestamp: "2026-10-01T12:00:00Z" },
    });
    expect(res.fields).toMatchObject({ parent: "prod", isSchema: false, sizeLimit: "1gb" });
  });

  it("creates database without group/schema", async () => {
    const fetchMock = routeFetch({ [`POST ${DB_PATH}`]: { database: { Name: "d2" } } });
    const client = makeClient();
    const res = await client.createResource("turso-database", ACCOUNT, { name: "d2" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ name: "d2" });
    expect(res.fields.group).toBe("");
  });

  it("database create throws without name", async () => {
    const client = makeClient();
    await expect(client.createResource("turso-database", ACCOUNT, {})).rejects.toThrow(
      /missing database name/,
    );
  });

  it("creates group with extensions", async () => {
    const fetchMock = routeFetch({
      "POST /v1/organizations/myorg/groups": {
        group: { name: "g2", primary: "aws-us-east-1", locations: ["aws-us-east-1"] },
      },
    });
    const client = makeClient();
    const res = await client.createResource("turso-group", ACCOUNT, {
      name: "g2",
      location: "aws-us-east-1",
      extensions: "all",
    });
    expect(res.id).toBe("acct1:turso-group:g2");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      name: "g2",
      location: "aws-us-east-1",
      extensions: "all",
    });
  });

  it("creates group with missing locations array", async () => {
    routeFetch({
      "POST /v1/organizations/myorg/groups": { group: { name: "g3", primary: "iad" } },
    });
    const client = makeClient();
    const res = await client.createResource("turso-group", ACCOUNT, {
      name: "g3",
      location: "iad",
    });
    expect(res.fields.locations).toBe("");
  });

  it("group create throws without name", async () => {
    const client = makeClient();
    await expect(
      client.createResource("turso-group", ACCOUNT, { location: "iad" }),
    ).rejects.toThrow(/missing group name/);
  });

  it("group create throws without location", async () => {
    const client = makeClient();
    await expect(client.createResource("turso-group", ACCOUNT, { name: "g" })).rejects.toThrow(
      /missing group location/,
    );
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.createResource("nope", ACCOUNT, {})).rejects.toThrow(/cannot create type/);
  });
});

describe("deleteResource", () => {
  it("deletes database", async () => {
    const client = makeClient();
    await client.deleteResource("turso-database", "acct1:turso-database:mydb", ACCOUNT);
    expect(api.databases.delete).toHaveBeenCalledWith("mydb");
  });

  it("deletes group", async () => {
    const client = makeClient();
    await client.deleteResource("turso-group", "acct1:turso-group:g1", ACCOUNT);
    expect(api.groups.delete).toHaveBeenCalledWith("g1");
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.deleteResource("nope", "acct1:nope:x", ACCOUNT)).rejects.toThrow(
      /cannot delete type/,
    );
  });
});
