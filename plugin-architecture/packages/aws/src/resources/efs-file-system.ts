import { f, o, rt } from "@infrawrench/plugin-base";

export const EFSFileSystemResourceType = rt({
  name: "EFS File System",
  id: "efs-file-system",
  description: "An Amazon Elastic File System",
  fields: [
    f("name", "Name", { required: false }),
    f("fileSystemId", "File System ID"),
    f("lifeCycleState", "State", {
      kind: "enum",
      enumValues: ["creating", "available", "updating", "deleting", "deleted", "error"],
    }),
    f("performanceMode", "Performance Mode", {
      kind: "enum",
      required: false,
      enumValues: ["generalPurpose", "maxIO"],
    }),
    f("throughputMode", "Throughput Mode", {
      kind: "enum",
      required: false,
      enumValues: ["bursting", "provisioned", "elastic"],
    }),
    f("sizeInBytes", "Size", { kind: "number", required: false }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false }),
    f("numberOfMountTargets", "Mount Targets", { kind: "number", required: false }),
  ],
  outputs: [o("fileSystemArn", "File System ARN"), o("fileSystemId", "File System ID")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "storage",
  secretExportTemplates: [
    {
      id: "efs-mount",
      displayName: "EFS Mount",
      description: "File System ID for NFS mounting (use with mount.nfs4)",
      entries: [
        { envKey: "EFS_FILE_SYSTEM_ID", outputKey: "fileSystemId" },
        { envKey: "EFS_FILE_SYSTEM_ARN", outputKey: "fileSystemArn" },
      ],
    },
  ],
});
