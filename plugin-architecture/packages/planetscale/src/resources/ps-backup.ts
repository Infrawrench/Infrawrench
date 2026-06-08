import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PsBackupResourceType: ResourceTypeDefinition = {
  id: "ps-backup",
  displayName: "Backup",
  pluralDisplayName: "Backups",
  description: "A PlanetScale branch backup",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "databaseName", label: "Database", kind: "string", required: true },
    { key: "branchName", label: "Branch", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "size", label: "Size", kind: "number", required: false },
    { key: "protected", label: "Protected", kind: "boolean", required: false },
    { key: "required", label: "Required", kind: "boolean", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "startedAt", label: "Started At", kind: "string", required: false },
    { key: "completedAt", label: "Completed At", kind: "string", required: false },
    { key: "expiresAt", label: "Expires At", kind: "string", required: false },
  ],
  outputs: [
    { key: "backupName", label: "Backup Name", sensitive: false },
    { key: "backupId", label: "Backup ID", sensitive: false },
  ],
  parentTypeId: "ps-branch",
  dashboardPinnable: true,
  iconKey: "planetscale",
};
