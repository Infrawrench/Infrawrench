import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonAuthResourceType = rt({
  name: "Auth",
  plural: "Auth",
  id: "neon-auth",
  description: "Neon Auth on a branch — managed Better Auth backed by the branch's database",
  fields: [
    f("authProvider", "Provider"),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("databaseName", "Database"),
    f("jwksUrl", "JWKS URL", { required: false }),
    f("baseUrl", "Base URL", { required: false }),
    f("emailAndPassword", "Email + Password", { kind: "boolean", required: false }),
    f("allowLocalhost", "Allow Localhost", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [
    o("jwksUrl", "JWKS URL"),
    o("baseUrl", "Base URL"),
    o("projectId", "Project ID"),
    o("branchId", "Branch ID"),
  ],
  parentTypeId: "neon-branch",
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "user",
  secretExportTemplates: [
    {
      id: "jwks",
      displayName: "JWKS URL",
      description: "JWKS endpoint for verifying Neon Auth JWTs (e.g. from Postgres RLS policies)",
      entries: [{ envKey: "NEON_AUTH_JWKS_URL", outputKey: "jwksUrl" }],
    },
  ],
});
