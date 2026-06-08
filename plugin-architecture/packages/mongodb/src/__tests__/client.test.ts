import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HostServices, ResourceInstance, KvHostServices } from "@infrawrench/plugin-base";
import { MongoDBClient } from "../client.js";

const CS = "mongodb://user:pass@db.example.com:27017/appdb";

function makeKv() {
  return { command: vi.fn() };
}
function services(kv: KvHostServices): HostServices {
  return { kv } as HostServices;
}
function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:mongodb-database:appdb",
    pluginId: "mongodb",
    resourceTypeId: "mongodb-database",
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

describe("MongoDBClient", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  describe("constructor", () => {
    it("throws when connectionString missing", () => {
      expect(() => new MongoDBClient({})).toThrow(/missing connectionString/);
    });
  });

  describe("listResources", () => {
    it("lists databases via kv and filters system dbs", async () => {
      kv.command.mockResolvedValue({
        databases: [
          { name: "appdb", sizeOnDisk: 1 },
          { name: "admin", sizeOnDisk: 1 },
          { name: "shop", sizeOnDisk: 1 },
        ],
      });
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const res = await c.listResources("mongodb-database", "acct");
      expect(res.map((r) => r.displayName)).toEqual(["appdb", "shop"]);
      expect(res[0]!.fields["host"]).toBe("db.example.com");
      expect(kv.command).toHaveBeenCalledWith("listDatabases", "admin");
    });

    it("falls back to URL parsing on kv error", async () => {
      kv.command.mockRejectedValue(new Error("boom"));
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const res = await c.listResources("mongodb-database", "acct");
      expect(res[0]!.displayName).toBe("appdb");
    });

    it("falls back without kv service", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      const res = await c.listResources("mongodb-database", "acct");
      expect(res[0]!.fields["database"]).toBe("appdb");
    });

    it("defaults host/db on unparseable CS", async () => {
      const c = new MongoDBClient({ connectionString: "garbage" });
      const res = await c.listResources("mongodb-database", "acct");
      expect(res[0]!.displayName).toBe("test");
      expect(res[0]!.fields["host"]).toBe("unknown");
    });

    it("defaults db to test when path empty", async () => {
      const c = new MongoDBClient({ connectionString: "mongodb://host:27017/" });
      const res = await c.listResources("mongodb-database", "acct");
      expect(res[0]!.displayName).toBe("test");
    });

    it("throws on unknown type", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });
  });

  describe("getResource", () => {
    it("returns matching", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      const r = await c.getResource("mongodb-database", "acct:mongodb-database:appdb", "acct");
      expect(r.displayName).toBe("appdb");
    });
    it("throws when not found", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(
        c.getResource("mongodb-database", "acct:mongodb-database:zzz", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("returns connectionString", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      expect(await c.resolveOutput("mongodb-database", "x", "connectionString")).toBe(CS);
    });
    it("returns serverVersion via kv for selected database", async () => {
      kv.command.mockResolvedValue("7.0.11");
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await expect(
        c.resolveOutput("mongodb-database", "acct:mongodb-database:shop", "serverVersion"),
      ).resolves.toBe("7.0.11");
      expect(kv.command).toHaveBeenCalledWith("serverVersion", "shop");
    });
    it("throws for serverVersion when kv missing", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(
        c.resolveOutput("mongodb-database", "acct:mongodb-database:shop", "serverVersion"),
      ).rejects.toThrow(/KV service not available/);
    });
    it("throws for unknown output", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(c.resolveOutput("mongodb-database", "x", "nope")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
    it("throws for wrong type", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(c.resolveOutput("other", "x", "connectionString")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("deleteResource", () => {
    it("drops a database", async () => {
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await c.deleteResource("mongodb-database", "acct:mongodb-database:shop", "acct");
      expect(kv.command).toHaveBeenCalledWith("dropDatabase", "shop");
    });
    it("throws on unsupported type", async () => {
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await expect(c.deleteResource("x", "a:x:y", "acct")).rejects.toThrow(/not supported/);
    });
    it("throws when kv missing", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(
        c.deleteResource("mongodb-database", "a:mongodb-database:x", "acct"),
      ).rejects.toThrow(/KV service not available/);
    });
    it("throws when name unparseable", async () => {
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await expect(c.deleteResource("mongodb-database", "", "acct")).rejects.toThrow(
        /Cannot parse database name/,
      );
    });
  });

  describe("getCreateConfig / createResource", () => {
    it("returns create config fields", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      const cfg = await c.getCreateConfig("mongodb-database");
      expect(cfg.fields.map((f) => f.key)).toEqual(["database", "collection"]);
    });

    it("creates a database via createCollection", async () => {
      kv.command.mockResolvedValue({ ok: true });
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const r = await c.createResource("mongodb-database", "acct", {
        database: "newdb",
        collection: "items",
      });
      expect(kv.command).toHaveBeenCalledWith("createCollection", "newdb", "items");
      expect(r.displayName).toBe("newdb");
      expect(r.fields["host"]).toBe("db.example.com");
      expect(r.resolvedOutputs["connectionString"]).toBe(CS);
    });

    it("defaults collection to documents", async () => {
      kv.command.mockResolvedValue({ ok: true });
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await c.createResource("mongodb-database", "acct", { database: "newdb", collection: "" });
      expect(kv.command).toHaveBeenCalledWith("createCollection", "newdb", "documents");
    });

    it("tolerates unparseable CS for host", async () => {
      kv.command.mockResolvedValue({ ok: true });
      const c = new MongoDBClient({ connectionString: "garbage" }, services(kv));
      const r = await c.createResource("mongodb-database", "acct", {
        database: "d",
        collection: "c",
      });
      expect(r.fields["host"]).toBe("");
    });

    it("throws on unsupported type", async () => {
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await expect(c.createResource("x", "acct", {})).rejects.toThrow(/not supported/);
    });
    it("throws when kv missing", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      await expect(c.createResource("mongodb-database", "acct", { database: "d" })).rejects.toThrow(
        /KV service not available/,
      );
    });
    it("throws when database name missing", async () => {
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await expect(
        c.createResource("mongodb-database", "acct", { database: "  " }),
      ).rejects.toThrow(/Database name is required/);
    });
  });

  describe("renderDetail / renderSidebarItem", () => {
    it("renders detail", () => {
      const c = new MongoDBClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource());
      expect(schema.title).toBe("appdb");
      expect(schema.status).toMatchObject({ status: "healthy" });
    });
    it("uses fallback labels", () => {
      const c = new MongoDBClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ fields: {} }));
      expect(schema.subtitle).toContain("MongoDB");
    });
    it("renders sidebar item", () => {
      const c = new MongoDBClient({ connectionString: CS });
      expect(c.renderSidebarItem(makeResource())).toMatchObject({ label: "appdb" });
    });
  });

  describe("renderPeerPane", () => {
    it("lists databases excluding system", async () => {
      kv.command.mockResolvedValue({
        databases: [{ name: "appdb" }, { name: "admin" }, { name: "shop" }],
      });
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items.map((i) => i.displayName)).toEqual(["appdb", "shop"]);
      expect(pane.resourceGroups[0]!.supportsCreate).toBe(true);
    });
    it("handles missing databases array", async () => {
      kv.command.mockResolvedValue({});
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items).toEqual([]);
    });
    it("empty without kv", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups[0]!.items).toEqual([]);
    });
    it("tolerates unparseable CS", async () => {
      kv.command.mockResolvedValue({ databases: [] });
      const c = new MongoDBClient({ connectionString: "garbage" }, services(kv));
      const pane = await c.renderPeerPane(ctx);
      expect(pane.resourceGroups).toHaveLength(1);
    });
  });

  describe("fetchDashboardStats", () => {
    it("placeholder without kv", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      const stats = await c.fetchDashboardStats("mongodb-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Size", value: "" },
        { label: "Collections", value: "0" },
      ]);
    });
    it("computes stats from dbStats and serverVersion", async () => {
      kv.command
        .mockResolvedValueOnce({ collections: 5, storageSize: 2 * 1024 * 1024 })
        .mockResolvedValueOnce("7.0.1");
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("mongodb-database", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "7.0.1" },
        { label: "Size", value: "2.0 MB" },
        { label: "Collections", value: "5" },
      ]);
    });
    it("falls back to dataSize when no storageSize", async () => {
      kv.command
        .mockResolvedValueOnce({ collections: 0, dataSize: 1024 * 1024 })
        .mockResolvedValueOnce("");
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("mongodb-database", "x", "acct");
      expect(stats[1]).toEqual({ label: "Size", value: "1.0 MB" });
    });
    it("placeholder on kv error", async () => {
      kv.command.mockRejectedValue(new Error("boom"));
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("mongodb-database", "x", "acct");
      expect(stats[2]).toEqual({ label: "Collections", value: "0" });
    });
  });

  describe("fetchMetricSeries", () => {
    it("returns empty without kv", async () => {
      const c = new MongoDBClient({ connectionString: CS });
      expect(await c.fetchMetricSeries("mongodb-database", "x", "acct")).toEqual([]);
    });
    it("maps dbStats into metric series", async () => {
      kv.command.mockResolvedValue({
        collections: 3,
        objects: 100,
        indexes: 4,
        dataSize: 1024 * 1024,
        storageSize: 2 * 1024 * 1024,
        indexSize: 512 * 1024,
      });
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      const series = await c.fetchMetricSeries(
        "mongodb-database",
        "acct:mongodb-database:appdb",
        "acct",
      );
      expect(kv.command).toHaveBeenCalledWith("dbStats", "appdb");
      const byLabel = Object.fromEntries(series.map((s) => [s.label, s.points[0]!.value]));
      expect(byLabel["Storage size"]).toBe(2);
      expect(byLabel["Data size"]).toBe(1);
      expect(byLabel["Collections"]).toBe(3);
      expect(byLabel["Objects"]).toBe(100);
      expect(byLabel["Indexes"]).toBe(4);
    });
    it("uses the trailing segment of the resourceId for dbStats", async () => {
      kv.command.mockResolvedValue({});
      const c = new MongoDBClient({ connectionString: CS }, services(kv));
      await c.fetchMetricSeries("mongodb-database", "acct:mongodb-database:other", "acct");
      expect(kv.command).toHaveBeenCalledWith("dbStats", "other");
    });
  });
});
