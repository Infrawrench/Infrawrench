import { f, rt } from "@infrawrench/plugin-base";

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
  // "available" is EC2's word for "detached but still billed". Matching on
  // state (not attachedTo) avoids flagging volumes mid-create/mid-delete.
  orphanRule: {
    conditions: [{ fieldKey: "state", when: "equals", value: "available" }],
    reason: "EBS volume is detached (state: available) but still billed",
  },
  attachTargets: [
    {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      matchField: "availabilityZone",
      verb: "Attach",
    },
  ],
});
