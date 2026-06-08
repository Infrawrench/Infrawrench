import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- kafkajs mock ----
const adminMethods = {
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  describeCluster: vi.fn(async () => ({ clusterId: "c1", controller: 0, brokers: [] })),
  listTopics: vi.fn(async () => ["topic-a", "topic-b"]),
  fetchTopicMetadata: vi.fn(async () => ({ topics: [{ name: "topic-a", partitions: [] }] })),
  createTopics: vi.fn(async () => true),
  deleteTopics: vi.fn(async () => {}),
  listGroups: vi.fn(async () => ({ groups: [{ groupId: "g1", protocolType: "consumer" }] })),
  describeGroups: vi.fn(async () => ({ groups: [{ groupId: "g1", state: "Stable" }] })),
  fetchOffsets: vi.fn(async () => [{ topic: "topic-a", partition: 0, offset: "10" }]),
  deleteGroups: vi.fn(async () => {}),
};
const producerMethods = {
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  send: vi.fn(async () => [{ partition: 0, baseOffset: "42" }]),
};

const kafkaCtor = vi.fn();

vi.mock("kafkajs", () => {
  class Kafka {
    constructor(config: unknown) {
      kafkaCtor(config);
    }
    admin() {
      return adminMethods;
    }
    producer() {
      return producerMethods;
    }
  }
  return {
    Kafka,
    logLevel: { ERROR: 1 },
  };
});

import { driver, buildKafkaConfig } from "../driver.js";

const CONN = "kafka://alice:secret@broker1:9092?sasl=scram-sha-256&ssl=true";

beforeEach(() => {
  vi.clearAllMocks();
  // reset connect to a clean resolved state
  adminMethods.connect.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildKafkaConfig — additional branches", () => {
  it("defaults to PLAIN when credentials present without a mechanism", () => {
    const cfg = buildKafkaConfig("kafka://bob:pw@b1:9092");
    expect(cfg.sasl).toEqual({ mechanism: "plain", username: "bob", password: "pw" });
  });

  it("supports scram-sha-512 and the explicit plain mechanism", () => {
    expect(buildKafkaConfig("kafka://u:p@b:9092?sasl=scram-sha-512").sasl).toMatchObject({
      mechanism: "scram-sha-512",
    });
    expect(buildKafkaConfig("kafka://u:p@b:9092?sasl=plain").sasl).toMatchObject({
      mechanism: "plain",
    });
  });

  it("throws on an unsupported SASL mechanism (caught → raw broker fallback)", () => {
    // The unsupported-mechanism throw is swallowed by the outer try/catch, so
    // the raw connection string becomes the single broker.
    const cfg = buildKafkaConfig("kafka://b1:9092?sasl=kerberos");
    expect(cfg.brokers.length).toBeGreaterThan(0);
  });

  it("reads ssl from query 1/true and the kafkas scheme", () => {
    expect(buildKafkaConfig("kafka://b:9092?ssl=1").ssl).toBe(true);
    expect(buildKafkaConfig("kafkas://b:9092").ssl).toBe(true);
  });

  it("ignores a malformed ssl_ca and falls back to system trust", () => {
    const cfg = buildKafkaConfig("kafka://b:9092?ssl=true&ssl_ca=%%%notbase64");
    // atob throws on invalid input → caught → ssl stays true (from ssl=true)
    expect(cfg.ssl).toBe(true);
  });

  it("throws when there are no brokers", () => {
    expect(() => buildKafkaConfig("kafka://?brokers=")).toThrow(/no bootstrap brokers/);
  });
});

