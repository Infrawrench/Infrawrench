import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

interface WorkersAiModel {
  id?: string;
  name?: string;
  description?: string;
  task?: { id?: string; name?: string } | null;
}

/**
 * List Workers AI text-generation models for the account. The catalog is a
 * fixed Cloudflare-managed list (not per-account resources), so each entry is
 * mapped to a `workers-ai-model` instance keyed by the `@cf/...` model name.
 *
 * `GET /accounts/{id}/ai/models/search?task=Text Generation` returns
 * `{ result: [{ name, task: { name }, description }], result_info }`. One page
 * of 100 is plenty for the text-generation catalog.
 */
async function fetchTextGenerationModels(api: CloudflareApi): Promise<WorkersAiModel[]> {
  const cfAccountId = await api.getAccountId();
  const query = "?per_page=100&task=Text%20Generation";
  return (
    (await api.fetch<WorkersAiModel[]>(`/accounts/${cfAccountId}/ai/models/search${query}`)) ?? []
  );
}

/**
 * Just the `@cf/...` model names of the text-generation catalog. Used to seed
 * the AI Gateway playground's model picker (the gateway proxies Workers AI, so
 * any text-gen model is a valid target).
 */
export async function listTextGenerationModelNames(api: CloudflareApi): Promise<string[]> {
  const models = await fetchTextGenerationModels(api);
  return models.map((m) => String(m.name ?? m.id ?? "")).filter((n) => n.length > 0);
}

export async function listWorkersAiModels(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const models = await fetchTextGenerationModels(api);
  const now = new Date().toISOString();
  return (models ?? []).map((m) => {
    const name = String(m.name ?? m.id ?? "");
    return {
      id: `${accountId}:workers-ai-model:${name}`,
      pluginId: "cloudflare",
      resourceTypeId: "workers-ai-model",
      accountId,
      displayName: name,
      fields: {
        name,
        task: String(m.task?.name ?? "Text Generation"),
        description: String(m.description ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  });
}
