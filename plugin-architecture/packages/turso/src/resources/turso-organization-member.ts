import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoOrganizationMemberResourceType: ResourceTypeDefinition = {
  id: "turso-organization-member",
  displayName: "Organization Member",
  pluralDisplayName: "Organization Members",
  description: "A member of the configured Turso organization",
  fields: [
    { key: "username", label: "Username", kind: "string", required: true },
    { key: "email", label: "Email", kind: "string", required: false },
    {
      key: "role",
      label: "Role",
      kind: "enum",
      required: false,
      enumValues: ["admin", "member", "viewer"],
    },
  ],
  outputs: [
    { key: "username", label: "Username", sensitive: false },
    { key: "email", label: "Email", sensitive: false },
  ],
  dashboardPinnable: false,
  supportsUpdate: true,
  iconKey: "turso",
};
