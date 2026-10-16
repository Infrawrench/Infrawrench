/**
 * Default dashboard resolution and the role-default write checks. The
 * precedence itself is unit-tested in client-core (`dashboard-defaults`);
 * this covers what the service adds: the reads, the legacy-role fallback,
 * skipping a default the caller can no longer open, and validating a role
 * default against the role rather than the admin setting it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Each `db.select()` resolves to the next queued result, whatever the chain. */
const results: unknown[][] = [];
const inserted: unknown[] = [];
const updates: unknown[] = [];

function chain(): unknown {
  const value = () => results.shift() ?? [];
  const self: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy", "innerJoin"]) self[m] = () => self;
  self["then"] = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(value()).then(resolve, reject);
  return self;
}

vi.mock("@/db/client", () => ({
  db: {
    select: () => chain(),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { returning: async () => [{ ...(v as object) }] };
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        updates.push(v);
        return { where: async () => undefined };
      },
    }),
  },
}));

/** Ids the current principal can open; `null` = everything. */
let visibleIds: Set<string> | null = null;
const principals: unknown[] = [];
vi.mock("@/services/object-sharing", () => ({
  filterVisibleObjects: async (_o: string, _t: string, items: Array<{ id: string }>) =>
    visibleIds ? items.filter((i) => visibleIds!.has(i.id)) : items,
  runWithSharingPrincipal: (p: unknown, fn: () => unknown) => {
    principals.push(p);
    return fn();
  },
}));

vi.mock("@infrawrench/server-core/permissions", async (orig) => ({
  ...(await orig<typeof import("@infrawrench/server-core/permissions")>()),
  ensureSystemRoles: async () => undefined,
}));

const svc = await import("@/services/default-dashboards");

const orgHome = { id: "home", name: "Home", isDefault: true, organizationId: "o" };
const role = (over: Record<string, unknown> = {}) => ({
  id: "r-fin",
  organizationId: "o",
  name: "Finance",
  description: null,
  isSystem: false,
  systemKey: null,
  permissions: ["dashboards:read"],
  defaultDashboardId: null as string | null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  results.length = 0;
  inserted.length = 0;
  updates.length = 0;
  principals.length = 0;
  visibleIds = null;
});

describe("resolveDefaultDashboard", () => {
  it("lands on the role default when the member has not picked one", async () => {
    results.push(
      [{ roleId: "r-fin", legacyRole: "member", defaultDashboardId: null }], // membership
      [orgHome], // org default
      [role({ defaultDashboardId: "fin" })], // member's role
      [
        { id: "fin", name: "Finance overview" },
        { id: "home", name: "Home" },
      ], // dashboard names
    );
    const out = await svc.resolveDefaultDashboard("o", "u");
    expect(out).toMatchObject({
      dashboardId: "fin",
      dashboardName: "Finance overview",
      source: "role",
      roleDefault: { roleId: "r-fin", roleName: "Finance", dashboardId: "fin" },
      orgDefaultDashboardId: "home",
      skipped: [],
    });
  });

  it("skips the member's own default once it is unshared from them", async () => {
    visibleIds = new Set(["home"]);
    results.push(
      [{ roleId: "r-fin", legacyRole: "member", defaultDashboardId: "mine" }],
      [orgHome],
      [role()],
      [
        { id: "mine", name: "Mine" },
        { id: "home", name: "Home" },
      ],
    );
    const out = await svc.resolveDefaultDashboard("o", "u");
    expect(out).toMatchObject({ dashboardId: "home", source: "org", skipped: ["user"] });
    expect(out.userDefaultDashboardId).toBe("mine");
  });

  it("reads the system role for a membership not yet backfilled", async () => {
    results.push(
      [{ roleId: null, legacyRole: "admin", defaultDashboardId: null }],
      [orgHome],
      [
        role({
          id: "sys-admin",
          name: "Admin",
          isSystem: true,
          systemKey: "admin",
          defaultDashboardId: "ops",
        }),
      ],
      [
        { id: "ops", name: "Ops" },
        { id: "home", name: "Home" },
      ],
    );
    const out = await svc.resolveDefaultDashboard("o", "u");
    expect(out).toMatchObject({ dashboardId: "ops", source: "role" });
  });

  it("creates the org default on a brand-new org", async () => {
    results.push([], [], []); // no membership, no org default, no names
    const out = await svc.resolveDefaultDashboard("o", "u");
    expect(inserted).toEqual([expect.objectContaining({ name: "Home", isDefault: true })]);
    expect(out.source).toBe("org");
    expect(out.dashboardName).toBe("Home");
  });
});

describe("roleDefaultProblem", () => {
  it("refuses a role that cannot read dashboards", async () => {
    const problem = await svc.roleDefaultProblem("o", role({ permissions: ["costs:read"] }), "d");
    expect(problem).toMatch(/dashboards:read/);
  });

  it("accepts anything for a role holding sharing:override", async () => {
    // System admin resolves its permissions from code, which include the override.
    const admin = role({ isSystem: true, systemKey: "admin", permissions: [] });
    expect(await svc.roleDefaultProblem("o", admin, "d")).toBeNull();
    expect(results).toHaveLength(0);
  });

  it("checks sharing as the role, not as the caller", async () => {
    visibleIds = new Set();
    results.push([{ id: "d" }]);
    const problem = await svc.roleDefaultProblem("o", role(), "d");
    expect(problem).toMatch(/not shared with the Finance role/);
    expect(principals).toEqual([
      { organizationId: "o", userId: "", roleId: "r-fin", override: false },
    ]);
  });

  it("accepts a dashboard shared with the role", async () => {
    visibleIds = new Set(["d"]);
    results.push([{ id: "d" }]);
    expect(await svc.roleDefaultProblem("o", role(), "d")).toBeNull();
  });
});

describe("setRoleDefaultDashboard", () => {
  it("throws a 422 and writes nothing when the role cannot see the dashboard", async () => {
    visibleIds = new Set();
    results.push([role()], [{ id: "d", name: "D" }], [{ id: "d" }]);
    await expect(svc.setRoleDefaultDashboard("o", "r-fin", "d")).rejects.toMatchObject({
      status: 422,
    });
    expect(updates).toHaveLength(0);
  });

  it("404s an unknown role", async () => {
    results.push([]);
    await expect(svc.setRoleDefaultDashboard("o", "nope", "d")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("stores the default when the role can see it", async () => {
    results.push([role()], [{ id: "d", name: "D" }], [{ id: "d" }]);
    const out = await svc.setRoleDefaultDashboard("o", "r-fin", "d");
    expect(out.dashboard).toEqual({ id: "d", name: "D" });
    expect(updates).toEqual([expect.objectContaining({ defaultDashboardId: "d" })]);
  });
});

describe("setMyDefaultDashboard", () => {
  it("404s a dashboard the caller cannot open", async () => {
    visibleIds = new Set();
    results.push([{ id: "d", name: "D" }]);
    await expect(svc.setMyDefaultDashboard("o", "u", "d")).rejects.toMatchObject({ status: 404 });
    expect(updates).toHaveLength(0);
  });

  it("stores a dashboard the caller can open", async () => {
    results.push([{ id: "d", name: "D" }]);
    await svc.setMyDefaultDashboard("o", "u", "d");
    expect(updates).toEqual([{ defaultDashboardId: "d" }]);
  });
});
