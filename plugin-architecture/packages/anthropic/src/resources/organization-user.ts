import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A member of the Console organization. Admin-key only.
 *
 * Roles are readable in full, but only a subset can be *assigned* through the
 * API — `admin`, `owner`, `primary_owner` and `membership_admin` are
 * console-only, and members holding them cannot be removed via the API either.
 *
 * Docs: https://platform.claude.com/docs/en/api/admin-api/users/list-users
 */
export const OrganizationUserResourceType = rt({
  name: "Organization Member",
  plural: "Organization Members",
  id: "organization-user",
  description:
    "A member of the Console organization. Requires an Admin API key. Roles assignable through the API are user, developer, billing, claude_code_user and (Claude Enterprise) managed — admins and owners can only be changed in the Console.",
  fields: [
    f("email", "Email", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: [
        "user",
        "developer",
        "billing",
        "claude_code_user",
        "managed",
        "admin",
        "membership_admin",
        "owner",
        "primary_owner",
      ],
    }),
    f("addedAt", "Joined", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  // The four console-only roles are the privileged ones; `role` is a single
  // slug so matching the whole value is exact. No last-used: the Admin API
  // reports no member activity at all.
  principalRole: {
    role: "user",
    createdKey: "addedAt",
    adminIndicatorKey: "role",
    adminValues: ["admin", "membership_admin", "owner", "primary_owner"],
  },
  supportsCreate: false,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});
