/**
 * AI request attribution: the wire contract shared by the web API, the web and
 * desktop settings section, the CLI, the MCP tools and the Terraform provider.
 *
 * The feature splits billed AI spend by caller (team, user, feature, customer,
 * or any request-metadata key) by joining per-request logs to the bill. The
 * provider plugins tag their billed rows with `ai:provider` / `ai:model` /
 * `ai:token_type`; request-log sources supply per-day token aggregates; the
 * host scales each caller's list-price share so attributed totals equal the
 * billed amount, with an explicit `(unattributed)` remainder. Billed totals are
 * never changed.
 *
 * Caller dimensions surface in every cost report as tag keys named
 * `caller:<dimension>`, so grouping a graph, filtering a budget or writing an
 * allocation rule by caller uses the tag machinery that already exists.
 */

/** Tag keys the AI provider plugins stamp onto billed rows. */
export const AI_COST_TAG_KEYS = {
  provider: "ai:provider",
  model: "ai:model",
  tokenType: "ai:token_type",
} as const;

/** Prefix of the caller-dimension tag keys on the attributed view. */
export const AI_CALLER_TAG_PREFIX = "caller:";

/** The tag key a dimension appears under in cost reports. */
export function aiCallerTagKey(dimensionKey: string): string {
  return `${AI_CALLER_TAG_PREFIX}${dimensionKey}`;
}

/** True when a tag key names an AI caller dimension. */
export function isAiCallerTagKey(tagKey: string | undefined | null): boolean {
  return typeof tagKey === "string" && tagKey.startsWith(AI_CALLER_TAG_PREFIX);
}

/** Billed AI spend no request log explained. */
export const AI_UNATTRIBUTED_VALUE = "(unattributed)";
/** A matched request that did not carry any of the dimension's metadata keys. */
export const AI_NOT_SET_VALUE = "(not set)";

/** Dimension keys become tag keys and CLI arguments: kept to a safe slug. */
export const AI_DIMENSION_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** Each dimension multiplies stored combinations, so the count is capped. */
export const AI_MAX_DIMENSIONS = 6;
export const AI_MAX_METADATA_KEYS_PER_DIMENSION = 8;
export const AI_MAX_SOURCES = 25;
/** How far back a new source's first collection reaches, by default and at most. */
export const AI_DEFAULT_LOOKBACK_DAYS = 7;
export const AI_MAX_LOOKBACK_DAYS = 90;

/** Dimensions offered as one-click presets in the mapping editor. */
export const AI_SUGGESTED_DIMENSIONS: ReadonlyArray<{
  key: string;
  label: string;
  metadataKeys: string[];
}> = [
  { key: "team", label: "Team", metadataKeys: ["team", "team_id", "user_api_key_team_alias"] },
  { key: "user", label: "User", metadataKeys: ["user", "user_id", "end_user"] },
  { key: "feature", label: "Feature", metadataKeys: ["feature", "app", "application"] },
  { key: "customer", label: "Customer", metadataKeys: ["customer", "customer_id", "tenant"] },
];

/** Who reads a source: a provider plugin's account, or the host's LiteLLM adapter. */
export type AiRequestSourceKind = "plugin" | "litellm";

/** One kind of source a user can add, with the accounts that can supply it. */
export interface AiRequestSourceKindOption {
  kind: AiRequestSourceKind;
  /** Null for host-owned kinds (LiteLLM). */
  pluginId: string | null;
  pluginName: string | null;
  sourceKindId: string;
  label: string;
  description: string;
  locationLabel: string;
  maxHistoryDays: number;
  queriesBillable: boolean;
  acceptsPrefix: boolean;
  helpUrl: string | null;
  /** Connected accounts of `pluginId`; empty for host-owned kinds. */
  accounts: Array<{ id: string; name: string }>;
}

/** A location picker option, as the owning plugin discovered it. */
export interface AiRequestLogLocationOption {
  id: string;
  label: string;
  detail?: string;
  location: Record<string, string>;
  recommended?: boolean;
}

export interface AiRequestSource {
  id: string;
  name: string;
  kind: AiRequestSourceKind;
  pluginId: string | null;
  accountId: string | null;
  accountName: string | null;
  sourceKindId: string;
  /** Opaque to the host; what the location picker returned (plus `prefix`). */
  location: Record<string, string>;
  enabled: boolean;
  lookbackDays: number;
  /** LiteLLM only: the proxy's https origin. */
  baseUrl: string | null;
  /** LiteLLM only: whether a key is stored (never returned). */
  hasApiKey: boolean;
  /** Last UTC day fully collected. */
  collectedThrough: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastErrorHelpUrl: string | null;
  failureCount: number;
  /** Metadata keys seen on the last collection, with request counts (top 50). */
  observedMetadataKeys: Record<string, number>;
  lastQueryBytesScanned: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiRequestSourceInput {
  name: string;
  kind: AiRequestSourceKind;
  /** Required for `plugin`. */
  accountId?: string | null | undefined;
  sourceKindId: string;
  location: Record<string, string>;
  enabled: boolean;
  lookbackDays: number;
  /** `litellm` only. */
  baseUrl?: string | null | undefined;
  /** `litellm` only. Omit on update to keep the stored key. */
  apiKey?: string | undefined;
}

export interface AiAttributionDimension {
  id: string;
  key: string;
  label: string;
  /** Metadata keys, first present wins, across every source. */
  metadataKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AiAttributionDimensionInput {
  key: string;
  label: string;
  metadataKeys: string[];
}

/** Match-rate statistics for one source over a range. */
export interface AiSourceMatchStats {
  sourceId: string;
  name: string;
  days: number;
  requests: number;
  /** Requests whose provider and model matched a billed line. */
  matchedRequests: number;
  /** Requests whose model matched more than one billed model, split by billed amount. */
  ambiguousRequests: number;
  /** Requests with no billed line to land on (provider not connected, model not on the bill). */
  unmatchedRequests: number;
  skippedRecords: number;
  currency: string | null;
  /** Billed money this source's requests explain. */
  attributedAmount: number;
  /** Billed money of the provider lines this source's requests touched. */
  billedAmount: number;
  /** attributed / billed, 0–100, or null with no billed money. */
  coveragePercent: number | null;
  degradedDays: number;
  truncatedDays: number;
}

/** Billed versus attributed money per provider over a range. */
export interface AiProviderCoverage {
  provider: string;
  currency: string;
  billedAmount: number;
  attributedAmount: number;
  unattributedAmount: number;
}

export interface AiAttributionStats {
  from: string;
  to: string;
  sources: AiSourceMatchStats[];
  providers: AiProviderCoverage[];
  /** Days in range with an attribution run. */
  attributedDays: number;
}

export interface AiSpendBreakdownRow {
  value: string;
  currency: string;
  amount: number;
}

export interface AiSpendBreakdown {
  from: string;
  to: string;
  dimension: string;
  tagKey: string;
  rows: AiSpendBreakdownRow[];
}

/** Coverage as a phrase every surface prints the same way. */
export function formatAiCoverage(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "n/a";
  return `${Math.round(percent * 10) / 10}%`;
}

/** Match rate (matched / requests) as a percentage, or null with no requests. */
export function aiMatchRate(
  stats: Pick<AiSourceMatchStats, "requests" | "matchedRequests">,
): number | null {
  if (stats.requests <= 0) return null;
  return (stats.matchedRequests / stats.requests) * 100;
}
