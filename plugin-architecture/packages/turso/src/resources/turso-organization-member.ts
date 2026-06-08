import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoOrganizationMemberResourceType = rt({
  name: "Organization Member",
  pinnable: false,
  id: "turso-organization-member",
  description: "A member of the configured Turso organization",
  fields: [
    f("username", "Username"),
    f("email", "Email", { required: false }),
    f("role", "Role", { kind: "enum", required: false, enumValues: ["admin", "member", "viewer"] }),
  ],
  outputs: [o("username", "Username"), o("email", "Email")],
  supportsUpdate: true,
  iconKey: "turso",
});
