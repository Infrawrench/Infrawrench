import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HostServices, ResourceInstance, SqlHostServices } from "@infrawrench/plugin-base";
import { MSSQLClient } from "../client.js";

const CS = "mssql://sa:pass@db.example.com:1433/appdb";

function makeSql() {
  return { query: vi.fn(), execute: vi.fn() };
}
function services(sql: SqlHostServices): HostServices {
  return { sql } as HostServices;
}
function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:mssql-database:appdb",
    pluginId: "mssql",
    resourceTypeId: "mssql-database",
    accountId: "acct",
    displayName: "appdb",
    fields: { host: "db.example.com", database: "appdb" },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...over,
  };
}

describe("MSSQLClient", () => {
  let sql: ReturnType<typeof makeSql>;
  beforeEach(() => {
    sql = makeSql();
  });

  describe("constructor", () => {
    it("throws when connectionString missing", () => {
      expect(() => new MSSQLClient({})).toThrow(/missing connectionString/);
    });
  });

  describe("listResources", () => {
    it("queries sys.databases", async () => {
      sql.query.mockResolvedValue([{ name: "appdb" }, { name: "shop" }]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const res = await c.listResources("mssql-database", "acct");
      expect(res.map((r) => r.displayName)).toEqual(["appdb", "shop"]);
      expect(res[0]!.fields["host"]).toBe("db.example.com");
      expect(sql.query).toHaveBeenCalledWith(expect.stringContaining("sys.databases"));
    });

    it("catalog branch host unknown on bad CS", async () => {
      sql.query.mockResolvedValue([{ name: "appdb" }]);
      const c = new MSSQLClient({ connectionString: "garbage" }, services(sql));
      const res = await c.listResources("mssql-database", "acct");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("falls back to URL parsing on query error", async () => {
      sql.query.mockRejectedValue(new Error("boom"));
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const res = await c.listResources("mssql-database", "acct");
      expect(res[0]!.displayName).toBe("appdb");
    });

    it("falls back without sql service", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      const res = await c.listResources("mssql-database", "acct");
      expect(res[0]!.fields["database"]).toBe("appdb");
    });

    it("uses defaults on unparseable CS", async () => {
      const c = new MSSQLClient({ connectionString: "garbage" });
      const res = await c.listResources("mssql-database", "acct");
      expect(res[0]!.displayName).toBe("master");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("defaults to master when path empty", async () => {
      const c = new MSSQLClient({ connectionString: "mssql://u:p@host/" });
      const res = await c.listResources("mssql-database", "acct");
      expect(res[0]!.displayName).toBe("master");
    });

    it("throws on unknown type", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });
  });

  describe("getResource", () => {
    it("returns matching", async () => {
      sql.query.mockResolvedValue([{ name: "appdb" }]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const r = await c.getResource("mssql-database", "acct:mssql-database:appdb", "acct");
      expect(r.displayName).toBe("appdb");
    });
    it("throws when not found", async () => {
      sql.query.mockResolvedValue([{ name: "appdb" }]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.getResource("mssql-database", "acct:mssql-database:x", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("resolves connection string for selected database", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(
        c.resolveOutput("mssql-database", "acct:mssql-database:shop", "connectionString"),
      ).resolves.toBe("mssql://sa:pass@db.example.com:1433/shop");
    });

    it("resolves server version first line", async () => {
      sql.query.mockResolvedValue([{ version: "Microsoft SQL Server 2022\nbuild info" }]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(c.resolveOutput("mssql-database", "x", "serverVersion")).resolves.toBe(
        "Microsoft SQL Server 2022",
      );
      expect(sql.query).toHaveBeenCalledWith("SELECT @@VERSION AS version");
    });

    it("returns empty version without sql service", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(c.resolveOutput("mssql-database", "x", "serverVersion")).resolves.toBe("");
    });

    it("throws for unsupported output", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(c.resolveOutput("mssql-database", "x", "x")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("getCreateConfig", () => {
    it("returns database create fields", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      const cfg = await c.getCreateConfig("mssql-database");
      expect(cfg.fields.map((f) => f.key)).toEqual(["name", "collation"]);
    });

    it("throws for unsupported type", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(c.getCreateConfig("x")).rejects.toThrow(/no create config/);
    });
  });

  describe("createResource", () => {
    it("creates a database", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const res = await c.createResource("mssql-database", "acct", { name: "shop" });
      expect(sql.execute).toHaveBeenCalledWith("CREATE DATABASE [shop]", []);
      expect(res).toMatchObject({
        id: "acct:mssql-database:shop",
        displayName: "shop",
        externalId: "shop",
        fields: { host: "db.example.com", database: "shop" },
      });
    });

    it("creates with collation", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await c.createResource("mssql-database", "acct", {
        name: "shop",
        collation: "SQL_Latin1_General_CP1_CI_AS",
      });
      expect(sql.execute).toHaveBeenCalledWith(
        "CREATE DATABASE [shop] COLLATE SQL_Latin1_General_CP1_CI_AS",
        [],
      );
    });

    it("throws when sql service missing", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(c.createResource("mssql-database", "acct", { name: "shop" })).rejects.toThrow(
        /SQL service not available/,
      );
    });

    it("rejects invalid names and collation", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.createResource("mssql-database", "acct", { name: "bad]name" }),
      ).rejects.toThrow(/Invalid database name/);
      await expect(
        c.createResource("mssql-database", "acct", {
          name: "shop",
          collation: "bad-name",
        }),
      ).rejects.toThrow(/Invalid SQL Server identifier/);
    });

    it("refuses system database names", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(c.createResource("mssql-database", "acct", { name: "master" })).rejects.toThrow(
        /system database/,
      );
    });

    it("throws on unsupported type", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(c.createResource("x", "acct", { name: "shop" })).rejects.toThrow(
        /not supported/,
      );
    });
  });

  describe("deleteResource", () => {
    it("drops a database", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await c.deleteResource("mssql-database", "acct:mssql-database:shop", "acct");
      expect(sql.execute).toHaveBeenCalledWith("DROP DATABASE [shop]", []);
    });
    it("throws on unsupported type", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("x", "a:x:y", "acct")).rejects.toThrow(/not supported/);
    });
    it("throws when sql service missing", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      await expect(
        c.deleteResource("mssql-database", "a:mssql-database:x", "acct"),
      ).rejects.toThrow(/SQL service not available/);
    });
    it("throws when name unparseable", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("mssql-database", "", "acct")).rejects.toThrow(
        /Cannot parse database name/,
      );
    });
    it("refuses system database", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.deleteResource("mssql-database", "a:mssql-database:master", "acct"),
      ).rejects.toThrow(/system database/);
    });
    it("rejects bracket in name", async () => {
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.deleteResource("mssql-database", "a:mssql-database:bad]name", "acct"),
      ).rejects.toThrow(/Invalid database name/);
    });
  });

  describe("renderDetail", () => {
    it("renders connection section and sqlEditor", () => {
      const c = new MSSQLClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource());
      expect(schema.title).toBe("appdb");
      expect(schema.sqlEditor?.connectionStringOutputKey).toBe("connectionString");
    });
    it("parses __tables__", () => {
      const c = new MSSQLClient({ connectionString: CS });
      const tables = [{ name: "dbo.t", columns: [{ name: "id", type: "int" }] }];
      const schema = c.renderDetail(
        makeResource({ resolvedOutputs: { __tables__: JSON.stringify(tables) } }),
      );
      expect(schema.sqlEditor?.tables).toEqual(tables);
    });
    it("ignores invalid __tables__", () => {
      const c = new MSSQLClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ resolvedOutputs: { __tables__: "{bad" } }));
      expect(schema.sqlEditor?.tables).toEqual([]);
    });
    it("uses fallback labels", () => {
      const c = new MSSQLClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ fields: {} }));
      expect(schema.subtitle).toContain("SQL Server");
    });
  });

  describe("renderSidebarItem", () => {
    it("returns item", () => {
      const c = new MSSQLClient({ connectionString: CS });
      expect(c.renderSidebarItem(makeResource())).toMatchObject({ label: "appdb" });
    });
  });

  describe("introspect", () => {
    it("returns empty without sql service", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      expect(await c.introspect()).toEqual([]);
    });
    it("maps tables/columns/pks", async () => {
      sql.query
        .mockResolvedValueOnce([{ name: "dbo.users" }, { name: "dbo.orders" }])
        .mockResolvedValueOnce([
          { table_name: "dbo.users", column_name: "id", data_type: "int" },
          { table_name: "dbo.orders", column_name: "id", data_type: "int" },
        ])
        .mockResolvedValueOnce([{ table_name: "dbo.users", column_name: "id" }]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const meta = await c.introspect();
      expect(meta).toEqual([
        { name: "dbo.users", columns: [{ name: "id", type: "int" }], pkColumns: ["id"] },
        { name: "dbo.orders", columns: [{ name: "id", type: "int" }], pkColumns: [] },
      ]);
      expect(sql.query).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA"),
      );
    });
  });

  describe("fetchDashboardStats", () => {
    it("placeholder without sql service", async () => {
      const c = new MSSQLClient({ connectionString: CS });
      const stats = await c.fetchDashboardStats("mssql-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Tables", value: "0" },
      ]);
    });
    it("queries version (first line) and table count", async () => {
      sql.query
        .mockResolvedValueOnce([{ version: "Microsoft SQL Server 2022\nbuild info\nmore" }])
        .mockResolvedValueOnce([{ n: 9 }]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const stats = await c.fetchDashboardStats("mssql-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "Microsoft SQL Server 2022" },
        { label: "Tables", value: "9" },
      ]);
    });
    it("handles empty rows", async () => {
      sql.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const c = new MSSQLClient({ connectionString: CS }, services(sql));
      const stats = await c.fetchDashboardStats("mssql-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Tables", value: "0" },
      ]);
    });
  });
});
