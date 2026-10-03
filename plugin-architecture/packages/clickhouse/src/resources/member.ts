import { f, o, rt } from "@infrawrench/plugin-base";

/** A user in the ClickHouse Cloud organization. Deleting removes them from it. */
export const MemberResourceType = rt({
  name: "Member",
  id: "ch-member",
  description: "A member of the ClickHouse Cloud organization",
  fields: [
    f("userId", "User ID"),
    f("name", "Name", { required: false }),
    f("email", "Email", { required: false }),
    f("roles", "Roles", { required: false }),
    f("isAdmin", "Admin", {
      kind: "boolean",
      required: false,
      description: "True when an assigned role is an admin role.",
    }),
    f("joinedAt", "Joined", { required: false }),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  principalRole: {
    role: "user",
    createdKey: "joinedAt",
    adminIndicatorKey: "isAdmin",
  },
  iconKey: "user",
});