describe("driver.command — admin operations", () => {
  it("describeCluster / listTopics / describeTopic", async () => {
    expect(await driver.command(CONN, "describeCluster", [])).toMatchObject({ clusterId: "c1" });
    expect(await driver.command(CONN, "listTopics", [])).toEqual(["topic-a", "topic-b"]);
    expect(await driver.command(CONN, "describeTopic", ["topic-a"])).toMatchObject({
      name: "topic-a",
    });
  });

  it("describeTopic requires a name", async () => {
    await expect(driver.command(CONN, "describeTopic", [])).rejects.toThrow(
      /requires a topic name/,
    );
  });

  it("createTopic / deleteTopic", async () => {
    expect(await driver.command(CONN, "createTopic", ["t", 3, 2])).toEqual({ ok: true });
    expect(adminMethods.createTopics).toHaveBeenCalledWith({
      topics: [{ topic: "t", numPartitions: 3, replicationFactor: 2 }],
      waitForLeaders: true,
    });
    expect(await driver.command(CONN, "deleteTopic", ["t"])).toEqual({ ok: true });
  });

  it("createTopic / deleteTopic require a name", async () => {
    await expect(driver.command(CONN, "createTopic", [])).rejects.toThrow(/requires a name/);
    await expect(driver.command(CONN, "deleteTopic", [])).rejects.toThrow(/requires a name/);
  });

  it("listGroups / describeGroup / fetchOffsets / deleteGroup", async () => {
    expect(await driver.command(CONN, "listGroups", [])).toEqual([
      { groupId: "g1", protocolType: "consumer" },
    ]);
    expect(await driver.command(CONN, "describeGroup", ["g1"])).toMatchObject({ groupId: "g1" });
    expect(await driver.command(CONN, "fetchOffsets", ["g1"])).toEqual([
      { topic: "topic-a", partition: 0, offset: "10" },
    ]);
    expect(await driver.command(CONN, "deleteGroup", ["g1"])).toEqual({ ok: true });
  });

  it("group commands require a groupId", async () => {
    await expect(driver.command(CONN, "describeGroup", [])).rejects.toThrow(/requires a groupId/);
    await expect(driver.command(CONN, "fetchOffsets", [])).rejects.toThrow(/requires a groupId/);
    await expect(driver.command(CONN, "deleteGroup", [])).rejects.toThrow(/requires a groupId/);
  });

  it("throws for an unknown command", async () => {
    await expect(driver.command(CONN, "bogus", [])).rejects.toThrow(/unknown command "bogus"/);
  });

  it("reuses a pooled admin client across calls", async () => {
    kafkaCtor.mockClear();
    const c = "kafka://x:y@pool-host:9092?sasl=plain";
    await driver.command(c, "listTopics", []);
    await driver.command(c, "listTopics", []);
    // one Kafka() construction for the pooled admin
    expect(kafkaCtor).toHaveBeenCalledTimes(1);
  });
});

describe("driver.command — produce", () => {
  it("connects a producer, sends, and returns partition/offset", async () => {
    const out = (await driver.command(CONN, "produce", [
      "events",
      "hello",
      "k1",
      JSON.stringify({ h: "v" }),
    ])) as { partition?: number; offset?: string };
    expect(producerMethods.send).toHaveBeenCalled();
    expect(out).toEqual({ partition: 0, offset: "42" });
    expect(producerMethods.disconnect).toHaveBeenCalled();
  });

  it("tolerates malformed headers JSON", async () => {
    await driver.command(CONN, "produce", ["events", "v", "", "{not json"]);
    const sent = (producerMethods.send.mock.calls as unknown as unknown[][])[
      producerMethods.send.mock.calls.length - 1
    ]![0] as { messages: unknown[] };
    expect(sent.messages).toHaveLength(1);
  });

  it("passes an explicit partition to producer.send", async () => {
    await driver.command(CONN, "produce", ["events", "v", "", "", "2"]);
    const sent = (producerMethods.send.mock.calls as unknown as unknown[][])[
      producerMethods.send.mock.calls.length - 1
    ]![0] as { messages: Array<{ partition?: number }> };
    expect(sent.messages[0]!.partition).toBe(2);
  });

  it("rejects invalid explicit partitions", async () => {
    await expect(driver.command(CONN, "produce", ["events", "v", "", "", "-1"])).rejects.toThrow(
      /zero-based integer/,
    );
  });

  it("requires a topic", async () => {
    await expect(driver.command(CONN, "produce", [])).rejects.toThrow(/requires a topic name/);
  });

  it("wraps a producer error via describeFailure", async () => {
    producerMethods.send.mockRejectedValueOnce(new Error("SASL authentication failed"));
    await expect(driver.command(CONN, "produce", ["t", "v"])).rejects.toThrow(
      /authentication failed/i,
    );
  });
});

describe("driver.command — error translation + stale-connection retry", () => {
  it("retries once on a stale connection error then succeeds", async () => {
    const c = "kafka://u:p@stale-host:9092?sasl=plain";
    // First connected resolves, but the admin op throws a closed-connection
    // error; the retry path drops the pool and reconnects, second op succeeds.
    adminMethods.listTopics
      .mockRejectedValueOnce(
        Object.assign(new Error("Closed connection"), { name: "KafkaJSConnectionClosedError" }),
      )
      .mockResolvedValueOnce(["recovered"]);
    const out = await driver.command(c, "listTopics", []);
    expect(out).toEqual(["recovered"]);
  });

  it("maps ETIMEDOUT to a reachability hint", async () => {
    const c = "kafka://u:p@timeout-host:9092?sasl=plain";
    adminMethods.listTopics.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await expect(driver.command(c, "listTopics", [])).rejects.toThrow(/Cannot connect to Kafka/);
  });

  it("maps ENOTFOUND to a resolve hint", async () => {
    const c = "kafka://u:p@dns-host:9092?sasl=plain";
    adminMethods.listTopics.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    await expect(driver.command(c, "listTopics", [])).rejects.toThrow(/Cannot resolve Kafka host/);
  });

  it("propagates a connect() failure through describeFailure", async () => {
    const c = "kafka://u:p@connfail-host:9092?sasl=plain";
    adminMethods.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(driver.command(c, "listTopics", [])).rejects.toThrow(/Cannot connect to Kafka/);
  });
});
