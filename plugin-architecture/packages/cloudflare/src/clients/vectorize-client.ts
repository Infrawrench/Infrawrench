import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type { IndexCreateParams } from "cloudflare/resources/vectorize/indexes/indexes";

/**
 * Cloudflare Vectorize indexes (`/accounts/{id}/vectorize/v2/indexes`) — the
 * vector databases backing Workers AI / RAG. The index `name` doubles as the
 * external id (it's what Worker bindings and the query API reference).
 */
function mapIndex(idx: Record<string, unknown>, accountId: string): ResourceInstance {
  const name = String(idx["name"] ?? "");
  const config = (idx["config"] as Record<string, unknown>) ?? {};
  return {
    id: `${accountId}:vectorize-index:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "vectorize-index",
    accountId,
    displayName: name,
    fields: {
      name,
      dimensions: Number(config["dimensions"] ?? 0),
      metric: String(config["metric"] ?? ""),
      description: String(idx["description"] ?? ""),
    },
    resolvedOutputs: { indexName: name },
    secretStates: [],
    externalId: name,
    createdAt: String(idx["created_on"] ?? new Date().toISOString()),
    updatedAt: String(idx["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listVectorizeIndexes(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const idx of api.cf.vectorize.indexes.list({ account_id })) {
        results.push(mapIndex(asRecord(idx), accountId));
      }
      return results;
    },
    "Vectorize indexes",
    "Account · Vectorize:Read",
  );
}

export async function createVectorizeIndex(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const dimensions = Number(fields["dimensions"] ?? 768);
  const params = {
    account_id,
    name: fields["name"] ?? "",
    config: { dimensions, metric: fields["metric"] || "cosine" },
    ...(fields["description"] ? { description: fields["description"] } : {}),
  } as unknown as IndexCreateParams;
  const idx = await api.cf.vectorize.indexes.create(params);
  return mapIndex(asRecord(idx ?? { name: fields["name"] }), accountId);
}

export async function deleteVectorizeIndex(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.vectorize.indexes.delete(externalId, { account_id });
}
