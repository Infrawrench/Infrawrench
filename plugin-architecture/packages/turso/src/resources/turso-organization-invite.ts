import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoOrganizationInviteResourceType: ResourceTypeDefinition = {
  id: "turso-organization-invite",
  displayName: "Organization Invite",
  pluralDisplayName: "Organization Invites",
  description: "A pending invitation to join the configured Turso organization",
  fields: [
    { key: "email", label: "Email", kind: "string", required: true },
    { key: "username", label: "Username", kind: "string", required: false },
    {
      key: "role",
      label: "Role",
      kind: "enum",
      required: false,
      enumValues: ["admin", "member", "viewer"],
    },
  ],
  outputs: [
    { key: "email", label: "Email", sensitive: false },
    { key: "username", label: "Username", sensitive: false },
  ],
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "turso",
};
