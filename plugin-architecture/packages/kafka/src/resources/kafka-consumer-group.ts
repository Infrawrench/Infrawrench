import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KafkaConsumerGroupResourceType: ResourceTypeDefinition = {
  id: "kafka-consumer-group",
  displayName: "Consumer Group",
  pluralDisplayName: "Consumer Groups",
  description: "A Kafka consumer group",
  parentTypeId: "kafka-cluster",
  showInSidebar: true,
  fields: [
    { key: "groupId", label: "Group ID", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "protocol", label: "Protocol", kind: "string", required: false },
    { key: "members", label: "Members", kind: "number", required: false },
  ],
  outputs: [{ key: "groupId", label: "Group ID", sensitive: false }],
  dashboardPinnable: false,
  supportsDelete: true,
  iconKey: "kafka",
};
