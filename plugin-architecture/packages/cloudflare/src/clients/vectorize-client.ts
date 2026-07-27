import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type {
  IndexCreateParams,
  IndexDimensionConfigurationParam,
} from "cloudflare/resources/vectorize/indexes/indexes";

/**
 * Cloudflare Vectorize indexes (`/accounts/{id}/vectorize/v2/indexes`) — the
 * vector databases backing Workers AI / RAG. The index `name` doubles as the
 * external id (it's what Worker bindings and the query API reference).
 */

/** Distance metrics the API accepts (`IndexDimensionConfigurationParam.metric`). */
const VECTORIZE_METRICS = [
  "cosine",
  "euclidean",
  "dot-product",
] as const satisfies readonly IndexDimensionConfigurationParam["metric"][];
type VectorizeMetric = (typeof VECTORIZE_METRICS)[number];

/** The create form's default, used when no (or an unrecognised) metric is given. */
const DEFAULT_VECTORIZE_METRIC: VectorizeMetric = "cosine";

function isVectorizeMetric(value: string): value is VectorizeMetric {
  return (VECTORIZE_METRICS as readonly string[]).includes(value);
}
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
  const metric = fields["metric"] ?? "";
  const params: IndexCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    config: {
      dimensions,
      metric: isVectorizeMetric(metric) ? metric : DEFAULT_VECTORIZE_METRIC,
    },
    ...(fields["description"] ? { description: fields["description"] } : {}),
  };
  const idx = await api.cf.vectorize.indexes.create(params);
  return mapIndex(asRecord(idx ?? { name: fields["name"] }), accountId);
}

export async function deleteVectorizeIndex(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.vectorize.indexes.delete(externalId, { account_id });
}
