import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HostServices, ResourceInstance, KvHostServices } from "@infrawrench/plugin-base";
import { MemcachedClient } from "../client.js";

const CS = "memcached://cache.example.com:11211";

function makeKv() {
  return { command: vi.fn() };
}
function services(kv: KvHostServices): HostServices {
  return { kv } as HostServices;
}
function makeResource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:memcached-instance:default",
    pluginId: "memcached",
    resourceTypeId: "memcached-instance",
    accountId: "acct",
    displayName: "cache.example.com:11211",
    fields: { host: "cache.example.com:11211" },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...over,
  };
}

describe("MemcachedClient", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  describe("constructor", () => {
    it("throws when connectionString missing", () => {
      expect(() => new MemcachedClient({})).toThrow(/missing connectionString/);
    });
  });

  describe("listResources", () => {
    it("strips scheme and uses first server as host", async () => {
      const c = new MemcachedClient({
        connectionString: "memcached://a.example.com:11211,b.example.com:11211",
      });
      const res = await c.listResources("memcached-instance", "acct");
      expect(res[0]!.id).toBe("acct:memcached-instance:default");
      expect(res[0]!.displayName).toBe("a.example.com:11211");
      expect(res[0]!.fields["host"]).toBe("a.example.com:11211");
    });

    it("strips memcacheds:// scheme", async () => {
      const c = new MemcachedClient({ connectionString: "memcacheds://secure.example.com:11211" });
      const res = await c.listResources("memcached-instance", "acct");
      expect(res[0]!.displayName).toBe("secure.example.com:11211");
    });

    it("handles bare host with no scheme", async () => {
      const c = new MemcachedClient({ connectionString: "plainhost:11211" });
      const res = await c.listResources("memcached-instance", "acct");
      expect(res[0]!.fields["host"]).toBe("plainhost:11211");
    });

    it("throws on unknown type", async () => {
      const c = new MemcachedClient({ connectionString: CS });
      await expect(c.listResources("nope", "acct")).rejects.toThrow(/unknown resource type/);
    });
  });

  describe("getResource", () => {
    it("returns matching", async () => {
      const c = new MemcachedClient({ connectionString: CS });
      const r = await c.getResource(
        "memcached-instance",
        "acct:memcached-instance:default",
        "acct",
      );
      expect(r.displayName).toBe("cache.example.com:11211");
    });
    it("throws when not found", async () => {
      const c = new MemcachedClient({ connectionString: CS });
      await expect(
        c.getResource("memcached-instance", "acct:memcached-instance:other", "acct"),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("resolveOutput", () => {
    it("returns connectionString", async () => {
      const c = new MemcachedClient({ connectionString: CS });
      expect(await c.resolveOutput("memcached-instance", "x", "connectionString")).toBe(CS);
    });
    it("throws for unknown output", async () => {
      const c = new MemcachedClient({ connectionString: CS });
      await expect(c.resolveOutput("memcached-instance", "x", "nope")).rejects.toThrow(
        /cannot resolve output/,
      );
    });
  });

  describe("renderDetail / renderSidebarItem", () => {
    it("renders detail with host from fields", () => {
      const c = new MemcachedClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource());
      expect(schema.subtitle).toBe("cache.example.com:11211");
      expect(JSON.stringify(schema)).toContain("Server(s)");
    });
    it("falls back to connectionString when host field missing", () => {
      const c = new MemcachedClient({ connectionString: CS });
      const schema = c.renderDetail(makeResource({ fields: {} }));
      expect(schema.subtitle).toBe(CS);
    });
    it("renders sidebar item", () => {
      const c = new MemcachedClient({ connectionString: CS });
      expect(c.renderSidebarItem(makeResource())).toMatchObject({
        label: "cache.example.com:11211",
      });
    });
  });

  describe("fetchDashboardStats", () => {
    it("placeholder without kv", async () => {
      const c = new MemcachedClient({ connectionString: CS });
      const stats = await c.fetchDashboardStats("memcached-instance", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Memory", value: "" },
        { label: "Items", value: "0" },
      ]);
    });

    it("parses STATS output (MB memory)", async () => {
      kv.command.mockResolvedValue(
        ["# server1:11211", "version: 1.6.21", "bytes: 2097152", "curr_items: 42"].join("\n"),
      );
      const c = new MemcachedClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("memcached-instance", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "1.6.21" },
        { label: "Memory", value: "2.0 MB" },
        { label: "Items", value: "42" },
      ]);
      expect(kv.command).toHaveBeenCalledWith("STATS");
    });

    it("formats kB memory", async () => {
      kv.command.mockResolvedValue(["version: 1.6", "bytes: 2048", "curr_items: 1"].join("\n"));
      const c = new MemcachedClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("memcached-instance", "x", "acct");
      expect(stats[1]).toEqual({ label: "Memory", value: "2.0 kB" });
    });

    it("formats bytes memory", async () => {
      kv.command.mockResolvedValue(["version: 1.6", "bytes: 512", "curr_items: 1"].join("\n"));
      const c = new MemcachedClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("memcached-instance", "x", "acct");
      expect(stats[1]).toEqual({ label: "Memory", value: "512 B" });
    });

    it("handles missing stats fields (zero bytes -> empty memory)", async () => {
      kv.command.mockResolvedValue("# server1:11211");
      const c = new MemcachedClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("memcached-instance", "x", "acct");
      expect(stats).toEqual([
        { label: "Version", value: "" },
        { label: "Memory", value: "" },
        { label: "Items", value: "0" },
      ]);
    });

    it("placeholder on kv error", async () => {
      kv.command.mockRejectedValue(new Error("boom"));
      const c = new MemcachedClient({ connectionString: CS }, services(kv));
      const stats = await c.fetchDashboardStats("memcached-instance", "x", "acct");
      expect(stats[2]).toEqual({ label: "Items", value: "0" });
    });
  });
});
