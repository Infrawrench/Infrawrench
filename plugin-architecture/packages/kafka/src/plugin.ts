import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { KafkaClient } from "./client.js";
import { KafkaClusterResourceType } from "./resources/kafka-cluster.js";
import { KafkaTopicResourceType } from "./resources/kafka-topic.js";
import { KafkaConsumerGroupResourceType } from "./resources/kafka-consumer-group.js";

const manifest: PluginManifest = {
  id: "kafka",
  version: "0.1.0",
  displayName: "Kafka",
  // Apache Kafka mark (https://kafka.apache.org/logos)
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="12" fill="#231F20"/><path fill="#FFFFFF" d="M64.5 50.7c-2.5 0-4.7 1-6.4 2.5l-4.6-3.2c.4-1 .6-2 .6-3.1s-.2-2.1-.6-3.1l4.6-3.2c1.7 1.6 3.9 2.5 6.4 2.5 5.2 0 9.4-4.2 9.4-9.4S69.7 24.3 64.5 24.3s-9.4 4.2-9.4 9.4c0 1.1.2 2.1.5 3l-4.6 3.2c-1.6-1.6-3.7-2.7-6-3v-5.6c4.3-.9 7.6-4.7 7.6-9.3 0-5.2-4.2-9.4-9.4-9.4S33.2 16.8 33.2 22c0 4.6 3.3 8.4 7.6 9.3v5.7c-6 .9-10.6 6.1-10.6 12.4s4.6 11.5 10.6 12.4v5.7c-4.3.9-7.6 4.7-7.6 9.3 0 5.2 4.2 9.4 9.4 9.4s9.4-4.2 9.4-9.4c0-4.6-3.3-8.4-7.6-9.3v-5.7c2.4-.4 4.5-1.4 6-3l4.6 3.2c-.4.9-.5 2-.5 3 0 5.2 4.2 9.4 9.4 9.4s9.4-4.2 9.4-9.4-4.2-9.5-9.4-9.5zm0-21.6c2.5 0 4.5 2 4.5 4.5s-2 4.5-4.5 4.5-4.5-2-4.5-4.5 2-4.5 4.5-4.5zM37.6 22c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5-2 4.5-4.5 4.5-4.5-2-4.5-4.5zm9 56c0 2.5-2 4.5-4.5 4.5s-4.5-2-4.5-4.5 2-4.5 4.5-4.5 4.5 2 4.5 4.5zm-4.5-19.6c-3.9 0-7-3.2-7-7 0-3.9 3.2-7 7-7s7 3.2 7 7c0 3.9-3.1 7-7 7zm22.4 6.3c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5z"/></svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "connectionString",
      label: "Connection URL",
      description:
        "kafka:// URL — e.g. kafka://broker1:9092,broker2:9092?sasl=scram-sha-256&user=alice&password=…&ssl=true. See plugin docs.",
      sensitive: true,
      placeholder: "kafka://localhost:9092",
    },
  ],
  kvDriver: {
    driver: "kafka",
    credentialKey: "connectionString",
  },
};

const resourceTypes: ResourceTypeDefinition[] = [
  KafkaClusterResourceType,
  KafkaTopicResourceType,
  KafkaConsumerGroupResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new KafkaClient(credentials, services),
};
