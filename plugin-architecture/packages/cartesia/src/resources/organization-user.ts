import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A member of the Cartesia organization. Admin-key only: listed from
 * `GET /organizations/users` and removed with
 * `DELETE /organizations/users/{id}`, which only works on non-admins.
 * https://docs.cartesia.ai/api-reference/organizations/list-users
 * https://docs.cartesia.ai/api-reference/organizations/remove-user
 */
export const OrganizationUserResourceType = rt({
  name: "Organization Member",
  plural: "Organization Members",
  id: "organization-user",
  description:
    "A member of the Cartesia organization. Requires an admin API key; removing a member keeps their Cartesia account, and admins cannot be removed through the API",
  fields: [
    f("email", "Email", { required: false }),
    f("name", "Name", { required: false }),
    f("role", "Role", { kind: "enum", required: false, enumValues: ["admin", "member"] }),
    f("userId", "User ID", { required: false }),
    f("joinedAt", "Joined", { required: false }),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  principalRole: {
    role: "user",
    createdKey: "joinedAt",
    adminIndicatorKey: "role",
    adminValues: ["admin"],
  },
  iconKey: "user",
});
