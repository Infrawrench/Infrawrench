import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An environment role from the WorkOS Authorization API. Roles are addressed
 * by slug; the API offers list/create/update but no delete (removal happens
 * in the WorkOS dashboard).
 * Docs: https://workos.com/docs/reference/roles
 */
export const RoleResourceType = rt({
  name: "Role",
  id: "role",
  description:
    "An environment role — assignable to organization memberships and invitations by slug. The API has no delete; remove roles in the WorkOS dashboard.",
  fields: [
    f("slug", "Slug", { editable: false }),
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("type", "Scope", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["EnvironmentRole", "OrganizationRole"],
    }),
    f("permissions", "Permissions", {
      required: false,
      editable: false,
      description: "Permission slugs assigned to the role, comma-separated.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("roleSlug", "Role Slug")],
  // `permissions` is the joined slug list; `adminValues: ["*"]` matches the
  // whole stored value, so only a role whose sole permission is the wildcard
  // flags. A substring match would call `widgets:read, *` and `read:*` the
  // same thing — the `sourceRanges equals "0.0.0.0/0"` stance the posture
  // rules already take.
  principalRole: {
    role: "role",
    createdKey: "createdAt",
    adminIndicatorKey: "permissions",
    adminValues: ["*"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "role",
});
