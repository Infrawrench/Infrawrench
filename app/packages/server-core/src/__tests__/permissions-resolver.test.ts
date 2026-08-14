import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * Real Drizzle over a recording driver against the real schema (see
 * helpers/fake-postgres.ts). Each test queues its precise sequence of DB
 * responses with `pg.queueRows` — one queue entry per query, in execution
 * order, keys in the query's projection order (or the table's column order for
 * bare `select()`).
 */
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** A full `roles` row in column order, driver-shaped. */
function roleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r-x",
    organizationId: "org1",
    name: "Role",
    description: null,
    isSystem: false,
    systemKey: null,
    permissions: [],
    createdAt: "2026-08-01 00:00:00.000",
    updatedAt: "2026-08-01 00:00:00.000",
    ...over,
  };
}

/**
 * The columns `ensureSystemRoles`' INSERT provides values for, in the order
 * the real dialect renders them (table column order; `created_at`/`updated_at`
 * fall back to their defaults and carry no parameter).
 */
const INSERTED_ROLE_COLUMNS = [
  "id",
  "organizationId",
  "name",
  "description",
  "isSystem",
  "systemKey",
  "permissions",
] as const;

/** The rows of the `roles` INSERT, reconstructed from its positional params. */
function insertedRoles(): Array<Record<string, unknown>> | null {
  const q = pg.queries.find((x) => x.sql.startsWith('insert into "roles"'));
  if (!q) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < q.params.length; i += INSERTED_ROLE_COLUMNS.length) {
    const chunk = q.params.slice(i, i + INSERTED_ROLE_COLUMNS.length);
    rows.push(Object.fromEntries(INSERTED_ROLE_COLUMNS.map((k, j) => [k, chunk[j]])));
  }
  return rows;
}

/** The membership UPDATEs issued, as their rendered positional params. */
const membershipUpdates = () =>
  pg.queries.filter((q) => q.sql.startsWith('update "organization_members"'));

/**
 * Break-glass grants are resolved alongside the role, but they have their own
 * suite — here we only care that the resolver unions them in for people and
 * leaves them out for keys and non-members.
 */
const mockActiveElevations = vi.fn(async () => [] as unknown[]);
vi.mock("../access/break-glass", () => ({
  activeElevations: (...a: unknown[]) => mockActiveElevations(...(a as [])),
}));

let resolver: typeof import("../permissions/resolver");
let systemRoles: typeof import("../permissions/system-roles");

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  mockActiveElevations.mockResolvedValue([]);
  resolver = await import("../permissions/resolver");
  systemRoles = await import("../permissions/system-roles");
});

describe("ensureSystemRoles", () => {
  it("inserts the three system roles when none exist", async () => {
    pg.queueRows([]); // existing systemKeys: none
    await resolver.ensureSystemRoles("org1");
    const inserted = insertedRoles();
    expect(inserted).not.toBeNull();
    expect(inserted!.map((r) => r.systemKey).sort()).toEqual(["admin", "member", "owner"]);
    expect(inserted!.every((r) => r.organizationId === "org1")).toBe(true);
    expect(pg.lastQuery().sql).toContain("on conflict do nothing");
  });

  it("only inserts the missing keys", async () => {
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }]);
    await resolver.ensureSystemRoles("org1");
    expect(insertedRoles()!.map((r) => r.systemKey)).toEqual(["member"]);
  });

  it("does not insert when all keys are present", async () => {
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]);
    await resolver.ensureSystemRoles("org1");
    expect(insertedRoles()).toBeNull();
  });
});

describe("getSystemRole", () => {
  it("returns the row enriched with in-code permissions", async () => {
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    pg.queueRows([
      roleRow({
        id: "r-owner",
        name: "Owner",
        description: "desc",
        isSystem: true,
        systemKey: "owner",
      }),
    ]); // the role lookup
    const role = await resolver.getSystemRole("org1", "owner");
    expect(role.id).toBe("r-owner");
    expect(role.isSystem).toBe(true);
    expect(role.systemKey).toBe("owner");
    expect(role.permissions).toEqual(systemRoles.systemRolePermissions("owner"));
  });

  it("throws when the system role row is missing", async () => {
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    pg.queueRows([]); // missing role
    await expect(resolver.getSystemRole("org1", "admin")).rejects.toThrow(/missing/);
  });
});

describe("resolveEffectivePermissions — apiKey", () => {
  it("returns the key scopes verbatim, no role", async () => {
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "apiKey",
      scopes: ["accounts:read", "resources:read"],
    });
    expect(out).toEqual({
      permissions: ["accounts:read", "resources:read"],
      role: null,
      elevations: [],
    });
    expect(pg.queries).toEqual([]);
    // A key must never pick up its owner's break-glass grant: the elevation
    // was handed to a person for a bounded window on a stated reason, and a
    // key they minted last quarter is neither.
    expect(mockActiveElevations).not.toHaveBeenCalled();
  });
});

