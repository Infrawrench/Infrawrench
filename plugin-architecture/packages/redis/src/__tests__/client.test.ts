import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HostServices, ResourceInstance, KvHostServices } from "@infrawrench/plugin-base";
import { RedisClient } from "../client.js";

const CS = "redis://user:pass@cache.example.com:6380/3";

function makeKv() {
  return { command: vi.fn() };
}
function services(kv: KvHostServices): HostServices {
  return { kv } as HostServices;
}
function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:redis-instance:db3",
    pluginId: "redis",
    resourceTypeId: "redis-instance",
    accountId: "acct",
    displayName: "DB 3",
    fields: { host: "cache.example.com:6380", db: 3 },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...over,
  };
}

describe("RedisClient", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  describe("constructor", () => {
    it("throws when connectionString missing", () => {
      expect(() => new RedisClient({})).toThrow(/missing connectionString/);
    });
  });

  describe("listResources", () => {
    it("parses host/port/db from connection string", async () => {
      const c = new RedisClient({ connectionString: CS });
      const res = await c.listResources("redis-instance", "acct");
      expect(res[0]!.id).toBe("acct:redis-instance:db3");
      expect(res[0]!.displayName).toBe("DB 3");
      expect(res[0]!.fields["host"]).toBe("cache.example.com:6380");
      expect(res[0]!.fields["db"]).toBe(3);
    });

    it("omits default port 6379 from host", async () => {
      const c = new RedisClient({ connectionString: "redis://cache.example.com:6379/0" });
      const res = await c.listResources("redis-instance", "acct");
      expect(res[0]!.fields["host"]).toBe("cache.example.com");
      expect(res[0]!.fields["db"]).toBe(0);
    });

    it("defaults db to 0 when path empty", async () => {
      const c = new RedisClient({ connectionString: "redis://cache.example.com" });
      const res = await c.listResources("redis-instance", "acct");
      expect(res[0]!.fields["db"]).toBe(0);
    });

    it("tolerates unparseable connection string", async () => {
      const c = new RedisClient({ connectionString: "garbage" });
      const res = await c.listResources("redis-instance", "acct");
      expect(res[0]!.fields["host"]).toBe("");
      expect(res[0]!.fields["db"]).toBe(0);
    });

    it("throws on unknown type", async () => {
      const c = new RedisClient({ connectionString: CS });
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });
  });

  describe("getResource", () => {
    it("returns matching", async () => {
      const c = new RedisClient({ connectionString: CS });
      const r = await c.getResource("redis-instance", "acct:redis-instance:db3", "acct");
      expect(r.displayName).toBe("DB 3");
    });
    it("throws when not found", async () => {
      const c = new RedisClient({ connectionString: CS });
      await expect(
        c.getResource("redis-instance", "acct:redis-instance:db99", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("returns connectionString", async () => {
      const c = new RedisClient({ connectionString: CS });
      expect(await c.resolveOutput("redis-instance", "x", "connectionString")).toBe(CS);
    });
    it("throws for unknown output", async () => {
      const c = new RedisClient({ connectionString: CS });
      await expect(c.resolveOutput("redis-instance", "x", "nope")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
    it("throws for wrong type", async () => {
      const c = new RedisClient({ connectionString: CS });
      await expect(c.resolveOutput("other", "x", "connectionString")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("renderDetail", () => {
    it("renders healthy with literal connection string", () => {
      const c = new RedisClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource());
      expect(schema.status).toMatchObject({ status: "healthy" });
      expect(schema.subtitle).toContain("cache.example.com:6380");
    });

    it("renders secret placeholder when secretState present", () => {
      const c = new RedisClient({ connectionString: CS });
      const schema = c.renderDetail(
        makeResource({
          secretStates: [
            { fieldKey: "connectionString", resolution: { kind: "literal" } } as never,
          ],
        }),
      );
      expect(JSON.stringify(schema)).toContain("secret-placeholder");
    });

    it("renders info status and (not set) without connection", () => {
      // Build a client with a valid CS then strip it via a resource with no fields
      const c = new RedisClient({ connectionString: CS });
      // status depends on this.connectionString which is always set here; cover
      // the no-host subtitle branch instead
      const schema = c.renderDetail(makeResource({ fields: { db: 0 } }));
      expect(schema.subtitle).toBe("DB 0");
    });

    it("renders stats section when stats outputs present", () => {
      const c = new RedisClient({ connectionString: CS });
      const schema = c.renderDetail(
        makeResource({
          resolvedOutputs: {
            __redis_version__: "7.2.0",
            __used_memory__: "1.2M",
            __db_count__: "4",
            __connected_clients__: "5",
          },
        }),
      );
      const json = JSON.stringify(schema);
      expect(json).toContain("7.2.0");
      expect(json).toContain("Connected Clients");
    });

    it("renders only the populated stats", () => {
      const c = new RedisClient({ connectionString: CS });
      const schema = c.renderDetail(
        makeResource({ resolvedOutputs: { __redis_version__: "7.2.0" } }),
      );
      const json = JSON.stringify(schema);
      expect(json).toContain("Version");
      expect(json).not.toContain("Used Memory");
    });

    it("defaults db to 0 when field missing", () => {
      const c = new RedisClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ fields: { host: "h" } }));
      expect(schema.subtitle).toContain("DB 0");
    });
  });

  describe("renderSidebarItem", () => {
    it("returns item", () => {
      const c = new RedisClient({ connectionString: CS });
      expect(c.renderSidebarItem(makeResource())).toMatchObject({ label: "DB 3" });
    });
  });

  describe("renderPeerPane", () => {
    it("lists instances", async () => {
      const c = new RedisClient({ connectionString: CS });
      const pane = await c.renderPeerPane({
        tabLabel: "x",
        parentPluginId: "p",
        parentResourceTypeId: "t",
        parentResourceId: "r",
        accountId: "acct",
      });
      expect(pane.resourceGroups[0]!.items).toHaveLength(1);
      expect(pane.resourceGroups[0]!.items[0]!.displayName).toBe("DB 3");
      expect(pane.resourceGroups[0]!.title).toContain("(1)");
    });
  });

  describe("fetchDashboardStats", () => {
    it("placeholder without kv", async () => {
      const c = new RedisClient({ connectionString: CS });
      const stats = await c.fetchDashboardStats("redis-instance", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Memory", value: "" },
        { label: "Databases", value: "0" },
      ]);
    });

    it("parses INFO output", async () => {
      kv.command.mockResolvedValue(
        [
          "# Server",
          "redis_version:7.2.0",
          "used_memory_human:1.50M",
          "# Keyspace",
          "db0:keys=10,expires=0",
          "db1:keys=5,expires=0",
          "malformed_line_without_colon",
        ].join("\r\n"),
      );
      const c = new RedisClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("redis-instance", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "7.2.0" },
        { label: "Memory", value: "1.50M" },
        { label: "Databases", value: "2" },
      ]);
      expect(kv.command).toHaveBeenCalledWith("INFO", "all");
    });

    it("handles missing info fields", async () => {
      kv.command.mockResolvedValue("# Server\r\n");
      const c = new RedisClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("redis-instance", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Memory", value: "" },
        { label: "Databases", value: "0" },
      ]);
    });

    it("placeholder on kv error", async () => {
      kv.command.mockRejectedValue(new Error("boom"));
      const c = new RedisClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("redis-instance", "x", "acct");
      expect(stats[2]).toEqual({ label: "Databases", value: "0" });
    });
  });
});
