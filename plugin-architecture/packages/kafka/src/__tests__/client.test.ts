import type { HostServices, KvHostServices, PublishMessagePayload } from "@infrawrench/plugin-base";
import { describe, expect, it, vi } from "vitest";
import { KafkaClient } from "../client.js";

function servicesFor(command: KvHostServices["command"]): HostServices {
  return {
    kv: { command },
  } as HostServices;
}

describe("KafkaClient", () => {
  it("enriches listed topics with partition and replication metadata", async () => {
    const command = vi.fn(async (cmd: string, ...args: (string | number)[]) => {
      if (cmd === "listTopics") return ["__consumer_offsets", "events"];
      if (cmd === "describeTopic" && args[0] === "events") {
        return {
          name: "events",
          partitions: [
            { partitionId: 0, replicas: [1, 2, 3] },
            { partitionId: 1, replicas: [1, 2, 3] },
          ],
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const client = new KafkaClient(
      { connectionString: "kafka://broker1:9092" },
      servicesFor(command),
    );

    const topics = await client.listResources("kafka-topic", "acct");

    expect(topics).toHaveLength(1);
    expect(topics[0]!.fields).toMatchObject({
      name: "events",
      partitions: 2,
      replicationFactor: 3,
    });
  });

  it("still lists topic names when metadata describe is not permitted", async () => {
    const command = vi.fn(async (cmd: string) => {
      if (cmd === "listTopics") return ["events"];
      if (cmd === "describeTopic") throw new Error("not authorized");
      throw new Error(`unexpected ${cmd}`);
    });

    const client = new KafkaClient(
      { connectionString: "kafka://broker1:9092" },
      servicesFor(command),
    );

    const topics = await client.listResources("kafka-topic", "acct");

    expect(topics[0]!.fields).toEqual({ name: "events" });
  });

  it("forwards optional produce partition to the KV driver", async () => {
    const command = vi.fn(async () => ({ partition: 2, offset: "42" }));
    const client = new KafkaClient(
      { connectionString: "kafka://broker1:9092" },
      servicesFor(command),
    );
    const payload: PublishMessagePayload = {
      body: "hello",
      extras: { key: "k1", headers: { trace: "abc" }, partition: "2" },
    };

    const result = await client.publishMessage(
      "kafka-topic",
      "acct:kafka-topic:events",
      "acct",
      payload,
    );

    expect(command).toHaveBeenCalledWith(
      "produce",
      "events",
      "hello",
      "k1",
      JSON.stringify({ trace: "abc" }),
      "2",
    );
    expect(result.summary).toContain("partition 2 offset 42");
  });
});