describe("resolveEffectivePermissions — user", () => {
  it("returns empty when there is no membership", async () => {
    pg.queueRows([]); // membership lookup -> none
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out).toEqual({ permissions: [], role: null, elevations: [] });
  });

  it("resolves a custom (non-system) role's stored permissions", async () => {
    pg.queueRows([{ roleId: "r-custom", legacyRole: null }]); // membership
    pg.queueRows([
      roleRow({ id: "r-custom", name: "Custom", permissions: ["accounts:read", "team:read"] }),
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.permissions).toEqual(["accounts:read", "team:read"]);
    expect(out.role?.isSystem).toBe(false);
    expect(out.role?.systemKey).toBeNull();
  });

  /**
   * Regression guard for the `dashboards:*` → `workflows:*` split. Workflows
   * used to ride on `dashboards:write`, and the grandfathering of grants that
   * predate the split ran once, in migration
   * `0055_grandfather_workflow_permissions` — never here. A role written after
   * that migration therefore means exactly what it says, which is the entire
   * point of giving `workflows:approve` its own entry: "may edit the
   * automation, may not land the decision on someone else's
   * `infra.waitForApproval(...)`" has to be expressible.
   */
  it("does not grant workflows:approve to a role that grants dashboards:write", async () => {
    pg.queueRows([{ roleId: "r-authors", legacyRole: null }]); // membership
    pg.queueRows([
      roleRow({
        id: "r-authors",
        name: "Workflow authors",
        // Deliberately withholds approve while granting everything around it.
        permissions: ["dashboards:read", "dashboards:write", "workflows:read", "workflows:write"],
        updatedAt: "2020-01-01 00:00:00.000", // long "before" any cutover
      }),
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.permissions).toEqual([
      "dashboards:read",
      "dashboards:write",
      "workflows:read",
      "workflows:write",
    ]);
    expect(out.permissions).not.toContain("workflows:approve");
    expect(out.role?.permissions).not.toContain("workflows:approve");
  });

  it("uses in-code permissions for a system role (ignoring stale stored perms)", async () => {
    pg.queueRows([{ roleId: "r-owner", legacyRole: null }]); // membership
    pg.queueRows([
      roleRow({
        id: "r-owner",
        name: "Owner",
        description: "d",
        isSystem: true,
        systemKey: "owner",
        permissions: ["STALE"], // should be ignored
      }),
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.permissions).toEqual(systemRoles.systemRolePermissions("owner"));
    expect(out.permissions).not.toContain("STALE");
    expect(out.role?.systemKey).toBe("owner");
  });

  it("treats a row flagged isSystem with an unknown systemKey as a custom role", async () => {
    pg.queueRows([{ roleId: "r-x", legacyRole: null }]); // membership
    pg.queueRows([
      roleRow({
        id: "r-x",
        name: "Weird",
        isSystem: true,
        systemKey: "bogus",
        permissions: ["audit:read"],
      }),
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    // systemKey is normalized to null and stored perms are used.
    expect(out.role?.systemKey).toBeNull();
    expect(out.permissions).toEqual(["audit:read"]);
  });

  it("defaults null stored permissions to an empty array for a custom role", async () => {
    pg.queueRows([{ roleId: "r-empty", legacyRole: null }]);
    pg.queueRows([roleRow({ id: "r-empty", name: "Empty", permissions: null })]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.permissions).toEqual([]);
  });

  it("falls back to the legacy text role when roleId points at a deleted row", async () => {
    pg.queueRows([{ roleId: "gone", legacyRole: "admin" }]); // membership
    pg.queueRows([]); // roleId lookup -> deleted
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensureSystemRoles inside getSystemRole
    pg.queueRows([
      roleRow({
        id: "r-admin",
        name: "Admin",
        description: "d",
        isSystem: true,
        systemKey: "admin",
      }),
    ]); // system role row
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.role?.systemKey).toBe("admin");
    expect(out.permissions).toEqual(systemRoles.systemRolePermissions("admin"));
  });

  it("falls back to the legacy text role when there is no roleId at all", async () => {
    pg.queueRows([{ roleId: null, legacyRole: "member" }]); // membership
    pg.queueRows([{ systemKey: "member" }, { systemKey: "owner" }, { systemKey: "admin" }]); // ensure
    pg.queueRows([
      roleRow({ id: "r-member", name: "Member", isSystem: true, systemKey: "member" }),
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.role?.systemKey).toBe("member");
    expect(out.permissions).toEqual(systemRoles.systemRolePermissions("member"));
  });

  it("returns empty when there is neither a usable roleId nor a known legacy role", async () => {
    pg.queueRows([{ roleId: null, legacyRole: "garbage" }]); // membership
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out).toEqual({ permissions: [], role: null, elevations: [] });
  });

  it("unions a live break-glass grant into the effective permissions", async () => {
    pg.queueRows([{ roleId: "r-custom", legacyRole: null }]); // membership
    pg.queueRows([roleRow({ id: "r-custom", name: "Reader", permissions: ["resources:read"] })]);
    mockActiveElevations.mockResolvedValue([
      {
        requestId: "req-1",
        permissions: ["resources:delete"],
        expiresAt: "2026-08-07T12:00:00.000Z",
        reason: "INC-4417",
      },
    ]);

    const out = await resolver.resolveEffectivePermissions("org1", { kind: "user", userId: "u1" });

    expect(out.permissions).toEqual(["resources:read", "resources:delete"]);
    // The *role* still says what the role says. Folding the elevation in here
    // too would make the role editor show a permission nobody assigned, that
    // vanishes on its own an hour later.
    expect(out.role?.permissions).toEqual(["resources:read"]);
    expect(out.elevations).toHaveLength(1);
  });

  it("does not duplicate a granted permission the role already carries", async () => {
    pg.queueRows([{ roleId: "r-custom", legacyRole: null }]);
    pg.queueRows([roleRow({ id: "r-custom", name: "Reader", permissions: ["resources:read"] })]);
    mockActiveElevations.mockResolvedValue([
      {
        requestId: "req-1",
        permissions: ["resources:read"],
        expiresAt: "2026-08-07T12:00:00.000Z",
        reason: "belt and braces",
      },
    ]);

    const out = await resolver.resolveEffectivePermissions("org1", { kind: "user", userId: "u1" });
    expect(out.permissions).toEqual(["resources:read"]);
  });

  it("ignores a grant when the membership is gone", async () => {
    // A grant is scoped to a membership. Honouring one after the member was
    // removed would be a way for them to keep access.
    pg.queueRows([]); // membership lookup -> none
    mockActiveElevations.mockResolvedValue([
      {
        requestId: "req-1",
        permissions: ["*"],
        expiresAt: "2026-08-07T12:00:00.000Z",
        reason: "should not apply",
      },
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", { kind: "user", userId: "u1" });
    expect(out).toEqual({ permissions: [], role: null, elevations: [] });
  });

  it("skips the elevation read entirely when the caller opts out", async () => {
    pg.queueRows([{ roleId: null, legacyRole: "member" }]);
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]);
    pg.queueRows([
      roleRow({ id: "r-member", name: "Member", isSystem: true, systemKey: "member" }),
    ]);

    const out = await resolver.resolveEffectivePermissions(
      "org1",
      { kind: "user", userId: "u1" },
      { includeElevation: false },
    );

    expect(mockActiveElevations).not.toHaveBeenCalled();
    expect(out.elevations).toEqual([]);
    expect(out.permissions).toEqual(systemRoles.systemRolePermissions("member"));
  });
});

describe("backfillMembershipRole", () => {
  it("returns null when there is no membership", async () => {
    pg.queueRows([]); // membership
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out).toBeNull();
  });

  it("returns the existing role (system) without writing when roleId resolves", async () => {
    pg.queueRows([{ id: "m1", roleId: "r-owner", legacyRole: null }]); // membership
    pg.queueRows([
      roleRow({
        id: "r-owner",
        name: "Owner",
        description: "d",
        isSystem: true,
        systemKey: "owner",
        permissions: ["STALE"],
      }),
    ]);
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("owner");
    expect(out?.permissions).toEqual(systemRoles.systemRolePermissions("owner"));
    expect(membershipUpdates()).toEqual([]);
  });

  it("returns an existing custom role's stored perms without writing", async () => {
    pg.queueRows([{ id: "m1", roleId: "r-c", legacyRole: null }]);
    pg.queueRows([roleRow({ id: "r-c", name: "Custom", permissions: ["accounts:read"] })]);
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.isSystem).toBe(false);
    expect(out?.permissions).toEqual(["accounts:read"]);
    expect(membershipUpdates()).toEqual([]);
  });

  it("assigns the legacy-derived system role and writes roleId when no roleId is set", async () => {
    pg.queueRows([{ id: "m1", roleId: null, legacyRole: "admin" }]); // membership
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure (inside getSystemRole)
    pg.queueRows([
      roleRow({
        id: "r-admin",
        name: "Admin",
        description: "d",
        isSystem: true,
        systemKey: "admin",
      }),
    ]); // system role row
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("admin");
    expect(membershipUpdates()).toHaveLength(1);
    // set "role_id" = $1 where "id" = $2
    expect(membershipUpdates()[0]!.params).toEqual(["r-admin", "m1"]);
  });

  it("defaults to the member system role when the legacy role is unknown", async () => {
    pg.queueRows([{ id: "m1", roleId: null, legacyRole: "nonsense" }]); // membership
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    pg.queueRows([
      roleRow({ id: "r-member", name: "Member", isSystem: true, systemKey: "member" }),
    ]); // system row
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("member");
    expect(membershipUpdates()[0]!.params).toEqual(["r-member", "m1"]);
  });

  it("falls through to assignment when roleId points at a deleted row", async () => {
    pg.queueRows([{ id: "m1", roleId: "gone", legacyRole: "member" }]); // membership
    pg.queueRows([]); // roleId lookup -> deleted
    pg.queueRows([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    pg.queueRows([
      roleRow({ id: "r-member", name: "Member", isSystem: true, systemKey: "member" }),
    ]);
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("member");
    expect(membershipUpdates()).toHaveLength(1);
  });
});
