import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoOrganizationInviteResourceType = rt({
  name: "Organization Invite",
  pinnable: false,
  id: "turso-organization-invite",
  description: "A pending invitation to join the configured Turso organization",
  fields: [
    f("email", "Email"),
    f("role", "Role", {
      showcase: true,
      kind: "enum",
      required: false,
      enumValues: ["admin", "member", "viewer"],
    }),
    f("createdAt", "Invited At", { showcase: true, required: false }),
  ],
  outputs: [o("email", "Email")],
  supportsCreate: true,
  iconKey: "invite",
});
