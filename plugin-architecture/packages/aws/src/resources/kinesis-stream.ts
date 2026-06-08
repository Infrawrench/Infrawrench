import { f, o, rt } from "@infrawrench/plugin-base";

export const KinesisStreamResourceType = rt({
  name: "Kinesis Stream",
  id: "kinesis-stream",
  description: "An Amazon Kinesis data stream",
  fields: [
    f("streamName", "Stream Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["CREATING", "DELETING", "ACTIVE", "UPDATING"],
    }),
    f("shardCount", "Open Shards", { kind: "number", required: false }),
    f("retentionPeriodHours", "Retention (hours)", { kind: "number", required: false }),
    f("streamModeDetails", "Stream Mode", { required: false }),
    f("encryptionType", "Encryption", { required: false }),
  ],
  outputs: [o("streamArn", "Stream ARN")],
  iconKey: "stream",
  supportsCreate: true,
  supportsMetrics: true,
});
