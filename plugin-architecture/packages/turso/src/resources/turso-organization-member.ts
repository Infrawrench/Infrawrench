import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoOrganizationMemberResourceType = rt({
  name: "Organization Member",
  pinnable: false,
  id: "turso-organization-member",
  description: "A member of the configured Turso organization",
  fields: [
    f("username", "Username", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("role", "Role", {
      kind: "enum",
      required: false,
      enumValues: ["owner", "admin", "member", "viewer"],
    }),
  ],
  outputs: [o("username", "Username"), o("email", "Email")],
  // Turso's member list carries no timestamps; the role is the one signal.
  principalRole: { role: "user", adminIndicatorKey: "role", adminValues: ["owner", "admin"] },
  supportsUpdate: true,
  iconKey: "turso",
});
