import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapQueue(q: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(q["queue_id"] ?? q["id"] ?? "");
  const name = String(q["queue_name"] ?? q["name"] ?? "");
  const producers = q["producers"] as Array<unknown> | undefined;
  const consumers = q["consumers"] as Array<unknown> | undefined;
  return {
    id: `${accountId}:queue:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "queue",
    accountId,
    displayName: name || id,
    fields: {
      name,
      producersTotal: producers?.length ?? 0,
      consumersTotal: consumers?.length ?? 0,
      createdOn: String(q["created_on"] ?? ""),
      modifiedOn: String(q["modified_on"] ?? ""),
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
  const cfAccountId = await api.getAccountId();
  const queues = await api.paginate<Record<string, unknown>>(`/accounts/${cfAccountId}/queues`);
  return queues.map((q) => mapQueue(q, accountId));
}

export async function createQueue(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const q = await api.fetch<Record<string, unknown>>(`/accounts/${cfAccountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: fields["queue_name"] }),
  });
  return mapQueue(q, accountId);
}

export async function deleteQueue(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/queues/${externalId}`, { method: "DELETE" });
}
