import { ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

interface WorkersAiModel {
  id?: string;
  name?: string;
  description?: string;
  task?: { id?: string; name?: string } | null;
}

const MODELS_PER_PAGE = 100;
/** 10,000 models, far past Cloudflare's catalog. */
const MODELS_MAX_PAGES = 100;

/**
 * List Workers AI text-generation models for the account. The catalog is a
 * fixed Cloudflare-managed list (not per-account resources), so each entry is
 * mapped to a `workers-ai-model` instance keyed by the `@cf/...` model name.
 *
 * `GET /accounts/{id}/ai/models/search?task=Text Generation` returns
 * `{ result: [{ name, task: { name }, description }], result_info }`, a page at a time. A short
 * page is the last, so the usual catalog costs one request.
 */
async function fetchTextGenerationModels(api: CloudflareApi): Promise<WorkersAiModel[]> {
  const cfAccountId = await api.getAccountId();
  const path = `/accounts/${cfAccountId}/ai/models/search`;
  const out: WorkersAiModel[] = [];
  for (let page = 1; page <= MODELS_MAX_PAGES; page++) {
    const rows = requireListPage(
      await api.fetch<WorkersAiModel[] | null>(
        `${path}?per_page=${MODELS_PER_PAGE}&task=Text%20Generation&page=${page}`,
      ),
      { vendor: "Cloudflare", path, key: "result" },
    );
    out.push(...rows);
    if (rows.length < MODELS_PER_PAGE) return out;
  }
  throw new ListTruncatedError({
    vendor: "Cloudflare",
    path,
    items: out.length,
    maxPages: MODELS_MAX_PAGES,
  });
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
