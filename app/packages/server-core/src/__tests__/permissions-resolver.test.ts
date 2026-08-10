import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The resolver builds Drizzle queries shaped like:
 *   db.select(...).from(...).where(...)               -> Promise<rows>
 *   db.select(...).from(...).where(...).limit(n)       -> Promise<rows>
 *   db.insert(t).values(v).onConflictDoNothing()       -> Promise
 *   db.update(t).set(v).where(w)                        -> Promise
 *
 * We make `.where()` a thenable that ALSO exposes `.limit()`, so both shapes
 * work. Each terminal awaited query pulls the next queued result so tests can
 * script a precise sequence of DB responses.
 */
const selectResults: unknown[][] = [];
let lastInsertValues: unknown = undefined;
const insertOnConflictDoNothing = vi.fn(async () => undefined);
const updateWhere = vi.fn(async () => undefined);
let updateSetArg: unknown = undefined;

function nextSelectRows(): unknown[] {
  return selectResults.shift() ?? [];
}

function makeWhereThenable() {
  const rowsForThis = nextSelectRows();
  // A promise that resolves to the rows, but also carries `.limit()`.
  const p = Promise.resolve(rowsForThis) as Promise<unknown[]> & {
    limit: (n: number) => Promise<unknown[]>;
  };
  p.limit = () => Promise.resolve(rowsForThis);
  return p;
}

const dbSelect = vi.fn(() => ({
  from: () => ({
    where: () => makeWhereThenable(),
  }),
}));

const dbInsert = vi.fn(() => ({
  values: (v: unknown) => {
    lastInsertValues = v;
    return { onConflictDoNothing: insertOnConflictDoNothing };
  },
}));

const dbUpdate = vi.fn(() => ({
  set: (v: unknown) => {
    updateSetArg = v;
    return { where: updateWhere };
  },
}));

vi.mock("../db/client", () => ({
  db: { select: dbSelect, insert: dbInsert, update: dbUpdate },
}));

/**
 * Break-glass grants are resolved alongside the role, but they have their own
 * suite — here we only care that the resolver unions them in for people and
 * leaves them out for keys and non-members.
 */
const mockActiveElevations = vi.fn(async () => [] as unknown[]);
vi.mock("../access/break-glass", () => ({
  activeElevations: (...a: unknown[]) => mockActiveElevations(...(a as [])),
}));
vi.mock("../db/schema", () => ({
  organizationMembers: {
    id: "om.id",
    userId: "om.userId",
    organizationId: "om.organizationId",
    roleId: "om.roleId",
    role: "om.role",
  },
  roles: {
    id: "r.id",
    organizationId: "r.organizationId",
    name: "r.name",
    description: "r.description",
    isSystem: "r.isSystem",
    systemKey: "r.systemKey",
    permissions: "r.permissions",
  },
}));

let resolver: typeof import("../permissions/resolver");
let systemRoles: typeof import("../permissions/system-roles");

beforeEach(async () => {
  vi.clearAllMocks();
  selectResults.length = 0;
  lastInsertValues = undefined;
  updateSetArg = undefined;
  mockActiveElevations.mockResolvedValue([]);
  resolver = await import("../permissions/resolver");
  systemRoles = await import("../permissions/system-roles");
});

describe("ensureSystemRoles", () => {
  it("inserts the three system roles when none exist", async () => {
    selectResults.push([]); // existing systemKeys: none
    await resolver.ensureSystemRoles("org1");
    expect(dbInsert).toHaveBeenCalledTimes(1);
    const inserted = lastInsertValues as Array<{ systemKey: string; organizationId: string }>;
    expect(inserted.map((r) => r.systemKey).sort()).toEqual(["admin", "member", "owner"]);
    expect(inserted.every((r) => r.organizationId === "org1")).toBe(true);
    expect(insertOnConflictDoNothing).toHaveBeenCalled();
  });

  it("only inserts the missing keys", async () => {
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }]);
    await resolver.ensureSystemRoles("org1");
    const inserted = lastInsertValues as Array<{ systemKey: string }>;
    expect(inserted.map((r) => r.systemKey)).toEqual(["member"]);
  });

  it("does not insert when all keys are present", async () => {
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]);
    await resolver.ensureSystemRoles("org1");
    expect(dbInsert).not.toHaveBeenCalled();
  });
});

