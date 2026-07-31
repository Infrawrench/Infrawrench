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
  // A branch's external id is `{database}/{branch}` while `branchName` is bare —
  // the template composes the qualified id the branch actually answers to.
  dependsOn: [
    { fieldKey: "databaseName", targetTypeId: "ps-database", label: "in database" },
    {
      fieldKey: "branchName",
      targetTypeId: "ps-branch",
      matchTemplate: "{databaseName}/{branchName}",
      label: "on branch",
    },
  ],
  parentTypeId: "ps-branch",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "planetscale",
});
