import { f, o, rt } from "@infrawrench/plugin-base";

export const KafkaConsumerGroupResourceType = rt({
  name: "Consumer Group",
  pinnable: false,
  id: "kafka-consumer-group",
  description: "A Kafka consumer group",
  parentTypeId: "kafka-cluster",
  showInSidebar: true,
  fields: [
    f("groupId", "Group ID"),
    f("state", "State", { showcase: true, required: false }),
    f("protocol", "Protocol", { showcase: true, required: false }),
    f("members", "Members", { showcase: true, kind: "number", required: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  supportsDelete: true,
  iconKey: "group",
});
