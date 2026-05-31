import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanetScaleClient } from "../client.js";

const ACCOUNT = "acct1";
const creds = {
  serviceTokenId: "tid",
  serviceTokenSecret: "tsecret",
  organizationName: "myorg",
};

function makeClient(extra: Record<string, string> = {}) {
  return new PlanetScaleClient({ ...creds, ...extra });
}

interface FetchExpectation {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

let fetchMock: ReturnType<typeof vi.fn>;

function okJson(json: unknown): FetchExpectation {
  return { ok: true, status: 200, json };
}

function mockFetchSequence(...responses: FetchExpectation[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return {
      ok: r.ok ?? status < 400,
      status,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json),
    } as unknown as Response;
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const dbRecord = (over: Record<string, unknown> = {}) => ({
  id: "dbid",
  name: "mydb",
  notes: "",
  region: { slug: "us-east", display_name: "US East" },
  state: "ready",
  html_url: "https://app.planetscale.com/myorg/mydb",
  created_at: "2024-01-01",
  updated_at: "2024-01-02",
  ...over,
});

const branchRecord = (over: Record<string, unknown> = {}) => ({
  id: "bid",
  name: "main",
  parent_branch: "",
  mysql_address: "addr",
  mysql_edge_address: "edge",
  production: true,
  ready: true,
  safe_migrations: false,
  schema_last_updated_at: "",
  created_at: "2024-01-01",
  updated_at: "2024-01-02",
  ...over,
});

describe("constructor", () => {
  it("throws missing serviceTokenId", () => {
    expect(() => new PlanetScaleClient({ serviceTokenSecret: "s", organizationName: "o" })).toThrow(
      /missing serviceTokenId/,
    );
  });
  it("throws missing serviceTokenSecret", () => {
    expect(() => new PlanetScaleClient({ serviceTokenId: "i", organizationName: "o" })).toThrow(
      /missing serviceTokenSecret/,
    );
  });
  it("throws missing organizationName", () => {
    expect(() => new PlanetScaleClient({ serviceTokenId: "i", serviceTokenSecret: "s" })).toThrow(
      /missing organizationName/,
    );
  });
  it("constructs with all creds", () => {
    expect(() => makeClient()).not.toThrow();
  });
});

describe("listResources databases", () => {
  it("lists and maps databases with correct URL+headers", async () => {
    mockFetchSequence(okJson({ data: [dbRecord()] }));
    const client = makeClient();
    const res = await client.listResources("ps-database", ACCOUNT);

    expect(res[0]).toMatchObject({
      id: "acct1:ps-database:mydb",
      pluginId: "planetscale",
      externalId: "mydb",
      fields: { name: "mydb", region: "us-east", state: "ready" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.planetscale.com/v1/organizations/myorg/databases");
    expect(init.headers.Authorization).toBe("tid:tsecret");
    expect(init.headers.Accept).toBe("application/json");
  });

  it("handles missing data array", async () => {
    mockFetchSequence(okJson({}));
    const client = makeClient();
    expect(await client.listResources("ps-database", ACCOUNT)).toEqual([]);
  });

  it("handles database with missing region", async () => {
    mockFetchSequence(okJson({ data: [dbRecord({ region: undefined, html_url: undefined })] }));
    const client = makeClient();
    const res = await client.listResources("ps-database", ACCOUNT);
    expect(res[0].fields.region).toBe("");
  });

  it("throws unknown type", async () => {
    const client = makeClient();
    await expect(client.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });

  it("throws on non-ok response", async () => {
    mockFetchSequence({ ok: false, status: 401, text: "unauthorized" });
    const client = makeClient();
    await expect(client.listResources("ps-database", ACCOUNT)).rejects.toThrow(
      /PlanetScale API error 401/,
    );
  });
});

describe("listResources branches", () => {
  it("fetches branches across all databases", async () => {
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "db1" }), dbRecord({ name: "db2", id: "x" })] }),
      okJson({ data: [branchRecord({ name: "main" })] }),
      okJson({ data: [branchRecord({ name: "dev", production: false, ready: false })] }),
    );
    const client = makeClient();
    const res = await client.listResources("ps-branch", ACCOUNT);
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({
      id: "acct1:ps-branch:db1/main",
      externalId: "db1/main",
      parentResourceId: "acct1:ps-database:db1",
      fields: { databaseName: "db1", production: true, ready: true },
    });
  });
});

