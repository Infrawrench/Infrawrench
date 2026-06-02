import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { withAuthErrorHint } from "./shared.js";

/**
 * Cloudflare AI Search — formerly AutoRAG — managed retrieval-augmented
 * generation pipelines (`/accounts/{id}/autorag/rags`, surfaced in the SDK as
 * `aiSearch.instances`). Each instance ties a data source (an R2 bucket or web
 * crawler) to an embedding model + index and exposes search / chat endpoints.
 *
 * Creation is a multi-step pipeline (pick a source, embedding model, chunking,
 * then trigger the first index sync) that Cloudflare models as a dashboard
 * wizard, so the plugin lists and deletes instances rather than offering a
 * create form — the source data has to exist and be indexed first.
 */
function mapInstance(inst: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(inst["id"] ?? "");
  return {
    id: `${accountId}:ai-search:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "ai-search",
    accountId,
    displayName: id,
    fields: {
      id,
      source: String(inst["type"] ?? ""),
      aiSearchModel: String(inst["ai_search_model"] ?? ""),
      embeddingModel: String(inst["embedding_model"] ?? ""),
      vectorizeName: String(inst["namespace"] ?? ""),
      status: String(inst["status"] ?? ""),
      paused: inst["paused"] ? "true" : "false",
      lastActivity: String(inst["last_activity"] ?? ""),
    },
    resolvedOutputs: { instanceId: id },
    secretStates: [],
    externalId: id,
    createdAt: String(inst["created_at"] ?? new Date().toISOString()),
    updatedAt: String(inst["modified_at"] ?? new Date().toISOString()),
  };
}

export async function listAiSearchInstances(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const inst of api.cf.aiSearch.instances.list({ account_id })) {
        results.push(mapInstance(inst as unknown as Record<string, unknown>, accountId));
      }
      return results;
    },
    "AI Search instances",
    "Account · AI Search:Read",
  );
}

export async function deleteAiSearchInstance(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.aiSearch.instances.delete(externalId, { account_id });
}
