import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KinesisStreamResourceType: ResourceTypeDefinition = {
  id: "kinesis-stream",
  displayName: "Kinesis Stream",
  pluralDisplayName: "Kinesis Streams",
  description: "An Amazon Kinesis data stream",
  fields: [
    { key: "streamName", label: "Stream Name", kind: "string", required: true },
    { key: "status", label: "Status", kind: "enum", required: true, enumValues: ["CREATING", "DELETING", "ACTIVE", "UPDATING"] },
    { key: "shardCount", label: "Open Shards", kind: "number", required: false },
    { key: "retentionPeriodHours", label: "Retention (hours)", kind: "number", required: false },
    { key: "streamModeDetails", label: "Stream Mode", kind: "string", required: false },
    { key: "encryptionType", label: "Encryption", kind: "string", required: false },
  ],
  outputs: [
    { key: "streamArn", label: "Stream ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "stream",
};
