import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Postgres branches authenticate with roles rather than MySQL-style branch
 * passwords. Like a password, the role's secret is only returned when it is
 * created (or reset), so `connectionString` is captured from that response.
 */
export const PsRoleResourceType = rt({
  name: "Postgres Role",
  pinnable: false,
  id: "ps-role",
  description: "A PlanetScale Postgres branch role. The password is only returned at creation.",
  fields: [
    f("name", "Name", { required: false }),
    f("databaseName", "Database", { editable: false }),
    f("branchName", "Branch", { editable: false }),
    f("username", "Username", { required: false, editable: false }),
    f("host", "Host", { required: false, editable: false }),
    f("inheritedRoles", "Inherited Roles", { required: false, editable: false }),
    f("superuser", "Inherits postgres", { kind: "boolean", required: false, editable: false }),
    f("default", "Default Role", { kind: "boolean", required: false, editable: false }),
    f("expired", "Expired", { kind: "boolean", required: false, editable: false }),
    f("requireWhereOnDelete", "Require WHERE on DELETE", {
      kind: "enum",
      enumValues: ["off", "warn", "on"],
      required: false,
    }),
    f("requireWhereOnUpdate", "Require WHERE on UPDATE", {
      kind: "enum",
      enumValues: ["off", "warn", "on"],
      required: false,
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("expiresAt", "Expires At", { required: false, editable: false }),
  ],
  outputs: [
    o("username", "Username"),
    o("host", "Host"),
    o("connectionString", "Connection String (Postgres)", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "databaseName", targetTypeId: "ps-database", label: "in database" },
    {
      fieldKey: "branchName",
      targetTypeId: "ps-branch",
      matchTemplate: "{databaseName}/{branchName}",
      label: "on branch",
    },
  ],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "api-token", label: "Role expires" },
  ],
  // `superuser` is derived at list time: inheriting the `postgres` role is
  // what makes a PlanetScale role administrative, and `inheritedRoles` is a
  // joined list the whole-value match could not read.
  principalRole: { role: "key", createdKey: "createdAt", adminIndicatorKey: "superuser" },
  parentTypeId: "ps-branch",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "planetscale",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for this role. Only available on the role you just created.",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
