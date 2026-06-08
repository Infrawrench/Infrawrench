import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PsPasswordResourceType: ResourceTypeDefinition = {
  id: "ps-password",
  displayName: "Password",
  pluralDisplayName: "Passwords",
  description:
    "A PlanetScale branch password record. Plaintext secrets are only returned at creation.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "databaseName", label: "Database", kind: "string", required: true },
    { key: "branchName", label: "Branch", kind: "string", required: true },
    { key: "role", label: "Role", kind: "string", required: false },
    { key: "username", label: "Username", kind: "string", required: false },
    { key: "host", label: "Host", kind: "string", required: false },
    { key: "expired", label: "Expired", kind: "boolean", required: false },
    { key: "replica", label: "Replica", kind: "boolean", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "expiresAt", label: "Expires At", kind: "string", required: false },
    { key: "lastUsedAt", label: "Last Used At", kind: "string", required: false },
  ],
  outputs: [
    { key: "username", label: "Username", sensitive: false },
    { key: "host", label: "Host", sensitive: false },
  ],
  parentTypeId: "ps-branch",
  dashboardPinnable: false,
  iconKey: "planetscale",
};
