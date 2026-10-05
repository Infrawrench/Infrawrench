/**
 * The LiteLLM proxy as a request-log source.
 *
 * LiteLLM is not a provider anyone holds an account with; it is a gateway the
 * org runs itself, in front of the providers whose bills it wants split. So it
 * is not a plugin (there is nothing to list, no bill of its own) but a small
 * host-owned adapter: an https base URL and an admin key, read once a day.
 *
 * `GET /spend/logs/v2?start_date=…&end_date=…&page=…&page_size=…` pages the
 * proxy's `LiteLLM_SpendLogs` table (page_size ≤ 1000) and returns
 * `{ data, total, page, page_size, total_pages }`. Each row carries `model`,
 * `custom_llm_provider`, `spend`, `prompt_tokens`, `completion_tokens`,
 * `startTime`, `status`, `team_id`, `user`, `end_user`, `request_tags` and a
 * `metadata` object (key alias, team alias, `spend_logs_metadata`,
 * `requester_metadata`). Verified against the proxy source
 * (`spend_tracking/spend_management_endpoints.py`, `ui_view_spend_logs`) and
 * https://docs.litellm.ai/docs/proxy/cost_tracking on 2026-10-04.
 *
 * The URL goes through the cost-exports egress guard: https only, no private
 * or reserved addresses, redirects not followed. A proxy reachable only on a
 * private network is out of reach by design.
 */
import {
  AiRequestAccumulator,
  AiRequestLogSetupError,
  type AiRequestLogFetchResult,
  type AiRequestRecord,
} from "@infrawrench/plugin-base";
import type { AiRequestSourceKindOption } from "@infrawrench/client-core";

import { destinationFetch } from "../cost-exports/egress";

export const LITELLM_SOURCE_KIND: Omit<AiRequestSourceKindOption, "accounts"> = {
  kind: "litellm",
  pluginId: null,
  pluginName: null,
  sourceKindId: "litellm-spend-logs",
  label: "LiteLLM proxy spend logs",
  description:
    "Reads /spend/logs/v2 from a LiteLLM proxy you run, with an admin key, and splits the spend of the providers behind it by team, user, key alias or any metadata your callers send.",
  locationLabel: "Proxy URL",
  maxHistoryDays: 90,
  queriesBillable: false,
  acceptsPrefix: false,
  helpUrl: "https://docs.litellm.ai/docs/proxy/cost_tracking",
};

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_DAY = 200;

interface SpendLogRow {
  startTime?: string;
  model?: string;
  model_group?: string;
  custom_llm_provider?: string;
  spend?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  status?: string;
  cache_hit?: string | boolean;
  team_id?: string;
  user?: string;
  end_user?: string;
  request_tags?: unknown;
  metadata?: Record<string, unknown> | string | null;
}

function scalarEntries(obj: unknown): Array<[string, unknown]> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
}

/** One spend-log row in the shared shape, or null for a failure or cache hit. */
export function parseLiteLlmSpendLog(row: SpendLogRow): AiRequestRecord | null {
  if (row.status && row.status !== "success") return null;
  if (row.cache_hit === true || row.cache_hit === "True" || row.cache_hit === "true") return null;
  let meta: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try {
      meta = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  } else if (row.metadata && typeof row.metadata === "object") {
    meta = row.metadata;
  }
  const metadata: Record<string, unknown> = {};
  // Flatten in increasing precedence: proxy-derived fields, then what the
  // caller sent, so a caller's own `team` wins over the key's team alias.
  for (const [k, v] of scalarEntries(meta)) metadata[k] = v;
  if (row.team_id) metadata["team_id"] = row.team_id;
  if (row.user) metadata["user"] = row.user;
  if (row.end_user) metadata["end_user"] = row.end_user;
  if (row.model_group) metadata["model_group"] = row.model_group;
  if (Array.isArray(row.request_tags)) {
    for (const tag of row.request_tags) {
      if (typeof tag === "string" && tag) metadata[`tag:${tag}`] = "true";
    }
  }
  for (const [k, v] of scalarEntries(meta["requester_metadata"])) metadata[k] = v;
  for (const [k, v] of scalarEntries(meta["spend_logs_metadata"])) metadata[k] = v;
  return {
    ...(row.startTime ? { timestamp: new Date(row.startTime).toISOString() } : {}),
    provider: row.custom_llm_provider ?? "",
    model: row.model ?? "",
    inputTokens: row.prompt_tokens,
    outputTokens: row.completion_tokens,
    ...(typeof row.spend === "number" ? { reportedCost: row.spend, reportedCurrency: "USD" } : {}),
    metadata,
  };
}

/** Read one UTC day of spend logs and aggregate it. */
export async function fetchLiteLlmDay(
  baseUrl: string,
  apiKey: string,
  day: string,
  metadataKeys: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = destinationFetch,
): Promise<AiRequestLogFetchResult> {
  const acc = new AiRequestAccumulator(day, metadataKeys);
  let degraded = false;
  for (let page = 1; ; page++) {
    if (signal?.aborted)
      throw new Error(`Authorization withdrawn while reading LiteLLM for ${day}`);
    if (page > MAX_PAGES_PER_DAY) {
      degraded = true;
      break;
    }
    const params = new URLSearchParams({
      start_date: `${day} 00:00:00`,
      end_date: `${day} 23:59:59`,
      page: String(page),
      page_size: String(PAGE_SIZE),
      sort_by: "startTime",
      sort_order: "asc",
    });
    const res = await fetchImpl(`${baseUrl}/spend/logs/v2?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AiRequestLogSetupError(
        "The LiteLLM proxy rejected the key: use an admin (master) key or one allowed to read spend logs.",
        "https://docs.litellm.ai/docs/proxy/cost_tracking",
      );
    }
    if (res.status === 404) {
      throw new AiRequestLogSetupError(
        "This LiteLLM proxy has no /spend/logs/v2 endpoint: upgrade the proxy, and check that spend logs are stored (a database is configured).",
        "https://docs.litellm.ai/docs/proxy/cost_tracking",
      );
    }
    if (!res.ok) throw new Error(`LiteLLM /spend/logs/v2 returned ${res.status}`);
    const body = (await res.json()) as { data?: SpendLogRow[]; total_pages?: number };
    for (const row of body.data ?? []) {
      const rec = parseLiteLlmSpendLog(row);
      if (rec) acc.add(rec);
    }
    const totalPages = Number(body.total_pages ?? 0);
    if (!body.data || body.data.length < PAGE_SIZE || page >= totalPages) break;
  }
  return acc.result(degraded ? { degraded: true } : {});
}
