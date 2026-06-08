import { f, o, rt } from "@infrawrench/plugin-base";

export const EBSVolumeResourceType = rt({
  name: "EBS Volume",
  id: "ebs-volume",
  description: "An Amazon Elastic Block Store volume",
  fields: [
    f("volumeId", "Volume ID"),
    f("availabilityZone", "Availability Zone"),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("volumeType", "Volume Type", {
      kind: "enum",
      enumValues: ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"],
    }),
    f("state", "State"),
    f("encrypted", "Encrypted", { kind: "boolean", required: false }),
    f("attachedTo", "Attached To", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      matchField: "availabilityZone",
      verb: "Attach",
    },
  ],
});
