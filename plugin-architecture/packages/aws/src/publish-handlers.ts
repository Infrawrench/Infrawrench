import type { PublishMessagePayload, PublishMessageResult } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { jsonCall, queryPostCall } from "./client-transport.js";

interface PublishContext {
  credsFor: (region: string) => AwsCredentials;
  defaultRegion: string;
  resource: {
    fields: Record<string, unknown>;
    externalId?: string;
    displayName: string;
  };
}

function regionFor(ctx: PublishContext): string {
  const f = ctx.resource.fields["region"];
  if (typeof f === "string" && f) return f;
  return ctx.defaultRegion;
}

function extra(payload: PublishMessagePayload, key: string): string {
  const v = payload.extras[key];
  return typeof v === "string" ? v : "";
}

function extraRecord(payload: PublishMessagePayload, key: string): Record<string, string> {
  const v = payload.extras[key];
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}

export async function publishSqs(
  ctx: PublishContext,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const queueUrl = String(ctx.resource.fields["queueUrl"] ?? "");
  if (!queueUrl) throw new Error("Missing queueUrl on SQS resource.");
  const delayRaw = extra(payload, "delaySeconds");
  const messageGroupId = extra(payload, "messageGroupId");
  const attributes = extraRecord(payload, "attributes");

  const body: Record<string, unknown> = {
    QueueUrl: queueUrl,
    MessageBody: payload.body,
  };
  if (delayRaw.trim()) body["DelaySeconds"] = Number(delayRaw);
  if (messageGroupId.trim()) body["MessageGroupId"] = messageGroupId;
  if (Object.keys(attributes).length > 0) {
    const messageAttributes: Record<string, { DataType: string; StringValue: string }> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (!k.trim()) continue;
      messageAttributes[k] = { DataType: "String", StringValue: v };
    }
    body["MessageAttributes"] = messageAttributes;
  }

  const res = await jsonCall<{ MessageId?: string; SequenceNumber?: string }>(
    ctx.credsFor(regionFor(ctx)),
    "sqs",
    "AmazonSQS.SendMessage",
    body,
  );
  return {
    ...(res.MessageId ? { id: res.MessageId } : {}),
    summary: res.MessageId ? `Sent — MessageId ${res.MessageId}` : "Sent.",
  };
}

export async function publishSns(
  ctx: PublishContext,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const topicArn = String(ctx.resource.fields["topicArn"] ?? "");
  if (!topicArn) throw new Error("Missing topicArn on SNS resource.");
  const subject = extra(payload, "subject");
  const attributes = extraRecord(payload, "attributes");

  // SNS uses the query/EC2 protocol — flatten params into form-style keys.
  const params: Record<string, string> = {
    TopicArn: topicArn,
    Message: payload.body,
  };
  if (subject.trim()) params["Subject"] = subject;
  let i = 1;
  for (const [k, v] of Object.entries(attributes)) {
    if (!k.trim()) continue;
    params[`MessageAttributes.entry.${i}.Name`] = k;
    params[`MessageAttributes.entry.${i}.Value.DataType`] = "String";
    params[`MessageAttributes.entry.${i}.Value.StringValue`] = v;
    i += 1;
  }

  const res = await queryPostCall<Record<string, unknown>>(
    ctx.credsFor(regionFor(ctx)),
    "sns",
    "Publish",
    "2010-03-31",
    params,
  );
  const inner = res["PublishResult"] as Record<string, unknown> | undefined;
  const messageId = inner?.["MessageId"];
  return {
    ...(typeof messageId === "string" ? { id: messageId } : {}),
    summary: typeof messageId === "string" ? `Published — MessageId ${messageId}` : "Published.",
  };
}

export async function publishKinesis(
  ctx: PublishContext,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const streamName = String(ctx.resource.fields["streamName"] ?? ctx.resource.externalId ?? "");
  if (!streamName) throw new Error("Missing streamName on Kinesis resource.");
  const partitionKey = extra(payload, "partitionKey");
  if (!partitionKey.trim()) throw new Error("Partition key is required.");

  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(payload.body, "utf8").toString("base64")
      : btoa(unescape(encodeURIComponent(payload.body)));

  const res = await jsonCall<{ SequenceNumber?: string; ShardId?: string }>(
    ctx.credsFor(regionFor(ctx)),
    "kinesis",
    "Kinesis_20131202.PutRecord",
    {
      StreamName: streamName,
      Data: base64,
      PartitionKey: partitionKey,
    },
  );
  return {
    ...(res.SequenceNumber ? { id: res.SequenceNumber } : {}),
    summary: res.SequenceNumber
      ? `Put record — shard ${res.ShardId ?? "?"} seq ${res.SequenceNumber}`
      : "Record put.",
  };
}

export async function publishEventBridge(
  ctx: PublishContext,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const source = extra(payload, "source");
  const detailType = extra(payload, "detailType");
  const eventBusName =
    extra(payload, "eventBusName") ||
    String(ctx.resource.fields["eventBusName"] ?? "") ||
    "default";
  if (!source.trim()) throw new Error("Event source is required.");
  if (!detailType.trim()) throw new Error("Detail type is required.");

  const entry: Record<string, string> = {
    Source: source,
    DetailType: detailType,
    Detail: payload.body,
    EventBusName: eventBusName,
  };

  const res = await jsonCall<{
    FailedEntryCount?: number;
    Entries?: Array<{ EventId?: string; ErrorCode?: string; ErrorMessage?: string }>;
  }>(ctx.credsFor(regionFor(ctx)), "events", "AWSEvents.PutEvents", {
    Entries: [entry],
  });

  const failed = res.FailedEntryCount ?? 0;
  if (failed > 0) {
    const first = res.Entries?.[0];
    throw new Error(
      `EventBridge rejected the event: ${first?.ErrorCode ?? "unknown"} — ${first?.ErrorMessage ?? "no detail"}`,
    );
  }
  const id = res.Entries?.[0]?.EventId;
  return {
    ...(id ? { id } : {}),
    summary: id ? `Sent — EventId ${id}` : "Event sent.",
  };
}
