import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A WorkOS User Management user. Users are environment-level in WorkOS — one
 * user can hold memberships in many organizations — so this is a top-level
 * type rather than a child of `organization`.
 * Docs: https://workos.com/docs/reference/user-management/user
 */
export const UserResourceType = rt({
  name: "User",
  id: "user",
  description:
    "An AuthKit / User Management user. Environment-level: one user can belong to many organizations through organization memberships.",
  fields: [
    f("email", "Email", { editable: false }),
    f("firstName", "First Name", { required: false }),
    f("lastName", "Last Name", { required: false }),
    f("emailVerified", "Email Verified", { kind: "boolean", required: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("externalId", "External ID", { required: false, editable: false }),
    f("lastSignInAt", "Last Sign-In", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("userId", "User ID", {
      description: "The user_… id used in membership and invitation calls.",
    }),
    o("email", "Email"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});
