import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTION_PERMISSION,
  WITNESSED_PERMISSIONS,
  permissionForAuditAction,
  permissionsExercised,
} from "../hygiene/action-permissions";
import { ALL_PERMISSIONS } from "../permissions/catalog";

describe("audit action → permission mapping", () => {
  it("maps every value to a real catalog permission", () => {
    // A typo here would silently make a permission look unexercised forever.
    for (const [action, permission] of Object.entries(AUDIT_ACTION_PERMISSION)) {
      expect(ALL_PERMISSIONS, `${action} → ${permission}`).toContain(permission);
    }
  });

  it("keeps update and delete on distinct permissions", () => {
    // A prefix rule over `resource.` would collapse these two, and the
    // difference is exactly what a reviewer cares about.
    expect(permissionForAuditAction("resource.update")).toBe("resources:write");
    expect(permissionForAuditAction("resource.delete")).toBe("resources:delete");
  });

  it("returns null for an action carrying no permission signal", () => {
    expect(permissionForAuditAction("sync.push")).toBeNull();
    expect(permissionForAuditAction("change_freeze.block")).toBeNull();
    expect(permissionForAuditAction("something.invented.today")).toBeNull();
  });

  it("never claims to witness a read permission", () => {
    // Reads leave no audit row, so an absence of evidence about them proves
    // nothing — and the report must never conclude one is unused.
    const reads: readonly string[] = ALL_PERMISSIONS.filter((p) => p.endsWith(":read"));
    const witnessedReads = WITNESSED_PERMISSIONS.filter((p) => reads.includes(p));
    // `secrets:read` and `session-recordings:read` are the deliberate
    // exceptions: both ARE audit-logged, precisely because reading a
    // credential or watching a recorded terminal is a disclosure.
    expect(witnessedReads.sort()).toEqual(["secrets:read", "session-recordings:read"]);
  });

  it("dedupes and sorts the witnessed set", () => {
    expect(WITNESSED_PERMISSIONS).toEqual([...new Set(WITNESSED_PERMISSIONS)].sort());
  });
});

describe("permissionsExercised", () => {
  it("collapses many actions into the distinct permissions they demonstrate", () => {
    expect(
      permissionsExercised(["resource.create", "resource.update", "ssh.exec", "sql.execute"]),
    ).toEqual(["resources:execute", "resources:write"]);
  });

  it("drops actions with no mapping rather than inventing one", () => {
    expect(permissionsExercised(["sync.push", "resource.delete"])).toEqual(["resources:delete"]);
  });

  it("is empty for no actions", () => {
    expect(permissionsExercised([])).toEqual([]);
  });
});
