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
    f("state", "State", { required: false }),
    f("protocol", "Protocol", { required: false }),
    f("members", "Members", { kind: "number", required: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  supportsDelete: true,
  iconKey: "kafka",
});
