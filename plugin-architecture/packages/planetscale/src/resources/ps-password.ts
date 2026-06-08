import { f, o, rt } from "@infrawrench/plugin-base";

export const PsPasswordResourceType = rt({
  name: "Password",
  pinnable: false,
  id: "ps-password",
  description:
    "A PlanetScale branch password record. Plaintext secrets are only returned at creation.",
  fields: [
    f("name", "Name"),
    f("databaseName", "Database"),
    f("branchName", "Branch"),
    f("role", "Role", { required: false }),
    f("username", "Username", { required: false }),
    f("host", "Host", { required: false }),
    f("expired", "Expired", { kind: "boolean", required: false }),
    f("replica", "Replica", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
    f("lastUsedAt", "Last Used At", { required: false }),
  ],
  outputs: [o("username", "Username"), o("host", "Host")],
  parentTypeId: "ps-branch",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "planetscale",
});
