import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HostServices, ResourceInstance, SqlHostServices } from "@infrawrench/plugin-base";
import { PostgresClient } from "../client.js";

const CS = "postgresql://user:pass@db.example.com:5432/appdb";

function makeSql(): SqlHostServices & {
  query: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(),
    execute: vi.fn(),
  };
}

function services(sql?: SqlHostServices): HostServices {
  return { sql } as HostServices;
}

function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:pg-database:appdb",
    pluginId: "postgres",
    resourceTypeId: "pg-database",
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

describe("PostgresClient", () => {
  let sql: ReturnType<typeof makeSql>;

  beforeEach(() => {
    sql = makeSql();
  });

  describe("constructor / requireConnection", () => {
    it("tolerates missing connectionString", () => {
      const c = new PostgresClient({});
      expect(c).toBeInstanceOf(PostgresClient);
    });

    it("renderPeerPane throws when connection missing", async () => {
      const c = new PostgresClient({});
      await expect(
        c.renderPeerPane({
          tabLabel: "x",
          parentPluginId: "p",
          parentResourceTypeId: "t",
          parentResourceId: "r",
          accountId: "acct",
        }),
      ).rejects.toThrow(/connection is not available/i);
    });
  });

  describe("listResources", () => {
    it("queries the catalog when sql service present", async () => {
      sql.query.mockResolvedValue([{ datname: "appdb" }, { datname: "other" }]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const res = await c.listResources("pg-database", "acct");
      expect(res).toHaveLength(2);
      expect(res[0]!.id).toBe("acct:pg-database:appdb");
      expect(res[0]!.fields["host"]).toBe("db.example.com");
      expect(sql.query).toHaveBeenCalledWith(expect.stringContaining("pg_catalog.pg_database"));
    });

    it("falls back to URL parsing when sql query throws", async () => {
      sql.query.mockRejectedValue(new Error("boom"));
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const res = await c.listResources("pg-database", "acct");
      expect(res).toHaveLength(1);
      expect(res[0]!.displayName).toBe("appdb");
      expect(res[0]!.fields["host"]).toBe("db.example.com");
    });

    it("falls back when no sql service (URL parse)", async () => {
      const c = new PostgresClient({ connectionString: CS });
      const res = await c.listResources("pg-database", "acct");
      expect(res[0]!.fields["database"]).toBe("appdb");
    });

    it("uses defaults when connection string unparseable", async () => {
      const c = new PostgresClient({ connectionString: "not a url" });
      const res = await c.listResources("pg-database", "acct");
      expect(res[0]!.displayName).toBe("postgres");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("defaults db name to postgres when path empty", async () => {
      const c = new PostgresClient({ connectionString: "postgresql://host:5432/" });
      const res = await c.listResources("pg-database", "acct");
      expect(res[0]!.displayName).toBe("postgres");
    });

    it("catalog branch sets host=unknown when CS unparseable", async () => {
      sql.query.mockResolvedValue([{ datname: "x" }]);
      const c = new PostgresClient({ connectionString: "garbage" }, services(sql));
      const res = await c.listResources("pg-database", "acct");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("listSchemas returns empty", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      expect(await c.listResources("pg-schema", "acct")).toEqual([]);
    });

    it("throws on unknown type", async () => {
      const c = new PostgresClient({ connectionString: CS });
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });
  });

  describe("getResource", () => {
    it("returns the matching resource", async () => {
      sql.query.mockResolvedValue([{ datname: "appdb" }]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const r = await c.getResource("pg-database", "acct:pg-database:appdb", "acct");
      expect(r.displayName).toBe("appdb");
    });

    it("throws when not found", async () => {
      sql.query.mockResolvedValue([{ datname: "appdb" }]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await expect(
        c.getResource("pg-database", "acct:pg-database:missing", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("returns the connection string", async () => {
      const c = new PostgresClient({ connectionString: CS });
      expect(await c.resolveOutput("pg-database", "x", "connectionString", "acct")).toBe(CS);
    });
    it("returns serverVersion", async () => {
      const c = new PostgresClient({ connectionString: CS });
      expect(await c.resolveOutput("pg-database", "x", "serverVersion", "acct")).toMatch(/Postgre/);
    });
    it("returns schemaNames json", async () => {
      const c = new PostgresClient({ connectionString: CS });
      expect(await c.resolveOutput("pg-database", "x", "schemaNames", "acct")).toBe('["public"]');
    });
    it("throws for unknown output", async () => {
      const c = new PostgresClient({ connectionString: CS });
      await expect(c.resolveOutput("pg-database", "x", "nope", "acct")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
    it("throws for wrong type", async () => {
      const c = new PostgresClient({ connectionString: CS });
      await expect(c.resolveOutput("pg-schema", "x", "connectionString", "acct")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("deleteResource", () => {
    it("drops a database", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await c.deleteResource("pg-database", "acct:pg-database:appdb", "acct");
      expect(sql.execute).toHaveBeenCalledWith('DROP DATABASE "appdb"', []);
    });

    it("drops a schema with cascade", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await c.deleteResource("pg-schema", "acct:pg-schema:myschema", "acct");
      expect(sql.execute).toHaveBeenCalledWith('DROP SCHEMA "myschema" CASCADE', []);
    });

    it("refuses system databases", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await expect(
        c.deleteResource("pg-database", "a:pg-database:postgres", "acct"),
      ).rejects.toThrow(/system database/);
    });

    it("refuses system schemas", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("pg-schema", "a:pg-schema:public", "acct")).rejects.toThrow(
        /system schema/,
      );
    });

    it("rejects identifiers with quotes", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await expect(
        c.deleteResource("pg-database", 'a:pg-database:bad"name', "acct"),
      ).rejects.toThrow(/Invalid identifier/);
    });

    it("throws when sql service missing", async () => {
      const c = new PostgresClient({ connectionString: CS });
      await expect(c.deleteResource("pg-database", "a:pg-database:x", "acct")).rejects.toThrow(
        /SQL service not available/,
      );
    });

    it("throws when name unparseable", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("pg-database", "", "acct")).rejects.toThrow(
        /Cannot parse resource name/,
      );
    });

    it("throws on unsupported type", async () => {
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      await expect(c.deleteResource("other", "a:other:x", "acct")).rejects.toThrow(/not supported/);
    });
  });

  describe("renderDetail", () => {
    it("renders healthy with secret state and reroll-secret action", () => {
      const c = new PostgresClient({ connectionString: CS });
      const schema = c.renderDetail(
        makeResource({
          secretStates: [
            { fieldKey: "connectionString", resolution: { kind: "literal" } } as never,
          ],
        }),
      );
      expect(schema.status).toMatchObject({ status: "healthy" });
      const json = JSON.stringify(schema);
      expect(json).toContain("reroll-secret");
      expect(schema.sqlEditor?.connectionStringOutputKey).toBe("connectionString");
    });

    it("renders reroll-parent-output action when no secret state but has connection", () => {
      const c = new PostgresClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource());
      expect(JSON.stringify(schema)).toContain("reroll-parent-output");
    });

    it("renders info status and no reroll when no connection", () => {
      const c = new PostgresClient({});
      const schema = c.renderDetail(makeResource());
      expect(schema.status).toMatchObject({ status: "info" });
      const json = JSON.stringify(schema);
      expect(json).not.toContain("reroll");
    });

    it("parses __tables__ json into sqlEditor tables", () => {
      const c = new PostgresClient({ connectionString: CS });
      const tables = [{ name: "users", columns: [{ name: "id", type: "int" }] }];
      const schema = c.renderDetail(
        makeResource({ resolvedOutputs: { __tables__: JSON.stringify(tables) } }),
      );
      expect(schema.sqlEditor?.tables).toEqual(tables);
    });

    it("ignores invalid __tables__ json", () => {
      const c = new PostgresClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ resolvedOutputs: { __tables__: "{not json" } }));
      expect(schema.sqlEditor?.tables).toEqual([]);
    });

    it("uses fallback host/database labels", () => {
      const c = new PostgresClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ fields: {} }));
      expect(schema.subtitle).toContain("PostgreSQL");
    });
  });

  describe("renderSidebarItem", () => {
    it("returns id/label/status", () => {
      const c = new PostgresClient({ connectionString: CS });
      const item = c.renderSidebarItem(makeResource());
      expect(item).toMatchObject({ id: "acct:pg-database:appdb", label: "appdb" });
    });
  });

  describe("renderPeerPane", () => {
    it("lists databases and schemas", async () => {
      sql.query
        .mockResolvedValueOnce([{ datname: "appdb" }])
        .mockResolvedValueOnce([{ schema_name: "public" }, { schema_name: "billing" }]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const pane = await c.renderPeerPane({
        tabLabel: "x",
        parentPluginId: "p",
        parentResourceTypeId: "t",
        parentResourceId: "r",
        accountId: "acct",
      });
      expect(pane.resourceGroups[0]!.items[0]!.id).toBe("acct:pg-database:appdb");
      expect(pane.resourceGroups[0]!.title).toContain("(1)");
      expect(pane.resourceGroups[1]!.items).toHaveLength(2);
    });

    it("returns empty groups when no sql service", async () => {
      const c = new PostgresClient({ connectionString: CS });
      const pane = await c.renderPeerPane({
        tabLabel: "x",
        parentPluginId: "p",
        parentResourceTypeId: "t",
        parentResourceId: "r",
        accountId: "acct",
      });
      expect(pane.resourceGroups[0]!.items).toEqual([]);
      expect(pane.resourceGroups[1]!.items).toEqual([]);
    });

    it("tolerates unparseable connection string for host", async () => {
      sql.query.mockResolvedValue([]);
      const c = new PostgresClient({ connectionString: "garbage" }, services(sql));
      const pane = await c.renderPeerPane({
        tabLabel: "x",
        parentPluginId: "p",
        parentResourceTypeId: "t",
        parentResourceId: "r",
        accountId: "acct",
      });
      expect(pane.resourceGroups).toHaveLength(2);
    });
  });

  describe("introspect", () => {
    it("returns empty when no sql service", async () => {
      const c = new PostgresClient({ connectionString: CS });
      expect(await c.introspect()).toEqual([]);
    });

    it("maps tables, columns, and primary keys", async () => {
      sql.query
        .mockResolvedValueOnce([{ table_name: "users" }, { table_name: "orders" }])
        .mockResolvedValueOnce([
          { table_name: "users", column_name: "id", data_type: "integer" },
          { table_name: "users", column_name: "name", data_type: "text" },
          { table_name: "orders", column_name: "id", data_type: "integer" },
        ])
        .mockResolvedValueOnce([{ table_name: "users", column_name: "id" }]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const meta = await c.introspect();
      expect(meta).toEqual([
        {
          name: "users",
          columns: [
            { name: "id", type: "integer" },
            { name: "name", type: "text" },
          ],
          pkColumns: ["id"],
        },
        {
          name: "orders",
          columns: [{ name: "id", type: "integer" }],
          pkColumns: [],
        },
      ]);
    });
  });

  describe("fetchDashboardStats", () => {
    it("returns placeholder stats with no sql service", async () => {
      const c = new PostgresClient({ connectionString: CS });
      const stats = await c.fetchDashboardStats("pg-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Size", value: "" },
        { label: "Tables", value: "0" },
      ]);
    });

    it("queries version/size/tables", async () => {
      sql.query
        .mockResolvedValueOnce([{ version: "PostgreSQL 16.2 on x86_64" }])
        .mockResolvedValueOnce([{ size: "42 MB" }])
        .mockResolvedValueOnce([{ n: 7 }]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const stats = await c.fetchDashboardStats("pg-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "PostgreSQL 16.2" },
        { label: "Size", value: "42 MB" },
        { label: "Tables", value: "7" },
      ]);
    });

    it("handles empty result rows", async () => {
      sql.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const c = new PostgresClient({ connectionString: CS }, services(sql));
      const stats = await c.fetchDashboardStats("pg-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Size", value: "" },
        { label: "Tables", value: "0" },
      ]);
    });
  });
});
