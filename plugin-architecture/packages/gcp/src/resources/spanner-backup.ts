import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SpannerBackupResourceType: ResourceTypeDefinition = {
  id: "spanner-backup",
  displayName: "Spanner Backup",
  pluralDisplayName: "Backups",
  description: "A backup of a Cloud Spanner database",
  fields: [
    { key: "name", label: "Backup ID", kind: "string", required: true },
    { key: "instance", label: "Instance", kind: "string", required: false },
    { key: "database", label: "Source Database", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "sizeBytes", label: "Size", kind: "string", required: false },
    { key: "createTime", label: "Created", kind: "string", required: false },
    { key: "expireTime", label: "Expires", kind: "string", required: false },
    { key: "versionTime", label: "Version time", kind: "string", required: false },
    { key: "backupSchedules", label: "Schedules", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "spanner-instance",
  dashboardPinnable: true,
  supportsCreate: true,
};
