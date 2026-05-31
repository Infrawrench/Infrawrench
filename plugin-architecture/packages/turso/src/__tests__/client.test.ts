import { describe, it, expect, vi, beforeEach } from "vitest";

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
};

const createClient = vi.fn(() => api);

vi.mock("@tursodatabase/api", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
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
  it("maps databases", async () => {
    api.databases.list.mockResolvedValue([
      {
        name: "mydb",
        hostname: "mydb-myorg.turso.io",
        group: "default",
        primaryRegion: "iad",
        regions: ["iad", "lhr"],
        version: "0.24",
        is_schema: false,
        schema: "",
        sleeping: false,
      },
    ]);
    const client = makeClient();
    const res = await client.listResources("turso-database", ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:turso-database:mydb",
      pluginId: "turso",
      externalId: "mydb",
      fields: { name: "mydb", group: "default", regions: "iad, lhr" },
    });
  });

  it("maps databases with missing optional fields", async () => {
    api.databases.list.mockResolvedValue([
      { name: "d", hostname: "h", version: "1", is_schema: false, sleeping: false },
    ]);
    const client = makeClient();
    const res = await client.listResources("turso-database", ACCOUNT);
    expect(res[0].fields).toMatchObject({ group: "", primaryRegion: "", regions: "" });
  });

  it("maps groups", async () => {
    api.groups.list.mockResolvedValue([{ name: "g1", primary: "iad", locations: ["iad", "lhr"] }]);
    const client = makeClient();
    const res = await client.listResources("turso-group", ACCOUNT);
    expect(res[0]).toMatchObject({
      id: "acct1:turso-group:g1",
      externalId: "g1",
      fields: { name: "g1", primaryLocation: "iad", locations: "iad, lhr" },
    });
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.listResources("nope", ACCOUNT)).rejects.toThrow(/unknown resource type/);
  });
});

describe("getResource", () => {
  it("returns found", async () => {
    api.databases.list.mockResolvedValue([{ name: "d", hostname: "h", version: "1" }]);
    const client = makeClient();
    const r = await client.getResource("turso-database", "acct1:turso-database:d", ACCOUNT);
    expect(r.externalId).toBe("d");
  });

  it("throws not found", async () => {
    api.databases.list.mockResolvedValue([]);
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
    api.databases.list.mockResolvedValue([{ name: "mydb", hostname: "h.turso.io", version: "1" }]);
    const client = makeClient();
    const id = "acct1:turso-database:mydb";
    expect(await client.resolveOutput("turso-database", id, "hostname", ACCOUNT)).toBe(
      "h.turso.io",
    );
    expect(await client.resolveOutput("turso-database", id, "dbName", ACCOUNT)).toBe("mydb");
  });

  it("resolves group outputs", async () => {
    api.groups.list.mockResolvedValue([{ name: "g1", primary: "iad", locations: ["iad"] }]);
    const client = makeClient();
    const id = "acct1:turso-group:g1";
    expect(await client.resolveOutput("turso-group", id, "groupName", ACCOUNT)).toBe("g1");
    expect(await client.resolveOutput("turso-group", id, "primaryLocation", ACCOUNT)).toBe("iad");
  });

  it("throws for unresolvable", async () => {
    api.groups.list.mockResolvedValue([{ name: "g1", primary: "iad", locations: ["iad"] }]);
    const client = makeClient();
    await expect(
      client.resolveOutput("turso-group", "acct1:turso-group:g1", "weird", ACCOUNT),
    ).rejects.toThrow(/cannot resolve output/);
  });
});

describe("fetchDashboardStats", () => {
  it("database stats with sleeping", async () => {
    api.databases.list.mockResolvedValue([
      {
        name: "d",
        hostname: "h",
        group: "default",
        primaryRegion: "iad",
        version: "1",
        sleeping: true,
      },
    ]);
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "turso-database",
      "acct1:turso-database:d",
      ACCOUNT,
    );
    expect(stats[0]).toMatchObject({ label: "Group", value: "default" });
    expect(stats[1].value).toContain("Ashburn");
    expect(stats[stats.length - 1]).toMatchObject({
      value: "sleeping",
      variant: "status-degraded",
    });
  });

  it("database stats without sleeping", async () => {
    api.databases.list.mockResolvedValue([
      { name: "d", hostname: "h", group: "g", primaryRegion: "iad", version: "1", sleeping: false },
    ]);
    const client = makeClient();
    const stats = await client.fetchDashboardStats(
      "turso-database",
      "acct1:turso-database:d",
      ACCOUNT,
    );
    expect(stats).toHaveLength(3);
  });

  it("group stats", async () => {
    api.groups.list.mockResolvedValue([{ name: "g1", primary: "iad", locations: ["iad", "lhr"] }]);
    const client = makeClient();
    const stats = await client.fetchDashboardStats("turso-group", "acct1:turso-group:g1", ACCOUNT);
    expect(stats[0].value).toContain("Ashburn");
    expect(stats[1].label).toBe("Locations");
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
  it("database config lists groups", async () => {
    api.groups.list.mockResolvedValue([{ name: "g1", primary: "iad", locations: ["iad"] }]);
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-database");
    const group = cfg.fields.find((f) => f.key === "group");
    expect(group).toMatchObject({ defaultValue: "g1" });
  });

  it("database config with no groups omits default", async () => {
    api.groups.list.mockResolvedValue([]);
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-database");
    const group = cfg.fields.find((f) => f.key === "group");
    expect(group).not.toHaveProperty("defaultValue");
  });

  it("group config has region picker", async () => {
    const client = makeClient();
    const cfg = await client.getCreateConfig("turso-group");
    expect(cfg.fields.map((f) => f.key)).toEqual(["name", "location"]);
  });

  it("throws for unknown type", async () => {
    const client = makeClient();
    await expect(client.getCreateConfig("nope")).rejects.toThrow(/no create config/);
  });
});

describe("createResource", () => {
  it("creates database with group and schema flag", async () => {
    api.databases.create.mockResolvedValue({ name: "newdb", hostname: "newdb-myorg.turso.io" });
    const client = makeClient();
    const res = await client.createResource("turso-database", ACCOUNT, {
      name: "newdb",
      group: "default",
      isSchema: "true",
    });
    expect(res.id).toBe("acct1:turso-database:newdb");
    expect(api.databases.create).toHaveBeenCalledWith("newdb", {
      group: "default",
      is_schema: true,
    });
    expect(res.fields.isSchema).toBe(true);
  });

  it("creates database without group/schema", async () => {
    api.databases.create.mockResolvedValue({ name: "d2", hostname: "h" });
    const client = makeClient();
    const res = await client.createResource("turso-database", ACCOUNT, { name: "d2" });
    expect(api.databases.create).toHaveBeenCalledWith("d2", {});
    expect(res.fields.group).toBe("");
  });

  it("database create throws without name", async () => {
    const client = makeClient();
    await expect(client.createResource("turso-database", ACCOUNT, {})).rejects.toThrow(
      /missing database name/,
    );
  });

  it("creates group", async () => {
    api.groups.create.mockResolvedValue({ name: "g2", primary: "iad", locations: ["iad"] });
    const client = makeClient();
    const res = await client.createResource("turso-group", ACCOUNT, {
      name: "g2",
      location: "iad",
    });
    expect(res.id).toBe("acct1:turso-group:g2");
    expect(api.groups.create).toHaveBeenCalledWith("g2", "iad");
  });

  it("creates group with missing locations array", async () => {
    api.groups.create.mockResolvedValue({ name: "g3", primary: "iad" });
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
