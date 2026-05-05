import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EBSVolumeResourceType: ResourceTypeDefinition = {
  id: "ebs-volume",
  displayName: "EBS Volume",
  pluralDisplayName: "EBS Volumes",
  description: "An Amazon Elastic Block Store volume",
  fields: [
    { key: "volumeId", label: "Volume ID", kind: "string", required: true },
    { key: "availabilityZone", label: "Availability Zone", kind: "string", required: true },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: true },
    {
      key: "volumeType",
      label: "Volume Type",
      kind: "enum",
      required: true,
      enumValues: ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"],
    },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "encrypted", label: "Encrypted", kind: "boolean", required: false },
    { key: "attachedTo", label: "Attached To", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      matchField: "availabilityZone",
      verb: "Attach",
    },
  ],
};