describe("getSystemRole", () => {
  it("returns the row enriched with in-code permissions", async () => {
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    selectResults.push([{ id: "r-owner", name: "Owner", description: "desc" }]); // the role lookup
    const role = await resolver.getSystemRole("org1", "owner");
    expect(role.id).toBe("r-owner");
    expect(role.isSystem).toBe(true);
    expect(role.systemKey).toBe("owner");
    expect(role.permissions).toEqual(systemRoles.systemRolePermissions("owner"));
  });

  it("throws when the system role row is missing", async () => {
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    selectResults.push([]); // missing role
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
    expect(dbSelect).not.toHaveBeenCalled();
    // A key must never pick up its owner's break-glass grant: the elevation
    // was handed to a person for a bounded window on a stated reason, and a
    // key they minted last quarter is neither.
    expect(mockActiveElevations).not.toHaveBeenCalled();
  });
});

describe("resolveEffectivePermissions — user", () => {
  it("returns empty when there is no membership", async () => {
    selectResults.push([]); // membership lookup -> none
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out).toEqual({ permissions: [], role: null, elevations: [] });
  });

  it("resolves a custom (non-system) role's stored permissions", async () => {
    selectResults.push([{ roleId: "r-custom", legacyRole: null }]); // membership
    selectResults.push([
      {
        id: "r-custom",
        name: "Custom",
        description: null,
        isSystem: false,
        systemKey: null,
        permissions: ["accounts:read", "team:read"],
      },
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
    selectResults.push([{ roleId: "r-authors", legacyRole: null }]); // membership
    selectResults.push([
      {
        id: "r-authors",
        name: "Workflow authors",
        description: null,
        isSystem: false,
        systemKey: null,
        // Deliberately withholds approve while granting everything around it.
        permissions: ["dashboards:read", "dashboards:write", "workflows:read", "workflows:write"],
        updatedAt: new Date("2020-01-01T00:00:00Z"), // long "before" any cutover
      },
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
    selectResults.push([{ roleId: "r-owner", legacyRole: null }]); // membership
    selectResults.push([
      {
        id: "r-owner",
        name: "Owner",
        description: "d",
        isSystem: true,
        systemKey: "owner",
        permissions: ["STALE"], // should be ignored
      },
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
    selectResults.push([{ roleId: "r-x", legacyRole: null }]); // membership
    selectResults.push([
      {
        id: "r-x",
        name: "Weird",
        description: null,
        isSystem: true,
        systemKey: "bogus",
        permissions: ["audit:read"],
      },
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
    selectResults.push([{ roleId: "r-empty", legacyRole: null }]);
    selectResults.push([
      {
        id: "r-empty",
        name: "Empty",
        description: null,
        isSystem: false,
        systemKey: null,
        permissions: null,
      },
    ]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.permissions).toEqual([]);
  });

  it("falls back to the legacy text role when roleId points at a deleted row", async () => {
    selectResults.push([{ roleId: "gone", legacyRole: "admin" }]); // membership
    selectResults.push([]); // roleId lookup -> deleted
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensureSystemRoles inside getSystemRole
    selectResults.push([{ id: "r-admin", name: "Admin", description: "d" }]); // system role row
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.role?.systemKey).toBe("admin");
    expect(out.permissions).toEqual(systemRoles.systemRolePermissions("admin"));
  });

  it("falls back to the legacy text role when there is no roleId at all", async () => {
    selectResults.push([{ roleId: null, legacyRole: "member" }]); // membership
    selectResults.push([{ systemKey: "member" }, { systemKey: "owner" }, { systemKey: "admin" }]); // ensure
    selectResults.push([{ id: "r-member", name: "Member", description: null }]);
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out.role?.systemKey).toBe("member");
    expect(out.permissions).toEqual(systemRoles.systemRolePermissions("member"));
  });

  it("returns empty when there is neither a usable roleId nor a known legacy role", async () => {
    selectResults.push([{ roleId: null, legacyRole: "garbage" }]); // membership
    const out = await resolver.resolveEffectivePermissions("org1", {
      kind: "user",
      userId: "u1",
    });
    expect(out).toEqual({ permissions: [], role: null, elevations: [] });
  });

  it("unions a live break-glass grant into the effective permissions", async () => {
    selectResults.push([{ roleId: "r-custom", legacyRole: null }]); // membership
    selectResults.push([
      {
        id: "r-custom",
        organizationId: "org1",
        name: "Reader",
        description: null,
        isSystem: false,
        systemKey: null,
        permissions: ["resources:read"],
      },
    ]);
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
    selectResults.push([{ roleId: "r-custom", legacyRole: null }]);
    selectResults.push([
      {
        id: "r-custom",
        organizationId: "org1",
        name: "Reader",
        description: null,
        isSystem: false,
        systemKey: null,
        permissions: ["resources:read"],
      },
    ]);
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
    selectResults.push([]); // membership lookup -> none
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
    selectResults.push([{ roleId: null, legacyRole: "member" }]);
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]);
    selectResults.push([{ id: "r-member", name: "Member", description: null }]);

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
    selectResults.push([]); // membership
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out).toBeNull();
  });

  it("returns the existing role (system) without writing when roleId resolves", async () => {
    selectResults.push([{ id: "m1", roleId: "r-owner", legacyRole: null }]); // membership
    selectResults.push([
      {
        id: "r-owner",
        name: "Owner",
        description: "d",
        isSystem: true,
        systemKey: "owner",
        permissions: ["STALE"],
      },
    ]);
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("owner");
    expect(out?.permissions).toEqual(systemRoles.systemRolePermissions("owner"));
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("returns an existing custom role's stored perms without writing", async () => {
    selectResults.push([{ id: "m1", roleId: "r-c", legacyRole: null }]);
    selectResults.push([
      {
        id: "r-c",
        name: "Custom",
        description: null,
        isSystem: false,
        systemKey: null,
        permissions: ["accounts:read"],
      },
    ]);
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.isSystem).toBe(false);
    expect(out?.permissions).toEqual(["accounts:read"]);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("assigns the legacy-derived system role and writes roleId when no roleId is set", async () => {
    selectResults.push([{ id: "m1", roleId: null, legacyRole: "admin" }]); // membership
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure (inside getSystemRole)
    selectResults.push([{ id: "r-admin", name: "Admin", description: "d" }]); // system role row
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("admin");
    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(updateSetArg).toEqual({ roleId: "r-admin" });
    expect(updateWhere).toHaveBeenCalled();
  });

  it("defaults to the member system role when the legacy role is unknown", async () => {
    selectResults.push([{ id: "m1", roleId: null, legacyRole: "nonsense" }]); // membership
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    selectResults.push([{ id: "r-member", name: "Member", description: null }]); // system row
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("member");
    expect(updateSetArg).toEqual({ roleId: "r-member" });
  });

  it("falls through to assignment when roleId points at a deleted row", async () => {
    selectResults.push([{ id: "m1", roleId: "gone", legacyRole: "member" }]); // membership
    selectResults.push([]); // roleId lookup -> deleted
    selectResults.push([{ systemKey: "owner" }, { systemKey: "admin" }, { systemKey: "member" }]); // ensure
    selectResults.push([{ id: "r-member", name: "Member", description: null }]);
    const out = await resolver.backfillMembershipRole("org1", "u1");
    expect(out?.systemKey).toBe("member");
    expect(dbUpdate).toHaveBeenCalled();
  });
});
