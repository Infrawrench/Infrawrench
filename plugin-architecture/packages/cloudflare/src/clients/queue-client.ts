import type {
  ResourceInstance,
  PublishMessagePayload,
  PublishMessageResult,
} from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";

export interface QueueConsumer {
  consumerId: string;
  type: string;
  scriptName?: string;
  deadLetterQueue?: string;
  createdOn?: string;
  batchSize?: number;
  maxConcurrency?: number | null;
  maxRetries?: number;
  maxWaitTimeMs?: number;
  retryDelay?: number;
  visibilityTimeoutMs?: number;
}

function mapQueue(q: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(q["queue_id"] ?? q["id"] ?? "");
  const name = String(q["queue_name"] ?? q["name"] ?? "");
  const producers = q["producers"] as Array<unknown> | undefined;
  const consumers = q["consumers"] as Array<unknown> | undefined;
  const settings = (q["settings"] as Record<string, unknown> | undefined) ?? {};
  return {
    id: `${accountId}:queue:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "queue",
    accountId,
    displayName: name || id,
    fields: {
      name,
      producersTotal: (q["producers_total_count"] as number | undefined) ?? producers?.length ?? 0,
      consumersTotal: (q["consumers_total_count"] as number | undefined) ?? consumers?.length ?? 0,
      createdOn: String(q["created_on"] ?? ""),
      modifiedOn: String(q["modified_on"] ?? ""),
      deliveryDelay: (settings["delivery_delay"] as number | undefined) ?? 0,
      deliveryPaused: Boolean(settings["delivery_paused"]),
      messageRetentionPeriod: (settings["message_retention_period"] as number | undefined) ?? 0,
    },
    resolvedOutputs: { queueId: id, queueName: name },
    secretStates: [],
    externalId: id,
    createdAt: String(q["created_on"] ?? new Date().toISOString()),
    updatedAt: String(q["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listQueues(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const q of api.cf.queues.list({ account_id })) {
    results.push(mapQueue(asRecord(q), accountId));
  }
  return results;
}

/**
 * Refetch a single queue with full detail (producers, consumers, settings).
 * The list endpoint omits some fields, so the detail tab calls this to fill
 * out producer/consumer lists and queue settings.
 */
export async function getQueue(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const q = await api.cf.queues.get(externalId, { account_id });
  return mapQueue(asRecord(q), accountId);
}

export async function createQueue(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const q = await api.cf.queues.create({
    account_id,
    queue_name: fields["queue_name"] ?? "",
  });
  return mapQueue(asRecord(q), accountId);
}

export async function deleteQueue(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.queues.delete(externalId, { account_id });
}

export async function listConsumers(
  api: CloudflareApi,
  externalId: string,
): Promise<QueueConsumer[]> {
  const account_id = await api.getAccountId();
  const results: QueueConsumer[] = [];
  for await (const c of api.cf.queues.consumers.list(externalId, { account_id })) {
    const raw = asRecord(c);
    const settings = (raw["settings"] as Record<string, unknown> | undefined) ?? {};
    const entry: QueueConsumer = {
      consumerId: String(raw["consumer_id"] ?? ""),
      type: String(raw["type"] ?? "worker"),
    };
    if (typeof raw["script_name"] === "string") entry.scriptName = raw["script_name"] as string;
    if (typeof raw["dead_letter_queue"] === "string") {
      entry.deadLetterQueue = raw["dead_letter_queue"] as string;
    }
    if (typeof raw["created_on"] === "string") entry.createdOn = raw["created_on"] as string;
    if (typeof settings["batch_size"] === "number") {
      entry.batchSize = settings["batch_size"] as number;
    }
    if (typeof settings["max_concurrency"] === "number" || settings["max_concurrency"] === null) {
      entry.maxConcurrency = settings["max_concurrency"] as number | null;
    }
    if (typeof settings["max_retries"] === "number") {
      entry.maxRetries = settings["max_retries"] as number;
    }
    if (typeof settings["max_wait_time_ms"] === "number") {
      entry.maxWaitTimeMs = settings["max_wait_time_ms"] as number;
    }
    if (typeof settings["retry_delay"] === "number") {
      entry.retryDelay = settings["retry_delay"] as number;
    }
    if (typeof settings["visibility_timeout_ms"] === "number") {
      entry.visibilityTimeoutMs = settings["visibility_timeout_ms"] as number;
    }
    results.push(entry);
  }
  return results;
}

/**
 * Publish a single message to a queue. The PublishPanel sends `body` as raw
 * text (the user typed it). We parse it as JSON when the user picked the
 * JSON format and fall back to text otherwise — that way the user can
 * publish whatever shape consumers expect.
 */
export async function publishMessage(
  api: CloudflareApi,
  externalId: string,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const account_id = await api.getAccountId();
  const format = String(payload.extras["format"] ?? "json");
  const delayRaw = payload.extras["delaySeconds"];
  const delaySeconds =
    typeof delayRaw === "string" && delayRaw.trim() ? Number(delayRaw) : undefined;

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.body);
    } catch (e) {
      throw new Error(`Body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    await api.cf.queues.messages.push(externalId, {
      account_id,
      content_type: "json",
      body: parsed,
      ...(delaySeconds !== undefined && !Number.isNaN(delaySeconds)
        ? { delay_seconds: delaySeconds }
        : {}),
    });
  } else {
    await api.cf.queues.messages.push(externalId, {
      account_id,
      content_type: "text",
      body: payload.body,
      ...(delaySeconds !== undefined && !Number.isNaN(delaySeconds)
        ? { delay_seconds: delaySeconds }
        : {}),
    });
  }
  return { summary: "Message pushed to queue." };
}
