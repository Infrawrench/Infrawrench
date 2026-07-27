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
  parentTypeId: "spanner-instance",
  supportsCreate: true,
});
