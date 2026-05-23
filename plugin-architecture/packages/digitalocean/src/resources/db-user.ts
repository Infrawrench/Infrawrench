import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * A database user on a DigitalOcean managed-database cluster. Lives under the
 * parent `managed-database` resource so the host renders it as a "DB Users"
 * section in the cluster's detail page and a child group in its sidebar entry.
 *
 * The user's `password` is captured the moment DO mints them (POST
 * `/databases/{id}/users` is the only API that returns the plaintext) and
 * persisted via `secretStates` so the cluster's `connectionString` output can
 * substitute it in when DO refuses to hand back `doadmin`'s password (the
 * common case for tokens minted without `database:view_credentials`).
 */
export const DatabaseUserResourceType: ResourceTypeDefinition = {
  id: "db-user",
  displayName: "Database user",
  pluralDisplayName: "DB Users",
  description: "A managed-database user — created server-side, password kept locally.",
  fields: [
    {
      key: "name",
      label: "Username",
      kind: "string",
      required: true,
      description: "Letters, digits, and `_-` only. Must be unique within the cluster.",
    },
    {
      key: "role",
      label: "Role",
      kind: "string",
      required: false,
      description: "DO-assigned role — `primary` for the bootstrap user, `normal` for the rest.",
    },
  ],
  outputs: [
    {
      key: "password",
      label: "Password",
      sensitive: true,
      description:
        "The plaintext password DO returned at create time. Only available for users " +
        "Infrawrench minted itself — pre-existing users (including `doadmin`) have no " +
        "stored password because DO doesn't expose them post-create.",
    },
  ],
  parentTypeId: "managed-database",
  supportsCreate: true,
  dashboardPinnable: false,
  iconKey: "user",
};
