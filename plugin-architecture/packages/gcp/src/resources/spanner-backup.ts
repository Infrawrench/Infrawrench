import { f, rt } from "@infrawrench/plugin-base";

export const SpannerBackupResourceType = rt({
  name: "Spanner Backup",
  plural: "Backups",
  id: "spanner-backup",
  description: "A backup of a Cloud Spanner database",
  fields: [
    f("name", "Backup ID"),
    f("instance", "Instance", { required: false }),
    f("database", "Source Database", { required: false }),
    f("state", "State", { required: false }),
    f("sizeBytes", "Size", { required: false }),
    f("createTime", "Created", { required: false }),
    f("expireTime", "Expires", { required: false }),
    f("versionTime", "Version time", { required: false }),
    f("backupSchedules", "Schedules", { required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "instance", targetTypeId: "spanner-instance", label: "in instance" },
    // Databases are keyed `instance/name`, so match the bare `name` field.
    {
      fieldKey: "database",
      targetTypeId: "spanner-database",
      targetKey: "name",
      label: "backs up",
    },
  ],
  expiryFields: [
    { fieldKey: "expireTime", from: "expiry", kind: "other", label: "Backup expires" },
  ],
  // Databases are keyed `instance/name`, which is exactly what the two fields
  // compose to — a bare `database` would match a same-named database in every
  // instance in the project and resolve to nothing.
  backupRole: {
    role: "snapshot",
    sourceTemplate: "{instance}/{database}",
    createdKey: "createTime",
    sizeKey: "sizeBytes",
    sizeUnit: "bytes",
  },
  parentTypeId: "spanner-instance",
  supportsCreate: true,
});
