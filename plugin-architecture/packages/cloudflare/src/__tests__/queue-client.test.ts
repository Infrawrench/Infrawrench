import { describe, it, expect, vi } from "vitest";
import {
  listQueues,
  getQueue,
  createQueue,
  deleteQueue,
  listConsumers,
  publishMessage,
} from "../clients/queue-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const QUEUE = {
  queue_id: "q1",
  queue_name: "jobs",
  producers_total_count: 2,
  consumers_total_count: 1,
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
  settings: { delivery_delay: 5, delivery_paused: true, message_retention_period: 345600 },
};

function queueApi(over: Record<string, unknown> = {}) {
  const queues = {
    list: vi.fn(() => asyncIter([QUEUE])),
    get: vi.fn(async () => QUEUE),
    create: vi.fn(async () => QUEUE),
    delete: vi.fn(async () => undefined),
    consumers: { list: vi.fn(() => asyncIter([])) },
    messages: { push: vi.fn(async () => ({})) },
  };
  return makeApi({ cf: { queues }, ...over });
}

describe("queue-client", () => {
  it("listQueues maps a queue", async () => {
    const api = queueApi();
    const out = await listQueues(api, "acct");
    expect(out[0].id).toBe("acct:queue:q1");
    expect(out[0].externalId).toBe("q1");
    expect(out[0].displayName).toBe("jobs");
    expect(out[0].fields.producersTotal).toBe(2);
    expect(out[0].fields.deliveryPaused).toBe(true);
    expect(out[0].resolvedOutputs?.queueId).toBe("q1");
  });

  it("getQueue fetches by id", async () => {
    const api = queueApi();
    const out = await getQueue(api, "acct", "q1");
    expect(api.cf.queues.get).toHaveBeenCalledWith("q1", { account_id: "acct-cf" });
    expect(out.externalId).toBe("q1");
  });

  it("createQueue sends queue_name", async () => {
    const api = queueApi();
    await createQueue(api, "acct", { queue_name: "jobs" });
    expect(api.cf.queues.create).toHaveBeenCalledWith({
      account_id: "acct-cf",
      queue_name: "jobs",
    });
  });

  it("deleteQueue calls delete", async () => {
    const api = queueApi();
    await deleteQueue(api, "q1");
    expect(api.cf.queues.delete).toHaveBeenCalledWith("q1", { account_id: "acct-cf" });
  });

  it("listConsumers maps consumer settings", async () => {
    const consumer = {
      consumer_id: "c1",
      type: "worker",
      script_name: "worker-a",
      dead_letter_queue: "dlq",
      created_on: "2020-01-01",
      settings: {
        batch_size: 10,
        max_concurrency: null,
        max_retries: 3,
        max_wait_time_ms: 500,
        retry_delay: 2,
        visibility_timeout_ms: 1000,
      },
    };
    const api = queueApi({
      cf: { queues: { consumers: { list: vi.fn(() => asyncIter([consumer])) } } },
    });
    const out = await listConsumers(api, "q1");
    expect(out[0]).toMatchObject({
      consumerId: "c1",
      scriptName: "worker-a",
      deadLetterQueue: "dlq",
      batchSize: 10,
      maxConcurrency: null,
      maxRetries: 3,
      visibilityTimeoutMs: 1000,
    });
    expect(api.cf.queues.consumers.list).toHaveBeenCalledWith("q1", { account_id: "acct-cf" });
  });

  it("listConsumers handles a minimal consumer", async () => {
    const api = queueApi({
      cf: { queues: { consumers: { list: vi.fn(() => asyncIter([{ consumer_id: "c2" }])) } } },
    });
    const out = await listConsumers(api, "q1");
    expect(out[0]).toEqual({ consumerId: "c2", type: "worker" });
  });

  it("publishMessage pushes parsed JSON with a delay", async () => {
    const api = queueApi();
    const res = await publishMessage(api, "q1", {
      body: '{"a":1}',
      extras: { format: "json", delaySeconds: "30" },
    } as never);
    expect(api.cf.queues.messages.push).toHaveBeenCalledWith("q1", {
      account_id: "acct-cf",
      content_type: "json",
      body: { a: 1 },
      delay_seconds: 30,
    });
    expect(res.summary).toMatch(/pushed/i);
  });

  it("publishMessage throws on invalid JSON body", async () => {
    const api = queueApi();
    await expect(
      publishMessage(api, "q1", { body: "{bad", extras: { format: "json" } } as never),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("publishMessage pushes raw text without a delay", async () => {
    const api = queueApi();
    await publishMessage(api, "q1", { body: "hello", extras: { format: "text" } } as never);
    expect(api.cf.queues.messages.push).toHaveBeenCalledWith("q1", {
      account_id: "acct-cf",
      content_type: "text",
      body: "hello",
    });
  });
});