describe("getResource", () => {
  it("returns found", async () => {
    mockFetchSequence(okJson({ data: [dbRecord()] }));
    const client = makeClient();
    const r = await client.getResource("ps-database", "acct1:ps-database:mydb", ACCOUNT);
    expect(r.externalId).toBe("mydb");
  });
  it("throws not found", async () => {
    mockFetchSequence(okJson({ data: [] }));
    const client = makeClient();
    await expect(
      client.getResource("ps-database", "acct1:ps-database:none", ACCOUNT),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveOutput", () => {
  it("resolves branch connection string via password creation", async () => {
    mockFetchSequence(
      okJson({
        data: {
          id: "pwid",
          name: "n",
          access_host_url: "host.psdb.cloud",
          username: "user name",
          plain_text: "p@ss",
          database_branch: { name: "main" },
          created_at: "",
        },
      }),
    );
    const client = makeClient();
    const cs = await client.resolveOutput(
      "ps-branch",
      "acct1:ps-branch:mydb/main",
      "connectionString",
      ACCOUNT,
    );
    expect(cs).toBe("mysql://user%20name:p%40ss@host.psdb.cloud/mydb");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/databases/mydb/branches/main/passwords");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).name).toMatch(/^infrawrench-/);
  });

  it("resolves database simple fields", async () => {
    mockFetchSequence(okJson({ data: [dbRecord()] }));
    const client = makeClient();
    const id = "acct1:ps-database:mydb";
    expect(await client.resolveOutput("ps-database", id, "databaseName", ACCOUNT)).toBe("mydb");
    mockFetchSequence(okJson({ data: [dbRecord()] }));
    expect(await client.resolveOutput("ps-database", id, "region", ACCOUNT)).toBe("us-east");
  });

  it("resolves branch simple fields", async () => {
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "mydb" })] }),
      okJson({ data: [branchRecord()] }),
    );
    const client = makeClient();
    const id = "acct1:ps-branch:mydb/main";
    expect(await client.resolveOutput("ps-branch", id, "branchName", ACCOUNT)).toBe("main");
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "mydb" })] }),
      okJson({ data: [branchRecord()] }),
    );
    expect(await client.resolveOutput("ps-branch", id, "databaseName", ACCOUNT)).toBe("mydb");
  });

  it("throws for unresolvable", async () => {
    mockFetchSequence(okJson({ data: [dbRecord()] }));
    const client = makeClient();
    await expect(
      client.resolveOutput("ps-database", "acct1:ps-database:mydb", "weird", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  it("database stats ready", async () => {
    mockFetchSequence(okJson({ data: [dbRecord({ state: "ready" })] }));
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "ps-database",
      "acct1:ps-database:mydb",
      ACCOUNT,
    );
    expect(stats[1]).toMatchObject({ label: "State", value: "ready", variant: "status-healthy" });
  });

  it("database stats awaiting_import", async () => {
    mockFetchSequence(okJson({ data: [dbRecord({ state: "awaiting_import" })] }));
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "ps-database",
      "acct1:ps-database:mydb",
      ACCOUNT,
    );
    expect(stats[1].variant).toBe("status-degraded");
  });

  it("database stats error variant", async () => {
    mockFetchSequence(okJson({ data: [dbRecord({ state: "broken" })] }));
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "ps-database",
      "acct1:ps-database:mydb",
      ACCOUNT,
    );
    expect(stats[1].variant).toBe("status-error");
  });

  it("branch stats", async () => {
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "mydb" })] }),
      okJson({ data: [branchRecord({ production: true, ready: false })] }),
    );
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "ps-branch",
      "acct1:ps-branch:mydb/main",
      ACCOUNT,
    );
    expect(stats).toEqual([
      { label: "Production", value: "Yes" },
      { label: "Ready", value: "No" },
    ]);
  });

  it("default stats counts databases", async () => {
    mockFetchSequence(okJson({ data: [dbRecord(), dbRecord({ name: "db2" })] }));
    const client = makeClient();
    const stats = await client.fetchDashboardStats("ps-org", "x", ACCOUNT);
    expect(stats).toEqual([
      { label: "Version", value: "PlanetScale" },
      { label: "Databases", value: "2" },
    ]);
  });
});

