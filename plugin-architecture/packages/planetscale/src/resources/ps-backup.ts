import { f, o, rt } from "@infrawrench/plugin-base";

export const PsBackupResourceType = rt({
  name: "Backup",
  id: "ps-backup",
  description: "A PlanetScale branch backup",
  fields: [
    f("name", "Name"),
    f("databaseName", "Database"),
    f("branchName", "Branch"),
    f("state", "State", { required: false }),
    f("size", "Size", { kind: "number", required: false }),
    f("protected", "Protected", { kind: "boolean", required: false }),
    f("required", "Required", { kind: "boolean", required: false }),
    f("createdAt", "Created At", { required: false }),
    f("startedAt", "Started At", { required: false }),
    f("completedAt", "Completed At", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
  ],
  outputs: [o("backupName", "Backup Name"), o("backupId", "Backup ID")],
  parentTypeId: "ps-branch",
  iconKey: "planetscale",
});
