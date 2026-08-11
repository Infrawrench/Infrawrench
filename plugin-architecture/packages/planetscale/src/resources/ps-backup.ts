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
  // A branch's external id is `{database}/{branch}` while `branchName` is bare —
  // the template composes the qualified id the branch actually answers to.
  dependsOn: [
    { fieldKey: "databaseName", targetTypeId: "ps-database", label: "in database" },
    {
      fieldKey: "branchName",
      targetTypeId: "ps-branch",
      matchTemplate: "{databaseName}/{branchName}",
      label: "backs up",
    },
  ],
  expiryFields: [{ fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Backup expires" }],
  // The same composition the `dependsOn` above needs, for the same reason:
  // a bare `branchName` of "main" exists in every database in the org.
  backupRole: {
    role: "snapshot",
    sourceTemplate: "{databaseName}/{branchName}",
    createdKey: "createdAt",
    sizeKey: "size",
    sizeUnit: "bytes",
  },
  parentTypeId: "ps-branch",
  iconKey: "planetscale",
});
