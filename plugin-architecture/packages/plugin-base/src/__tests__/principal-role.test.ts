import { describe, expect, it } from "vitest";
import { resourceTypeDefinitionSchema } from "../validation/resource.schema.js";
import {
  DEFAULT_PRINCIPAL_CREATED_KEY,
  DEFAULT_PRINCIPAL_LAST_USED_KEY,
  resolvePrincipalKeys,
} from "../principal.js";

function typeWith(principalRole: unknown) {
  return {
    id: "iam-user",
    displayName: "IAM User",
    pluralDisplayName: "IAM Users",
    description: "A user",
    fields: [],
    outputs: [],
    dashboardPinnable: false,
    principalRole,
  };
}

describe("principalRole schema", () => {
  it("accepts a bare role", () => {
    expect(resourceTypeDefinitionSchema.safeParse(typeWith({ role: "key" })).success).toBe(true);
  });

  it("accepts every documented role", () => {
    for (const role of ["user", "group", "role", "service-account", "key", "binding"]) {
      expect(resourceTypeDefinitionSchema.safeParse(typeWith({ role })).success).toBe(true);
    }
  });

  it("rejects an unknown role", () => {
    expect(resourceTypeDefinitionSchema.safeParse(typeWith({ role: "robot" })).success).toBe(false);
  });

  // The `privateValues` / `runningValues` / `maxAgeDays` stance: a value list
  // with no field to read is dead config, not a silently inert rule.
  it("rejects adminValues without adminIndicatorKey", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      typeWith({ role: "role", adminValues: ["admin"] }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts adminValues alongside adminIndicatorKey", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      typeWith({ role: "role", adminIndicatorKey: "permissions", adminValues: ["*"] }),
    );
    expect(parsed.success).toBe(true);
  });

  // A key or a binding cannot enrol a second factor, so an `mfaKey` there
  // could only ever produce a permanent false "no MFA" finding.
  it("rejects mfaKey on a non-user role", () => {
    for (const role of ["group", "role", "service-account", "key", "binding"]) {
      const parsed = resourceTypeDefinitionSchema.safeParse(typeWith({ role, mfaKey: "mfaOn" }));
      expect(parsed.success, `role ${role} should reject mfaKey`).toBe(false);
    }
  });

  it("accepts mfaKey on a user role", () => {
    const parsed = resourceTypeDefinitionSchema.safeParse(
      typeWith({ role: "user", mfaKey: "mfaEnabled" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects empty key names", () => {
    expect(
      resourceTypeDefinitionSchema.safeParse(typeWith({ role: "key", lastUsedKey: "" })).success,
    ).toBe(false);
  });
});

describe("resolvePrincipalKeys", () => {
  it("fills the documented defaults", () => {
    expect(resolvePrincipalKeys({ role: "key" })).toEqual({
      role: "key",
      lastUsedKey: DEFAULT_PRINCIPAL_LAST_USED_KEY,
      createdKey: DEFAULT_PRINCIPAL_CREATED_KEY,
      adminIndicatorKey: null,
      adminValues: null,
      parentKey: null,
      mfaKey: null,
      revokeActionId: null,
    });
  });

  it("keeps explicit keys", () => {
    const resolved = resolvePrincipalKeys({
      role: "user",
      lastUsedKey: "passwordLastUsed",
      createdKey: "createDate",
      adminIndicatorKey: "role",
      adminValues: ["owner"],
      parentKey: "userId",
      mfaKey: "mfaEnabled",
      revokeActionId: "deactivate",
    });
    expect(resolved.lastUsedKey).toBe("passwordLastUsed");
    expect(resolved.createdKey).toBe("createDate");
    expect(resolved.adminValues).toEqual(["owner"]);
    expect(resolved.revokeActionId).toBe("deactivate");
  });
});
