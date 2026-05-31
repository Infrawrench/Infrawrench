import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PublishMessagePayload } from "@infrawrench/plugin-base";

const jsonCall = vi.fn();
const queryPostCall = vi.fn();
vi.mock("../client-transport.js", () => ({
  jsonCall: (...a: unknown[]) => jsonCall(...a),
  queryPostCall: (...a: unknown[]) => queryPostCall(...a),
}));

import { publishSqs, publishSns, publishKinesis, publishEventBridge } from "../publish-handlers.js";

const creds = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };

function ctx(fields: Record<string, unknown>, externalId?: string) {
  return {
    credsFor: (region: string) => ({ ...creds, region }),
    defaultRegion: "us-east-1",
    resource: { fields, ...(externalId !== undefined ? { externalId } : {}), displayName: "d" },
  };
}

function payload(body: string, extras: Record<string, unknown> = {}): PublishMessagePayload {
  return { body, extras } as PublishMessagePayload;
}

beforeEach(() => {
  jsonCall.mockReset();
  queryPostCall.mockReset();
});

describe("publishSqs", () => {
  it("sends with delay, group id, and attributes", async () => {
    jsonCall.mockResolvedValue({ MessageId: "m1" });
    const out = await publishSqs(
      ctx({ queueUrl: "https://q", region: "us-west-2" }),
      payload("hi", {
        delaySeconds: "5",
        messageGroupId: "g",
        attributes: { foo: "bar", "": "skip" },
      }),
    );
    expect(out.id).toBe("m1");
    const body = jsonCall.mock.calls[0]![3] as Record<string, unknown>;
    expect(body["DelaySeconds"]).toBe(5);
    expect(body["MessageGroupId"]).toBe("g");
    expect((body["MessageAttributes"] as Record<string, unknown>)["foo"]).toEqual({
      DataType: "String",
      StringValue: "bar",
    });
  });
  it("throws when no queueUrl", async () => {
    await expect(publishSqs(ctx({}), payload("x"))).rejects.toThrow(/queueUrl/);
  });
  it("summary without MessageId", async () => {
    jsonCall.mockResolvedValue({});
    const out = await publishSqs(ctx({ queueUrl: "u" }), payload("x"));
    expect(out.summary).toBe("Sent.");
    expect(out.id).toBeUndefined();
  });
});

describe("publishSns", () => {
  it("publishes with subject + attributes", async () => {
    queryPostCall.mockResolvedValue({ PublishResult: { MessageId: "s1" } });
    const out = await publishSns(
      ctx({ topicArn: "arn:t" }),
      payload("hi", { subject: "S", attributes: { k: "v" } }),
    );
    expect(out.id).toBe("s1");
    const params = queryPostCall.mock.calls[0]![4] as Record<string, string>;
    expect(params["Subject"]).toBe("S");
    expect(params["MessageAttributes.entry.1.Name"]).toBe("k");
  });
  it("throws without topicArn", async () => {
    await expect(publishSns(ctx({}), payload("x"))).rejects.toThrow(/topicArn/);
  });
  it("summary without message id", async () => {
    queryPostCall.mockResolvedValue({});
    expect((await publishSns(ctx({ topicArn: "a" }), payload("x"))).summary).toBe("Published.");
  });
});

describe("publishKinesis", () => {
  it("base64-encodes and puts record", async () => {
    jsonCall.mockResolvedValue({ SequenceNumber: "42", ShardId: "shard-0" });
    const out = await publishKinesis(
      ctx({ streamName: "s" }),
      payload("data", { partitionKey: "pk" }),
    );
    expect(out.id).toBe("42");
    expect(out.summary).toContain("shard-0");
    const body = jsonCall.mock.calls[0]![3] as Record<string, string>;
    expect(body["Data"]).toBe(Buffer.from("data", "utf8").toString("base64"));
  });
  it("throws without stream name", async () => {
    await expect(publishKinesis(ctx({}), payload("x", { partitionKey: "p" }))).rejects.toThrow(
      /streamName/,
    );
  });
  it("throws without partition key", async () => {
    await expect(publishKinesis(ctx({ streamName: "s" }), payload("x"))).rejects.toThrow(
      /Partition key/,
    );
  });
  it("summary without sequence number", async () => {
    jsonCall.mockResolvedValue({});
    expect(
      (await publishKinesis(ctx({ streamName: "s" }), payload("x", { partitionKey: "p" }))).summary,
    ).toBe("Record put.");
  });
});

describe("publishEventBridge", () => {
  it("sends an event entry", async () => {
    jsonCall.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: "e1" }] });
    const out = await publishEventBridge(
      ctx({ eventBusName: "bus" }),
      payload("{}", { source: "src", detailType: "dt" }),
    );
    expect(out.id).toBe("e1");
  });
  it("uses default bus when none provided", async () => {
    jsonCall.mockResolvedValue({ FailedEntryCount: 0, Entries: [{}] });
    const out = await publishEventBridge(ctx({}), payload("{}", { source: "s", detailType: "d" }));
    expect(out.summary).toBe("Event sent.");
    const entry = (jsonCall.mock.calls[0]![3] as { Entries: Array<Record<string, string>> })
      .Entries[0]!;
    expect(entry["EventBusName"]).toBe("default");
  });
  it("throws when source/detailType missing", async () => {
    await expect(publishEventBridge(ctx({}), payload("{}", { detailType: "d" }))).rejects.toThrow(
      /source/,
    );
    await expect(publishEventBridge(ctx({}), payload("{}", { source: "s" }))).rejects.toThrow(
      /Detail type/,
    );
  });
  it("throws when EventBridge rejects the event", async () => {
    jsonCall.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "X", ErrorMessage: "bad" }],
    });
    await expect(
      publishEventBridge(ctx({}), payload("{}", { source: "s", detailType: "d" })),
    ).rejects.toThrow(/EventBridge rejected/);
  });
});
