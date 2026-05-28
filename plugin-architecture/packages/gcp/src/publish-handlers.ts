import type { PublishMessagePayload, PublishMessageResult } from "@infrawrench/plugin-base";

interface PublishContext {
  token: () => Promise<string>;
  project: string;
}

function extra(payload: PublishMessagePayload, key: string): string {
  const v = payload.extras[key];
  return typeof v === "string" ? v : "";
}

function extraRecord(payload: PublishMessagePayload, key: string): Record<string, string> {
  const v = payload.extras[key];
  return v && typeof v === "object" ? (v as Record<string, string>) : {};
}

function b64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * Publish a single Pub/Sub message. `externalId` is the topic short name —
 * the same value used for the create handler. The body is base64-encoded
 * per the Pub/Sub REST contract.
 */
export async function publishPubsubTopic(
  ctx: PublishContext,
  externalId: string,
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const topicName = `projects/${ctx.project}/topics/${externalId}`;
  const orderingKey = extra(payload, "orderingKey");
  const attributes = extraRecord(payload, "attributes");
  const cleanAttributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (k.trim()) cleanAttributes[k] = v;
  }

  const body: Record<string, unknown> = {
    data: b64(payload.body),
  };
  if (Object.keys(cleanAttributes).length > 0) body["attributes"] = cleanAttributes;
  if (orderingKey.trim()) body["orderingKey"] = orderingKey;

  const tok = await ctx.token();
  const res = await fetch(`https://pubsub.googleapis.com/v1/${topicName}:publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [body] }),
  });
  if (!res.ok) {
    throw new Error(`Pub/Sub publish ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { messageIds?: string[] };
  const id = json.messageIds?.[0];
  return {
    ...(id ? { id } : {}),
    summary: id ? `Published — messageId ${id}` : "Published.",
  };
}

/**
 * Create a Cloud Tasks HTTP task on the given queue. The body is sent as the
 * task's HTTP request body (Cloud Tasks base64-encodes it on the wire).
 * The queue's full name is in `resource.externalId`; we use it directly so
 * we don't have to know the region/queue split.
 */
export async function publishCloudTasksQueue(
  ctx: PublishContext,
  resource: { externalId?: string; fields: Record<string, unknown> },
  payload: PublishMessagePayload,
): Promise<PublishMessageResult> {
  const url = extra(payload, "url");
  if (!url.trim()) throw new Error("Target URL is required.");
  const method = (extra(payload, "method") || "POST").toUpperCase();
  const headers = extraRecord(payload, "headers");

  const queueName =
    resource.externalId ??
    `projects/${ctx.project}/locations/${String(resource.fields["region"] ?? "")}/queues/${String(resource.fields["name"] ?? "")}`;

  const cleanHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.trim()) cleanHeaders[k] = v;
  }

  const httpRequest: Record<string, unknown> = {
    httpMethod: method,
    url,
  };
  if (Object.keys(cleanHeaders).length > 0) httpRequest["headers"] = cleanHeaders;
  // Cloud Tasks expects a base64-encoded body. Skip the field for GET/HEAD.
  if (method !== "GET" && method !== "HEAD" && payload.body.length > 0) {
    httpRequest["body"] = b64(payload.body);
  }

  const tok = await ctx.token();
  const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queueName}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ task: { httpRequest } }),
  });
  if (!res.ok) {
    throw new Error(`Cloud Tasks create ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { name?: string };
  const id = json.name ? json.name.split("/").pop() : undefined;
  return {
    ...(id ? { id } : {}),
    summary: id ? `Created — task ${id}` : "Task created.",
  };
}