describe("renderDetail", () => {
  const base = {
    pluginId: "planetscale",
    accountId: ACCOUNT,
    resolvedOutputs: {},
    secretStates: [],
  };

  it("renders database detail (ready, htmlUrl present)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "ps-database",
      displayName: "mydb",
      fields: {
        region: "us-east",
        state: "ready",
        htmlUrl: "http://x",
        createdAt: "c",
        updatedAt: "u",
      },
    } as never);
    expect(d.status).toMatchObject({ status: "healthy" });
    expect(d.subtitle).toContain("Virginia");
  });

  it("renders database detail awaiting_import / no htmlUrl", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "ps-database",
      displayName: "mydb",
      fields: { region: "unknown-region", state: "awaiting_import" },
    } as never);
    expect(d.status).toMatchObject({ status: "provisioning" });
    expect(d.subtitle).toContain("unknown-region");
  });

  it("renders database detail error state", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "ps-database",
      displayName: "mydb",
      fields: { region: "us-east", state: "broken" },
    } as never);
    expect(d.status).toMatchObject({ status: "error" });
  });

  it("renders branch detail (ready, production, parent, safe migrations)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "ps-branch",
      displayName: "dev",
      fields: {
        databaseName: "mydb",
        production: true,
        ready: true,
        safeMigrations: true,
        parentBranch: "main",
        createdAt: "c",
      },
    } as never);
    expect(d.status).toMatchObject({ status: "healthy" });
    expect(d.sqlEditor).toBeTruthy();
  });

  it("renders branch detail (not ready, no parent)", () => {
    const client = makeClient();
    const d = client.renderDetail({
      ...base,
      id: "x",
      resourceTypeId: "ps-branch",
      displayName: "dev",
      fields: { databaseName: "mydb", production: false, ready: false, safeMigrations: false },
    } as never);
    expect(d.status).toMatchObject({ status: "provisioning" });
  });

  it("renders generic detail for unknown type", () => {
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
  it("database ready -> healthy", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "d",
      resourceTypeId: "ps-database",
      fields: { state: "ready" },
    } as never);
    expect(item.status).toMatchObject({ status: "healthy" });
  });
  it("database awaiting_import -> provisioning", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "d",
      resourceTypeId: "ps-database",
      fields: { state: "awaiting_import" },
    } as never);
    expect(item.status).toMatchObject({ status: "provisioning" });
  });
  it("database other -> error", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "d",
      resourceTypeId: "ps-database",
      fields: { state: "x" },
    } as never);
    expect(item.status).toMatchObject({ status: "error" });
  });
  it("branch production label + ready", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "main",
      resourceTypeId: "ps-branch",
      fields: { ready: true, production: true },
    } as never);
    expect(item.label).toBe("main (production)");
    expect(item.status).toMatchObject({ status: "healthy" });
  });
  it("branch not ready -> provisioning", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "dev",
      resourceTypeId: "ps-branch",
      fields: { ready: false, production: false },
    } as never);
    expect(item.status).toMatchObject({ status: "provisioning" });
  });
  it("unknown -> info", () => {
    const client = makeClient();
    const item = client.renderSidebarItem({
      id: "x",
      displayName: "o",
      resourceTypeId: "other",
      fields: {},
    } as never);
    expect(item.status).toMatchObject({ status: "info" });
  });
});

