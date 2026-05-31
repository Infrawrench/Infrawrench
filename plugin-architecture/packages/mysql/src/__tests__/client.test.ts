import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HostServices, ResourceInstance, SqlHostServices } from "@infrawrench/plugin-base";
import { MySQLClient } from "../client.js";

const CS = "mysql://user:pass@db.example.com:3306/appdb";

function makeSql() {
  return { query: vi.fn(), execute: vi.fn() };
}
function services(sql: SqlHostServices): HostServices {
  return { sql } as HostServices;
}
function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:mysql-database:appdb",
    pluginId: "mysql",
    resourceTypeId: "mysql-database",
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
const ctx = {
  tabLabel: "x",
  parentPluginId: "p",
  parentResourceTypeId: "t",
  parentResourceId: "r",
  accountId: "acct",
};

describe("MySQLClient", () => {
  let sql: ReturnType<typeof makeSql>;
  beforeEach(() => {
    sql = makeSql();
  });

  describe("constructor", () => {
    it("throws when connectionString missing", () => {
      expect(() => new MySQLClient({})).toThrow(/missing connectionString/);
    });
  });

  describe("listResources", () => {
    it("queries SHOW DATABASES and filters system dbs", async () => {
      sql.query.mockResolvedValue([
        { Database: "appdb" },
        { Database: "mysql" },
        { Database: "sys" },
        { Database: "shop" },
      ]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const res = await c.listResources("mysql-database", "acct");
      expect(res.map((r) => r.displayName)).toEqual(["appdb", "shop"]);
      expect(res[0]!.fields["host"]).toBe("db.example.com");
    });

    it("catalog branch host unknown on bad CS", async () => {
      sql.query.mockResolvedValue([{ Database: "appdb" }]);
      const c = new MySQLClient({ connectionString: "garbage" }, services(sql));
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("falls back to URL parsing on query error", async () => {
      sql.query.mockRejectedValue(new Error("boom"));
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const res = await c.listResources("mysql-database", "acct");
      expect(res).toHaveLength(1);
      expect(res[0]!.displayName).toBe("appdb");
    });

    it("falls back without sql service", async () => {
      const c = new MySQLClient({ connectionString: CS });
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.fields["database"]).toBe("appdb");
    });

    it("uses defaults when CS unparseable", async () => {
      const c = new MySQLClient({ connectionString: "garbage" });
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.displayName).toBe("mysql");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("defaults db name when path empty", async () => {
      const c = new MySQLClient({ connectionString: "mysql://host:3306/" });
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.displayName).toBe("mysql");
    });

    it("throws on unknown type", async () => {
      const c = new MySQLClient({ connectionString: CS });
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });
  });

  describe("getResource", () => {
    it("returns matching", async () => {
      sql.query.mockResolvedValue([{ Database: "appdb" }]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const r = await c.getResource("mysql-database", "acct:mysql-database:appdb", "acct");
      expect(r.displayName).toBe("appdb");
    });
    it("throws when not found", async () => {
      sql.query.mockResolvedValue([{ Database: "appdb" }]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.getResource("mysql-database", "acct:mysql-database:x", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("throws (unsupported)", async () => {
      const c = new MySQLClient({ connectionString: CS });
      await expect(c.resolveOutput("mysql-database", "x", "connectionString")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("deleteResource", () => {
    it("drops a database", async () => {
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      await c.deleteResource("mysql-database", "acct:mysql-database:shop", "acct");
      expect(sql.execute).toHaveBeenCalledWith("DROP DATABASE `shop`", []);
    });
    it("throws on unsupported type", async () => {
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("x", "a:x:y", "acct")).rejects.toThrow(/not supported/);
    });
    it("throws when sql service missing", async () => {
      const c = new MySQLClient({ connectionString: CS });
      await expect(
        c.deleteResource("mysql-database", "a:mysql-database:x", "acct"),
      ).rejects.toThrow(/SQL service not available/);
    });
    it("throws when name unparseable", async () => {
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("mysql-database", "", "acct")).rejects.toThrow(
        /Cannot parse database name/,
      );
    });
    it("refuses system database", async () => {
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.deleteResource("mysql-database", "a:mysql-database:mysql", "acct"),
      ).rejects.toThrow(/system database/);
    });
    it("rejects backtick in name", async () => {
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      await expect(
        c.deleteResource("mysql-database", "a:mysql-database:bad`name", "acct"),
      ).rejects.toThrow(/Invalid database name/);
    });
  });

  describe("renderDetail", () => {
    it("renders connection section and sqlEditor", () => {
      const c = new MySQLClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource());
      expect(schema.title).toBe("appdb");
      expect(schema.sqlEditor?.connectionStringOutputKey).toBe("connectionString");
    });
    it("parses __tables__", () => {
      const c = new MySQLClient({ connectionString: CS });
      const tables = [{ name: "t", columns: [{ name: "id", type: "int" }] }];
      const schema = c.renderDetail(
        makeResource({ resolvedOutputs: { __tables__: JSON.stringify(tables) } }),
      );
      expect(schema.sqlEditor?.tables).toEqual(tables);
    });
    it("ignores invalid __tables__", () => {
      const c = new MySQLClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ resolvedOutputs: { __tables__: "{bad" } }));
      expect(schema.sqlEditor?.tables).toEqual([]);
    });
    it("uses fallback labels", () => {
      const c = new MySQLClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ fields: {} }));
      expect(schema.subtitle).toContain("MySQL");
    });
  });

  describe("renderSidebarItem", () => {
    it("returns item", () => {
      const c = new MySQLClient({ connectionString: CS });
      expect(c.renderSidebarItem(makeResource())).toMatchObject({ label: "appdb" });
    });
  });

  describe("renderPeerPane", () => {
    it("lists non-system databases", async () => {
      sql.query.mockResolvedValue([
        { Database: "appdb" },
        { Database: "mysql" },
        { Database: "shop" },
      ]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items.map((i) => i.displayName)).toEqual(["appdb", "shop"]);
    });
    it("empty without sql service", async () => {
      const c = new MySQLClient({ connectionString: CS });
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items).toEqual([]);
    });
    it("tolerates unparseable CS", async () => {
      sql.query.mockResolvedValue([]);
      const c = new MySQLClient({ connectionString: "garbage" }, services(sql));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups).toHaveLength(1);
    });
  });

  describe("introspect", () => {
    it("returns empty without sql service", async () => {
      const c = new MySQLClient({ connectionString: CS });
      expect(await c.introspect()).toEqual([]);
    });
    it("maps tables/columns/pks", async () => {
      sql.query
        .mockResolvedValueOnce([{ table_name: "users" }, { table_name: "orders" }])
        .mockResolvedValueOnce([
          { table_name: "users", column_name: "id", data_type: "int" },
          { table_name: "orders", column_name: "id", data_type: "int" },
        ])
        .mockResolvedValueOnce([{ table_name: "users", column_name: "id" }]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const meta = await c.introspect();
      expect(meta).toEqual([
        { name: "users", columns: [{ name: "id", type: "int" }], pkColumns: ["id"] },
        { name: "orders", columns: [{ name: "id", type: "int" }], pkColumns: [] },
      ]);
    });
  });

  describe("fetchDashboardStats", () => {
    it("placeholder without sql service", async () => {
      const c = new MySQLClient({ connectionString: CS });
      const stats = await c.fetchDashboardStats("mysql-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Size", value: "" },
        { label: "Tables", value: "0" },
      ]);
    });
    it("queries version/size/tables", async () => {
      sql.query
        .mockResolvedValueOnce([{ version: "8.0.36" }])
        .mockResolvedValueOnce([{ size: "12.3 MB" }])
        .mockResolvedValueOnce([{ n: 4 }]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const stats = await c.fetchDashboardStats("mysql-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "8.0.36" },
        { label: "Size", value: "12.3 MB" },
        { label: "Tables", value: "4" },
      ]);
    });
    it("handles empty rows", async () => {
      sql.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const c = new MySQLClient({ connectionString: CS }, services(sql));
      const stats = await c.fetchDashboardStats("mysql-database", "x", "acct");
      expect(stats[2]).toEqual({ label: "Tables", value: "0" });
    });
  });
});
