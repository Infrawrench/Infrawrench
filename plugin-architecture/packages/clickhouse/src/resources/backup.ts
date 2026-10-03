import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A ClickHouse Cloud service backup. Read-only: ClickHouse Cloud takes these
 * on the service's backup schedule (edited from the service's detail page),
 * and the API offers no manual backup or delete call. Restoring creates a new
 * service from the backup, which the console does.
 */
export const BackupResourceType = rt({
  name: "Backup",
  pinnable: false,
  id: "ch-backup",
  description: "An automated backup of a ClickHouse Cloud service",
  fields: [
    f("backupId", "Backup ID"),
    f("serviceId", "Service ID"),
    f("status", "Status", { kind: "enum", enumValues: ["done", "error", "in_progress"] }),
    f("type", "Type", { kind: "enum", enumValues: ["full", "incremental"], required: false }),
    f("startedAt", "Started", { required: false }),
    f("finishedAt", "Finished", { required: false }),
    f("sizeInBytes", "Size (bytes)", { kind: "number", required: false }),
    f("durationInSeconds", "Duration (s)", { kind: "number", required: false }),
    f("backupName", "Backup Name", {
      required: false,
      description: "Name on the external backup bucket, when the service writes to one.",
    }),
  ],
  outputs: [o("backupId", "Backup ID")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "ch-service", label: "backup of" }],
  backupRole: {
    role: "snapshot",
    sourceKey: "serviceId",
    createdKey: "startedAt",
    sizeKey: "sizeInBytes",
    sizeUnit: "bytes",
  },
  parentTypeId: "ch-service",
  supportsDelete: false,
  iconKey: "archive",
});
