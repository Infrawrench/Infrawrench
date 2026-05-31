import { beforeEach, describe, expect, it, vi } from "vitest";

// DB is mocked: the real client throws without DATABASE_URL, and we want to
// drive the allowlist/token-lookup queries deterministically.
const whereResult: { rows: unknown[] } = { rows: [] };
const limitResult: { rows: unknown[] } = { rows: [] };
const dbSelect = vi.fn(() => ({
  from: () => ({
    where: () => {
      const p = Promise.resolve(whereResult.rows) as Promise<unknown[]> & {
        limit: () => Promise<unknown[]>;
      };
      p.limit = () => Promise.resolve(limitResult.rows);
      return p;
    },
  }),
}));
vi.mock("../db/client.js", () => ({ db: { select: dbSelect } }));
vi.mock("../db/schema.js", () => ({
  accounts: { pluginId: "pluginId", bastionId: "bastionId" },
  bastionVms: {
    id: "id",
    organizationId: "organizationId",
    hashedToken: "hashedToken",
    revokedAt: "revokedAt",
  },
}));
// Avoid importing the real dispatcher (pulls in undici/ws).
vi.mock("../bastion/dispatcher.js", () => ({ BastionAgentConnection: class {} }));

let registry: typeof import("../bastion/registry");

function fakeConn(bastionId: string) {
  return {
    bastionId,
    dispatcher: { id: `disp-${bastionId}` },
    setAllowlist: vi.fn(),
    destroy: vi.fn(async () => undefined),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  whereResult.rows = [];
  limitResult.rows = [];
  registry = await import("../bastion/registry");
  await registry.destroyAllAgentConnections();
});

describe("allowlistForPlugins", () => {
  it("maps known plugin ids to their host suffixes (deduped)", () => {
    const out = registry.allowlistForPlugins(["aws", "aws", "gcp"]);
    expect(out).toContain("*.amazonaws.com");
    expect(out).toContain("*.aws.amazon.com");
    expect(out).toContain("*.googleapis.com");
    // dedupe: aws appears once each
    expect(out.filter((h) => h === "*.amazonaws.com")).toHaveLength(1);
  });

  it("ignores unknown plugin ids", () => {
    expect(registry.allowlistForPlugins(["nope"])).toEqual([]);
  });

  it("kubernetes contributes nothing (not bastion-routed in v1)", () => {
    expect(registry.allowlistForPlugins(["kubernetes"])).toEqual([]);
  });
});

describe("register / unregister / lookup", () => {
  it("registers a connection and resolves its dispatcher", async () => {
    const conn = fakeConn("b1");
    await registry.registerAgentConnection(conn as never);
    expect(registry.isBastionConnected("b1")).toBe(true);
    expect(registry.getDispatcherFor("b1")).toBe(conn.dispatcher);
    // registration refreshes the allowlist from the DB
    expect(conn.setAllowlist).toHaveBeenCalled();
  });

  it("returns null dispatcher / false for unknown bastions", () => {
    expect(registry.getDispatcherFor("nope")).toBeNull();
    expect(registry.isBastionConnected("nope")).toBe(false);
  });

  it("replacing a connection destroys the prior one", async () => {
    const a = fakeConn("b2");
    const b = fakeConn("b2");
    await registry.registerAgentConnection(a as never);
    await registry.registerAgentConnection(b as never);
    expect(a.destroy).toHaveBeenCalled();
    expect(registry.getDispatcherFor("b2")).toBe(b.dispatcher);
  });

  it("unregister destroys and removes the connection", async () => {
    const conn = fakeConn("b3");
    await registry.registerAgentConnection(conn as never);
    await registry.unregisterAgentConnection("b3");
    expect(conn.destroy).toHaveBeenCalled();
    expect(registry.isBastionConnected("b3")).toBe(false);
  });

  it("unregister is a no-op for unknown bastions", async () => {
    await expect(registry.unregisterAgentConnection("ghost")).resolves.toBeUndefined();
  });
});

describe("refreshAllowlistFromDb / refreshAllowlistById", () => {
  it("computes the allowlist from the accounts table", async () => {
    whereResult.rows = [{ pluginId: "aws" }, { pluginId: "gcp" }];
    const conn = fakeConn("b4");
    await registry.refreshAllowlistFromDb(conn as never);
    const arg = conn.setAllowlist.mock.calls.at(-1)![0] as string[];
    expect(arg).toContain("*.amazonaws.com");
    expect(arg).toContain("*.googleapis.com");
  });

  it("refreshAllowlistById refreshes a connected bastion", async () => {
    const conn = fakeConn("b5");
    await registry.registerAgentConnection(conn as never);
    conn.setAllowlist.mockClear();
    whereResult.rows = [{ pluginId: "vercel" }];
    await registry.refreshAllowlistById("b5");
    expect(conn.setAllowlist).toHaveBeenCalledWith(["api.vercel.com"]);
  });

  it("refreshAllowlistById is a no-op for unknown bastions", async () => {
    await expect(registry.refreshAllowlistById("ghost")).resolves.toBeUndefined();
  });
});

describe("findBastionByHashedToken", () => {
  it("returns id + org for a live token", async () => {
    limitResult.rows = [{ id: "bx", organizationId: "org1", revokedAt: null }];
    expect(await registry.findBastionByHashedToken("hash")).toEqual({
      id: "bx",
      organizationId: "org1",
    });
  });

  it("returns null for an unknown token", async () => {
    limitResult.rows = [];
    expect(await registry.findBastionByHashedToken("hash")).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    limitResult.rows = [{ id: "bx", organizationId: "org1", revokedAt: new Date() }];
    expect(await registry.findBastionByHashedToken("hash")).toBeNull();
  });
});

describe("destroyAllAgentConnections", () => {
  it("tears down every connection", async () => {
    const a = fakeConn("c1");
    const b = fakeConn("c2");
    await registry.registerAgentConnection(a as never);
    await registry.registerAgentConnection(b as never);
    await registry.destroyAllAgentConnections();
    expect(a.destroy).toHaveBeenCalled();
    expect(b.destroy).toHaveBeenCalled();
    expect(registry.isBastionConnected("c1")).toBe(false);
  });
});
