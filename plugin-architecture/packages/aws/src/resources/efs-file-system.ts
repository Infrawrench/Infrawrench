import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EFSFileSystemResourceType: ResourceTypeDefinition = {
  id: "efs-file-system",
  displayName: "EFS File System",
  pluralDisplayName: "EFS File Systems",
  description: "An Amazon Elastic File System",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "fileSystemId", label: "File System ID", kind: "string", required: true },
    {
      key: "lifeCycleState",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["creating", "available", "updating", "deleting", "deleted", "error"],
    },
    {
      key: "performanceMode",
      label: "Performance Mode",
      kind: "enum",
      required: false,
      enumValues: ["generalPurpose", "maxIO"],
    },
    {
      key: "throughputMode",
      label: "Throughput Mode",
      kind: "enum",
      required: false,
      enumValues: ["bursting", "provisioned", "elastic"],
    },
    { key: "sizeInBytes", label: "Size", kind: "number", required: false },
    { key: "encrypted", label: "Encrypted", kind: "boolean", required: false },
    { key: "numberOfMountTargets", label: "Mount Targets", kind: "number", required: false },
  ],
  outputs: [
    { key: "fileSystemArn", label: "File System ARN", sensitive: false },
    { key: "fileSystemId", label: "File System ID", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "storage",
};
