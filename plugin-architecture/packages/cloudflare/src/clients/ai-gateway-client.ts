import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";
import type {
  AIGatewayCreateParams,
  AIGatewayUpdateParams,
} from "cloudflare/resources/ai-gateway/ai-gateway";

/**
 * Cloudflare AI Gateway (`/accounts/{id}/ai-gateway/gateways`) — the proxy that
 * sits in front of model providers (Workers AI, OpenAI, Anthropic, …) and adds
 * caching, rate limiting, logging and analytics. The gateway `id` is the
 * external id: it's the slug you put in the gateway URL
 * (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway-id}/...`).
 */
function mapGateway(gw: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(gw["id"] ?? "");
  const bool = (v: unknown) => (v ? "true" : "false");
  const numOrEmpty = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    id: `${accountId}:ai-gateway:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "ai-gateway",
    accountId,
    displayName: id,
    fields: {
      id,
      cacheTtl: numOrEmpty(gw["cache_ttl"]),
      cacheInvalidateOnUpdate: bool(gw["cache_invalidate_on_update"]),
      collectLogs: bool(gw["collect_logs"]),
      rateLimitingLimit: numOrEmpty(gw["rate_limiting_limit"]),
      rateLimitingInterval: numOrEmpty(gw["rate_limiting_interval"]),
      rateLimitingTechnique: String(gw["rate_limiting_technique"] ?? ""),
      authentication: bool(gw["authentication"]),
      logpush: bool(gw["logpush"]),
    },
    resolvedOutputs: { gatewayId: id },
    secretStates: [],
    externalId: id,
    createdAt: String(gw["created_at"] ?? new Date().toISOString()),
    updatedAt: String(gw["modified_at"] ?? new Date().toISOString()),
  };
}

export async function listAiGateways(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const gw of api.cf.aiGateway.list({ account_id })) {
        results.push(mapGateway(asRecord(gw), accountId));
      }
      return results;
    },
    "AI Gateways",
    "Account · AI Gateway:Read",
  );
}

export async function getAiGateway(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const gw = await api.cf.aiGateway.get(externalId, { account_id });
  return mapGateway(asRecord(gw), accountId);
}

/**
 * Coerce a string field that may be blank into `number | null`. AI Gateway
 * treats a missing cache TTL / rate-limit window as "no limit", which the API
 * models as an explicit `null` rather than an omitted key.
 */
function nullableNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function createAiGateway(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const technique = fields["rateLimitingTechnique"];
  const params: AIGatewayCreateParams = {
    account_id,
    id: fields["id"] ?? "",
    cache_invalidate_on_update: fields["cacheInvalidateOnUpdate"] === "true",
    cache_ttl: nullableNumber(fields["cacheTtl"]),
    collect_logs: fields["collectLogs"] !== "false",
    rate_limiting_interval: nullableNumber(fields["rateLimitingInterval"]),
    rate_limiting_limit: nullableNumber(fields["rateLimitingLimit"]),
    authentication: fields["authentication"] === "true",
    logpush: fields["logpush"] === "true",
    ...(technique ? { rate_limiting_technique: technique as "fixed" | "sliding" } : {}),
  };
  const gw = await api.cf.aiGateway.create(params);
  return mapGateway(asRecord(gw ?? { id: fields["id"] }), accountId);
}

export async function editAiGateway(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  merged: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const technique = merged["rateLimitingTechnique"];
  const params: AIGatewayUpdateParams = {
    account_id,
    cache_invalidate_on_update: merged["cacheInvalidateOnUpdate"] === "true",
    cache_ttl: nullableNumber(merged["cacheTtl"]),
    collect_logs: merged["collectLogs"] !== "false",
    rate_limiting_interval: nullableNumber(merged["rateLimitingInterval"]),
    rate_limiting_limit: nullableNumber(merged["rateLimitingLimit"]),
    authentication: merged["authentication"] === "true",
    logpush: merged["logpush"] === "true",
    ...(technique ? { rate_limiting_technique: technique as "fixed" | "sliding" } : {}),
  };
  const gw = await api.cf.aiGateway.update(externalId, params);
  return mapGateway(asRecord(gw ?? { id: externalId }), accountId);
}

export async function deleteAiGateway(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.aiGateway.delete(externalId, { account_id });
}
