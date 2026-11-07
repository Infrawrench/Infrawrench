import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type {
  HostServices,
  ResourceInstance,
  SqlHostServices,
  UnreadListPart,
} from "@infrawrench/plugin-base";
import { MySQLClient } from "../client.js";

const CS = "mysql://user:pass@db.example.com:3306/appdb";

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

function trackUnread(): UnreadListPart[] {
  const seen: UnreadListPart[] = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: UnreadListPart) => seen.push(part));
  return seen;
}

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
      expect(() => hostClient(new MySQLClient({}))).toThrow(/missing connectionString/);
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
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const res = await c.listResources("mysql-database", "acct");
      expect(res.map((r) => r.displayName)).toEqual(["appdb", "shop"]);
      expect(res[0]!.fields["host"]).toBe("db.example.com");
    });

    it("catalog branch host unknown on bad CS", async () => {
      sql.query.mockResolvedValue([{ Database: "appdb" }]);
      const c = hostClient(new MySQLClient({ connectionString: "garbage" }, services(sql)));
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("falls back without sql service", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.fields["database"]).toBe("appdb");
    });

    it("uses defaults when CS unparseable", async () => {
      const c = hostClient(new MySQLClient({ connectionString: "garbage" }));
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.displayName).toBe("mysql");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("defaults db name when path empty", async () => {
      const c = hostClient(new MySQLClient({ connectionString: "mysql://host:3306/" }));
      const res = await c.listResources("mysql-database", "acct");
      expect(res[0]!.displayName).toBe("mysql");
    });

    it("throws on unknown type", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });

    describe("a failed read of the database list", () => {
      afterEach(() => {
        Reflect.deleteProperty(globalThis, UNREAD_HOOK);
      });

      const client = () => hostClient(new MySQLClient({ connectionString: CS }, services(sql)));

      it.each([
        [
          "a dropped connection",
          Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        ],
        [
          "a wrong password",
          Object.assign(new Error("Access denied for user 'u'@'h' (using password: YES)"), {
            code: "ER_ACCESS_DENIED_ERROR",
            errno: 1045,
          }),
        ],
        [
          "a login that may not use its own database",
          Object.assign(new Error("Access denied for user 'u'@'h' to database 'appdb'"), {
            code: "ER_DBACCESS_DENIED_ERROR",
            errno: 1044,
          }),
        ],
        ["any other failure", new Error("boom")],
      ])("throws on %s, so no stored row is pruned", async (_name, error) => {
        const unread = trackUnread();
        sql.query.mockRejectedValue(error);
        await expect(client().listResources("mysql-database", "acct")).rejects.toBe(error);
        expect(unread).toEqual([]);
      });

      it("throws when the answer is not a list", async () => {
        sql.query.mockResolvedValue(null);
        await expect(client().listResources("mysql-database", "acct")).rejects.toThrow();
      });

      it.each([
        [
          "the driver's error, whatever language the server speaks",
          Object.assign(new Error("Zugriff verweigert"), {
            code: "ER_SPECIFIC_ACCESS_DENIED_ERROR",
            errno: 1227,
          }),
        ],
        [
          "the message alone, which is all the desktop's IPC keeps",
          new Error(
            "Error invoking remote method 'plugin_sql_query': Error: Access denied; you need (at least one of) the SHOW DATABASES privilege(s) for this operation",
          ),
        ],
      ])("keeps the stored rows when refused, read from %s", async (_name, error) => {
        const unread = trackUnread();
        sql.query.mockRejectedValue(error);
        const res = await client().listResources("mysql-database", "acct");
        expect(res.map((r) => r.displayName)).toEqual(["appdb"]);
        expect(res[0]!.fields["host"]).toBe("db.example.com");
        expect(unread).toEqual([{ idPrefixes: [""] }]);
      });

      it("shows the refusal where the host keeps no track, and still finds the connected database", async () => {
        const error = Object.assign(new Error("Access denied"), {
          code: "ER_SPECIFIC_ACCESS_DENIED_ERROR",
          errno: 1227,
        });
        sql.query.mockRejectedValue(error);
        await expect(client().listResources("mysql-database", "acct")).rejects.toBe(error);
        const found = await client().getResource(
          "mysql-database",
          "acct:mysql-database:appdb",
          "acct",
        );
        expect(found.displayName).toBe("appdb");
      });
    });
  });

  describe("getResource", () => {
    it("returns matching", async () => {
      sql.query.mockResolvedValue([{ Database: "appdb" }]);
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const r = await c.getResource("mysql-database", "acct:mysql-database:appdb", "acct");
      expect(r.displayName).toBe("appdb");
    });
    it("throws when not found", async () => {
      sql.query.mockResolvedValue([{ Database: "appdb" }]);
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(
        c.getResource("mysql-database", "acct:mysql-database:x", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("resolves a database-specific connection string", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(
        c.resolveOutput("mysql-database", "acct:mysql-database:shop", "connectionString"),
      ).resolves.toBe("mysql://user:pass@db.example.com:3306/shop");
    });

    it("falls back to raw connection string when URI cannot be parsed", async () => {
      const c = hostClient(new MySQLClient({ connectionString: "garbage" }));
      await expect(
        c.resolveOutput("mysql-database", "acct:mysql-database:shop", "connectionString"),
      ).resolves.toBe("garbage");
    });

    it("resolves server version through SQL service", async () => {
      sql.query.mockResolvedValue([{ version: "8.4.0" }]);
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(
        c.resolveOutput("mysql-database", "acct:mysql-database:shop", "serverVersion"),
      ).resolves.toBe("8.4.0");
      expect(sql.query).toHaveBeenCalledWith("SELECT VERSION() AS version");
    });

    it("returns empty server version without SQL service", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(
        c.resolveOutput("mysql-database", "acct:mysql-database:shop", "serverVersion"),
      ).resolves.toBe("");
    });

    it("throws on unknown output", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(c.resolveOutput("mysql-database", "x", "x")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("getCreateConfig", () => {
    it("returns database create fields", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const cfg = await c.getCreateConfig("mysql-database");
      expect(cfg.fields.map((f) => f.key)).toEqual(["name", "characterSet", "collation"]);
      expect(cfg.fields[1]!.defaultValue).toBe("utf8mb4");
    });

    it("throws for unsupported type", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(c.getCreateConfig("x")).rejects.toThrow(/no create config/);
    });
  });

  describe("createResource", () => {
    it("creates a database with charset and collation", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const res = await c.createResource("mysql-database", "acct", {
        name: "shop",
        characterSet: "utf8mb4",
        collation: "utf8mb4_0900_ai_ci",
      });
      expect(sql.execute).toHaveBeenCalledWith(
        "CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
        [],
      );
      expect(res).toMatchObject({
        id: "acct:mysql-database:shop",
        displayName: "shop",
        externalId: "shop",
        fields: { host: "db.example.com", database: "shop" },
      });
    });

    it("creates a database with server defaults when charset omitted", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await c.createResource("mysql-database", "acct", { name: "shop" });
      expect(sql.execute).toHaveBeenCalledWith("CREATE DATABASE `shop`", []);
    });

    it("throws when SQL service missing", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(c.createResource("mysql-database", "acct", { name: "shop" })).rejects.toThrow(
        /SQL service not available/,
      );
    });

    it("rejects invalid database and option names", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(
        c.createResource("mysql-database", "acct", { name: "bad`name" }),
      ).rejects.toThrow(/Invalid database name/);
      await expect(
        c.createResource("mysql-database", "acct", {
          name: "shop",
          characterSet: "utf8mb4;DROP",
        }),
      ).rejects.toThrow(/Invalid MySQL identifier/);
    });

    it("rejects system database names and unsupported types", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(c.createResource("mysql-database", "acct", { name: "mysql" })).rejects.toThrow(
        /system database/,
      );
      await expect(c.createResource("x", "acct", { name: "shop" })).rejects.toThrow(
        /not supported/,
      );
    });
  });

  describe("deleteResource", () => {
    it("drops a database", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await c.deleteResource("mysql-database", "acct:mysql-database:shop", "acct");
      expect(sql.execute).toHaveBeenCalledWith("DROP DATABASE `shop`", []);
    });
    it("throws on unsupported type", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(c.deleteResource("x", "a:x:y", "acct")).rejects.toThrow(/not supported/);
    });
    it("throws when sql service missing", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      await expect(
        c.deleteResource("mysql-database", "a:mysql-database:x", "acct"),
      ).rejects.toThrow(/SQL service not available/);
    });
    it("throws when name unparseable", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(c.deleteResource("mysql-database", "", "acct")).rejects.toThrow(
        /Cannot parse database name/,
      );
    });
    it("refuses system database", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(
        c.deleteResource("mysql-database", "a:mysql-database:mysql", "acct"),
      ).rejects.toThrow(/system database/);
    });
    it("rejects backtick in name", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      await expect(
        c.deleteResource("mysql-database", "a:mysql-database:bad`name", "acct"),
      ).rejects.toThrow(/Invalid database name/);
    });
  });

  describe("renderDetail", () => {
    it("renders connection section and sqlEditor", () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const schema = c.renderDetail(makeResource());
      expect(schema.title).toBe("appdb");
      expect(schema.sqlEditor?.connectionStringOutputKey).toBe("connectionString");
    });
    it("parses __tables__", () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const tables = [{ name: "t", columns: [{ name: "id", type: "int" }] }];
      const schema = c.renderDetail(
        makeResource({ resolvedOutputs: { __tables__: JSON.stringify(tables) } }),
      );
      expect(schema.sqlEditor?.tables).toEqual(tables);
    });
    it("ignores invalid __tables__", () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const schema = c.renderDetail(makeResource({ resolvedOutputs: { __tables__: "{bad" } }));
      expect(schema.sqlEditor?.tables).toEqual([]);
    });
    it("uses fallback labels", () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const schema = c.renderDetail(makeResource({ fields: {} }));
      expect(schema.subtitle).toContain("MySQL");
    });
  });

  describe("renderSidebarItem", () => {
    it("returns item", () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
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
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items.map((i) => i.displayName)).toEqual(["appdb", "shop"]);
    });
    it("empty without sql service", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items).toEqual([]);
    });
    it("tolerates unparseable CS", async () => {
      sql.query.mockResolvedValue([]);
      const c = hostClient(new MySQLClient({ connectionString: "garbage" }, services(sql)));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups).toHaveLength(1);
    });
  });

  describe("introspect", () => {
    it("returns empty without sql service", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
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
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const meta = await c.introspect();
      expect(meta).toEqual([
        { name: "users", columns: [{ name: "id", type: "int" }], pkColumns: ["id"] },
        { name: "orders", columns: [{ name: "id", type: "int" }], pkColumns: [] },
      ]);
    });
  });

  describe("fetchDashboardStats", () => {
    it("placeholder without sql service", async () => {
      const c = hostClient(new MySQLClient({ connectionString: CS }));
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
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const stats = await c.fetchDashboardStats("mysql-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "8.0.36" },
        { label: "Size", value: "12.3 MB" },
        { label: "Tables", value: "4" },
      ]);
    });
    it("handles empty rows", async () => {
      sql.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const c = hostClient(new MySQLClient({ connectionString: CS }, services(sql)));
      const stats = await c.fetchDashboardStats("mysql-database", "x", "acct");
      expect(stats[2]).toEqual({ label: "Tables", value: "0" });
    });
  });
});
