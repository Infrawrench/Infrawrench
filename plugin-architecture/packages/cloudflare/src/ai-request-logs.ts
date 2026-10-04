/**
 * Cloudflare AI Gateway request logs as an AI request-log source.
 *
 * `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs` returns
 * one row per proxied request with `provider`, `model`, `tokens_in`,
 * `tokens_out`, the gateway's own `cost` estimate, `cached`, `created_at` and
 * the caller's `cf-aig-metadata` header as a JSON string (`metadata`, at most
 * five entries). Verified against the API reference and the SDK's
 * `LogListParams`/`LogListResponse` on 2026-10-04:
 *
 * - https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/
 * - https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
 *
 * The listing pages at 50 rows, so a day is walked page by page and folded into
 * an `AiRequestAccumulator` as it arrives; nothing raw is kept. A gateway busier
 * than {@link MAX_PAGES_PER_DAY} pages a day is marked degraded rather than
 * silently short. Cached responses are skipped: a cache hit never reaches the
 * provider, so it is on nobody's bill.
 */
import {
  AiRequestAccumulator,
  AiRequestLogSetupError,
  type AiRequestLogFetchRange,
  type AiRequestLogFetchResult,
  type AiRequestLogLocation,
  type AiRequestLogsCapabilityDeclaration,
  type AiRequestRecord,
} from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./clients/shared.js";

export const cloudflareAiRequestLogCapability: AiRequestLogsCapabilityDeclaration = {
  sourceKinds: [
    {
      id: "ai-gateway",
      label: "AI Gateway request logs",
      description:
        "Reads a gateway's request log and splits the spend of the providers behind it (OpenAI, Anthropic, Bedrock…) by the cf-aig-metadata your callers send.",
      locationLabel: "Gateway",
      maxHistoryDays: 30,
      helpUrl: "https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/",
    },
  ],
};

/** 50 rows a page: 200,000 requests a day before the day is marked degraded. */
const MAX_PAGES_PER_DAY = 4000;
const PER_PAGE = 50;

/** One log row as the API returns it; only the fields read here. */
export interface GatewayLogRow {
  created_at?: string;
  provider?: string;
  model?: string;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost?: number;
  cached?: boolean;
  metadata?: string | Record<string, unknown> | null;
}

/** One gateway log row in the shared shape, or null for a cache hit. */
export function parseGatewayLogRow(row: GatewayLogRow): AiRequestRecord | null {
  if (row.cached) return null;
  let metadata: Record<string, unknown> | undefined;
  if (typeof row.metadata === "string" && row.metadata.trim()) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable metadata is no metadata, not a skipped request.
    }
  } else if (row.metadata && typeof row.metadata === "object") {
    metadata = row.metadata;
  }
  return {
    ...(row.created_at ? { timestamp: row.created_at } : {}),
    provider: row.provider ?? "",
    model: row.model ?? "",
    inputTokens: row.tokens_in ?? undefined,
    outputTokens: row.tokens_out ?? undefined,
    ...(typeof row.cost === "number" ? { reportedCost: row.cost, reportedCurrency: "USD" } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export async function listCloudflareAiRequestLogLocations(
  api: CloudflareApi,
): Promise<AiRequestLogLocation[]> {
  const account_id = await api.getAccountId();
  const out: AiRequestLogLocation[] = [];
  for await (const gw of api.cf.aiGateway.list({ account_id })) {
    const g = gw as unknown as { id?: string; collect_logs?: boolean };
    if (!g.id) continue;
    out.push({
      id: g.id,
      label: g.id,
      detail: g.collect_logs ? "Log collection on" : "Log collection is off for this gateway",
      location: { gatewayId: g.id },
      recommended: g.collect_logs === true,
    });
  }
  return out;
}

export async function fetchCloudflareAiRequestLogs(
  api: CloudflareApi,
  range: AiRequestLogFetchRange,
): Promise<AiRequestLogFetchResult> {
  const gatewayId = range.location["gatewayId"];
  if (!gatewayId) throw new AiRequestLogSetupError("No gateway selected for this source.");
  const account_id = await api.getAccountId();
  const acc = new AiRequestAccumulator(range.day, range.metadataKeys);
  const start = `${range.day}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();

  let pages = 0;
  let degraded = false;
  try {
    const iterator = api.cf.aiGateway.logs.list(gatewayId, {
      account_id,
      per_page: PER_PAGE,
      order_by: "created_at",
      order_by_direction: "asc",
      filters: [
        { key: "created_at", operator: "gt", value: [start] },
        { key: "created_at", operator: "lt", value: [end] },
      ],
    });
    let seen = 0;
    for await (const row of iterator) {
      if (range.signal?.aborted) {
        throw new Error(`Host withdrew authorization while reading ${gatewayId} for ${range.day}`);
      }
      const rec = parseGatewayLogRow(row as unknown as GatewayLogRow);
      if (rec) acc.add(rec);
      seen++;
      if (seen % PER_PAGE === 0 && ++pages >= MAX_PAGES_PER_DAY) {
        degraded = true;
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b(401|403)\b|Authentication|permission/i.test(message)) {
      throw new AiRequestLogSetupError(
        "This API token cannot read AI Gateway logs: add the Account · AI Gateway:Read permission.",
        "https://developers.cloudflare.com/ai-gateway/observability/logging/",
      );
    }
    throw err;
  }
  return acc.result(degraded ? { degraded: true } : {});
}