describe("getCreateConfig", () => {
  it("database config has region picker", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("ps-database");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "region"]);
  });

  it("branch config without parent lists databases + branches, defaults main", async () => {
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "db1" })] }),
      okJson({ data: [branchRecord({ name: "main" }), branchRecord({ name: "dev" })] }),
    );
    const client = makeClient();
    const cfg = await client.getCreateConfig("ps-branch");
    expect(cfg.fields.map((f) => f.key)).toEqual(["databaseName", "name", "parentBranch"]);
    const parent = cfg.fields.find((f) => f.key === "parentBranch");
    expect(parent).toMatchObject({ defaultValue: "main" });
  });

  it("branch config defaults to first branch when no main", async () => {
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "db1" })] }),
      okJson({ data: [branchRecord({ name: "dev" })] }),
    );
    const client = makeClient();
    const cfg = await client.getCreateConfig("ps-branch");
    const parent = cfg.fields.find((f) => f.key === "parentBranch");
    expect(parent).toMatchObject({ defaultValue: "dev" });
  });

  it("branch config with parent omits database selector and uses parent db", async () => {
    mockFetchSequence(
      okJson({ data: [dbRecord({ name: "db1" })] }),
      okJson({ data: [branchRecord({ name: "main" })] }),
    );
    const client = makeClient();
    const cfg = await client.getCreateConfig("ps-branch", "acct1:ps-database:mydb");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "parentBranch"]);
    // branchSourceDb should be the parent external id "mydb"
    const branchCallUrl = fetchMock.mock.calls[1][0];
    expect(branchCallUrl).toContain("/databases/mydb/branches");
  });

  it("branch config with no databases and no parent yields empty branch options", async () => {
    mockFetchSequence(okJson({ data: [] }));
    const client = makeClient();
    const cfg = await client.getCreateConfig("ps-branch");
    const parent = cfg.fields.find((f) => f.key === "parentBranch");
    expect(parent).not.toHaveProperty("defaultValue");
  });

  it("throws unknown type", async () => {
    const client = makeClient();
    await expect(client.getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates database", async () => {
    mockFetchSequence(okJson({ data: dbRecord({ name: "newdb" }) }));
    const client = makeClient();
    const res = await client.createResource("ps-database", ACCOUNT, {
      name: "newdb",
      region: "us-east",
    });
    expect(res.id).toBe("acct1:ps-database:newdb");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/organizations/myorg/databases");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "newdb", region: "us-east" });
  });

  it("creates database with defaults when fields missing", async () => {
    mockFetchSequence(okJson({ data: { name: "d", region: undefined } }));
    const client = makeClient();
    const res = await client.createResource("ps-database", ACCOUNT, {
      name: "d",
      region: "us-east",
    });
    expect(res.fields.state).toBe("ready");
  });

  it("creates branch using fields.databaseName", async () => {
    mockFetchSequence(okJson({ data: branchRecord({ name: "feat", production: false }) }));
    const client = makeClient();
    const res = await client.createResource("ps-branch", ACCOUNT, {
      databaseName: "mydb",
      name: "feat",
      parentBranch: "main",
    });
    expect(res.id).toBe("acct1:ps-branch:mydb/feat");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/databases/mydb/branches");
    expect(JSON.parse(init.body)).toEqual({ name: "feat", parent_branch: "main" });
  });

  it("creates branch using parent resource id", async () => {
    mockFetchSequence(okJson({ data: branchRecord({ name: "feat" }) }));
    const client = makeClient();
    const res = await client.createResource(
      "ps-branch",
      ACCOUNT,
      { name: "feat", parentBranch: "main" },
      "acct1:ps-database:mydb",
    );
    expect(res.fields.databaseName).toBe("mydb");
  });

  it("throws unknown create type", async () => {
    const client = makeClient();
    await expect(client.createResource("nope", ACCOUNT, {})).rejects.toThrow(/cannot create type/);
  });
});

describe("deleteResource", () => {
  it("deletes database with DELETE method", async () => {
    mockFetchSequence({ ok: true, status: 204 });
    const client = makeClient();
    await client.deleteResource("ps-database", "acct1:ps-database:mydb", ACCOUNT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/organizations/myorg/databases/mydb");
    expect(init.method).toBe("DELETE");
  });

  it("deletes branch", async () => {
    mockFetchSequence({ ok: true, status: 204 });
    const client = makeClient();
    await client.deleteResource("ps-branch", "acct1:ps-branch:mydb/main", ACCOUNT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/databases/mydb/branches/main");
  });

  it("throws unknown delete type", async () => {
    const client = makeClient();
    await expect(client.deleteResource("nope", "acct1:nope:x", ACCOUNT)).rejects.toThrow(
      /cannot delete type/,
    );
  });
});

describe("caCert + host http path", () => {
  it("routes via host http service when caCert+http present", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ data: [dbRecord()] }),
    }));
    const client = makeClient({ caCert: "PEMCERT" });
    // inject services via second constructor arg
    const client2 = new PlanetScaleClient({ ...creds, caCert: "PEMCERT" }, {
      http: { request },
    } as never);
    const res = await client2.listResources("ps-database", ACCOUNT);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ caCert: "PEMCERT", method: "GET" }),
    );
    expect(res[0].externalId).toBe("mydb");
    // direct-fetch client still works
    mockFetchSequence(okJson({ data: [] }));
    expect(await client.listResources("ps-database", ACCOUNT)).toEqual([]);
  });
});
