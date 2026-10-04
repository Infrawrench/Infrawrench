/**
 * The AI request contract: per-request logs (who called which model, with how
 * many tokens) and the normalized AI dimensions every AI-billing plugin stamps
 * onto its cost rows, so the host can join the two.
 *
 * Two halves, deliberately separate:
 *
 * - **Billed cost rows carry normalized AI tags.** A plugin that bills AI usage
 *   (OpenAI, Anthropic, Bedrock through AWS, Vertex through GCP, Azure OpenAI
 *   through Azure…) tags each `CostRow` with {@link AI_COST_TAG}: provider,
 *   and model and token type where its billing API says so. These are ordinary
 *   tags, so they work everywhere a tag works (cost reports, filters, budgets,
 *   allocation rules, showback) without any new dimension plumbing.
 * - **Request logs never become cost rows.** A plugin that can read request
 *   logs (Bedrock invocation logs, Cloudflare AI Gateway logs, a JSONL file in
 *   a bucket) returns them *already aggregated per day* through
 *   `fetchAiRequestLogs`. The host computes each caller's share of the billed
 *   amount from them and writes the split into its own table. Billed totals are
 *   never changed: the logs only decide who a dollar that was already billed
 *   belongs to.
 *
 * Raw request records never leave the plugin. They are folded into an
 * {@link AiRequestAccumulator} while streaming and only the per-day aggregate,
 * keyed by provider, model and the *mapped* metadata keys, is returned. That
 * bounds what the host stores to a few thousand rows per source per day no
 * matter how busy the gateway is.
 */

/** Token kinds every AI provider bills, in one vocabulary. */
export type AiTokenType = "input" | "output" | "cache_read" | "cache_write" | "reasoning";

export const AI_TOKEN_TYPES: readonly AiTokenType[] = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
];

/**
 * The reserved tag keys for the normalized AI dimensions on billed cost rows.
 *
 * Plain tags rather than dedicated columns, on purpose: `cost_daily`'s sort key
 * is frozen, tags already participate in its row identity, and every cost
 * surface already groups and filters by tag key.
 */
export const AI_COST_TAG = {
  provider: "ai:provider",
  model: "ai:model",
  tokenType: "ai:token_type",
} as const;

/**
 * Prefix of the caller dimensions the host derives from request metadata
 * (`caller:team`, `caller:feature`…). Never stamped by plugins: these exist
 * only on the host's attributed view of the bill.
 */
export const AI_CALLER_TAG_PREFIX = "caller:";

/** What a plugin knows about one billed row's AI usage. */
export interface AiCostClassification {
  /** A canonical provider id; see {@link normalizeAiProvider}. */
  provider: string;
  /** Provider model id as billed. Normalized by the host before matching. */
  model?: string | undefined;
  tokenType?: AiTokenType | undefined;
}

/** The tags for one classification, ready to merge into `CostRow.tags`. */
export function aiCostTags(c: AiCostClassification): Record<string, string> {
  const tags: Record<string, string> = { [AI_COST_TAG.provider]: normalizeAiProvider(c.provider) };
  const model = c.model?.trim();
  if (model) tags[AI_COST_TAG.model] = normalizeAiModel(model);
  if (c.tokenType) tags[AI_COST_TAG.tokenType] = c.tokenType;
  return tags;
}

/**
 * Stamp the AI tags onto every row `classify` recognizes, leaving the others
 * untouched. Returns new row objects; never mutates.
 *
 * Adding tags changes a row's identity hash, which is safe: the host's
 * re-collection reconciliation zeroes the old untagged keys on every day the
 * plugin re-wrote, so a day reads either fully old-style or fully tagged.
 */
export function withAiCostTags<R extends { tags?: Record<string, string> | undefined }>(
  rows: R[],
  classify: (row: R) => AiCostClassification | null,
): R[] {
  return rows.map((row) => {
    const c = classify(row);
    if (!c) return row;
    return { ...row, tags: { ...(row.tags ?? {}), ...aiCostTags(c) } };
  });
}

/**
 * Aliases different systems use for the same provider. Request logs name the
 * provider the way the *gateway* does (`aws-bedrock`, `vertex_ai`,
 * `google-vertex-ai`); the bill names it the way the plugin does. Both go
 * through here so they meet on one id.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai",
  "azure-openai": "azure-openai",
  azure: "azure-openai",
  azure_ai: "azure-openai",
  "azure-ai": "azure-openai",
  anthropic: "anthropic",
  bedrock: "bedrock",
  "aws-bedrock": "bedrock",
  bedrock_converse: "bedrock",
  vertex: "vertex",
  vertex_ai: "vertex",
  "vertex-ai": "vertex",
  "google-vertex-ai": "vertex",
  "vertex_ai-anthropic_models": "vertex",
  gemini: "gemini",
  "google-ai-studio": "gemini",
  google: "gemini",
  mistral: "mistral",
  groq: "groq",
  xai: "xai",
  grok: "xai",
  deepseek: "deepseek",
  fireworks: "fireworks",
  fireworks_ai: "fireworks",
  together: "together",
  together_ai: "together",
  "together-ai": "together",
  openrouter: "openrouter",
  cohere: "cohere",
  perplexity: "perplexity",
  "perplexity-ai": "perplexity",
  replicate: "replicate",
  "workers-ai": "workers-ai",
  cerebras: "cerebras",
};

/** Canonical provider id for any of the spellings gateways and bills use. */
export function normalizeAiProvider(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return PROVIDER_ALIASES[key] ?? key;
}

/**
 * A model id reduced to the part both a bill and a request log agree on.
 *
 * Bills and logs spell one model several ways: `anthropic.claude-3-5-sonnet-
 * 20240620-v1:0` (Bedrock), `us.anthropic.claude-3-5-sonnet…` (an inference
 * profile), `claude-3-5-sonnet-20240620` (the first-party API), `Claude 3.5
 * Sonnet (Amazon Bedrock Edition)` (an AWS Marketplace service name). This
 * strips routing prefixes, vendor prefixes, date stamps and version suffixes so
 * they all reduce to `claude-3-5-sonnet`.
 *
 * Lossy by design (two dated snapshots of one model collapse together), which
 * is why the host reports a request whose model matches more than one billed
 * model as *ambiguous* rather than guessing.
 */
export function normalizeAiModel(raw: string): string {
  let m = raw.trim().toLowerCase();
  m = m.replace(/\(amazon bedrock edition\)/g, "").replace(/\(.*?\)/g, "");
  // Strip a path-style prefix (`models/gemini-2.5-pro`, `openai/gpt-4o`,
  // `publishers/google/models/gemini…`) down to the last segment.
  if (m.includes("/")) m = m.slice(m.lastIndexOf("/") + 1);
  // Bedrock cross-region inference profile prefixes, then vendor prefixes.
  m = m.replace(/^(us|eu|apac|global|us-gov|jp|au|ca)\./, "");
  m = m.replace(
    /^(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|writer|qwen|stability)\./,
    "",
  );
  // Version suffix `-v1:0`, `-v2`, `:0`.
  m = m.replace(/-v\d+(:\d+)?$/, "").replace(/:\d+$/, "");
  m = m.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Date stamps: `-20240620`, `-2024-08-06`.
  m = m.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
  m = m.replace(/-latest$/, "").replace(/-preview$/, "");
  return m;
}

/**
 * Published per-token list rates for one provider's models, used only to
 * *weight* requests against each other and to estimate how much of a bill the
 * logs explain. Never used to produce a billed number.
 */
export interface AiModelRate {
  /** USD (or {@link AiModelRateCard.currency}) per million tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Absent means reasoning tokens bill as output. */
  reasoning?: number;
}

export interface AiModelRateCard {
  /** Canonical provider id these rates apply to. */
  provider: string;
  currency: string;
  /** ISO date the rates were checked against the provider's pricing page. */
  asOf: string;
  /** Keyed by {@link normalizeAiModel} output. */
  models: Record<string, AiModelRate>;
}

/**
 * Relative token weights when no rate card covers a model: the shape almost
 * every provider's price list has (output several times input, cache reads a
 * tenth of input, cache writes a quarter more). Good enough to split one
 * model's untyped bill between callers with different input/output mixes;
 * never used to put a money figure on anything.
 */
export const DEFAULT_TOKEN_WEIGHTS: Record<AiTokenType, number> = {
  input: 1,
  output: 4,
  cache_read: 0.1,
  cache_write: 1.25,
  reasoning: 4,
};

/* ------------------------------------------------------------------ *
 * Request log sources
 * ------------------------------------------------------------------ */

/** One kind of request-log source a plugin can read. */
export interface AiRequestLogSourceKind {
  /** Stable id, unique within the plugin (`bedrock-s3`, `ai-gateway`). */
  id: string;
  label: string;
  /** One or two sentences: what the source is and what it needs. */
  description: string;
  /** What the location picker lists ("Log group", "Gateway", "Bucket"). */
  locationLabel: string;
  /** How far back the first collection may reach. */
  maxHistoryDays: number;
  /**
   * True when reading the source bills the user's own provider account (a
   * Logs Insights scan). The host says so next to the source.
   */
  queriesBillable?: boolean;
  /** Provider docs for enabling the logs in the first place. */
  helpUrl?: string;
  /**
   * The user may narrow the chosen location with a key prefix (custom JSONL
   * under `logs/requests/`). The host stores it as `location.prefix`.
   */
  acceptsPrefix?: boolean;
}

export interface AiRequestLogsCapabilityDeclaration {
  sourceKinds: AiRequestLogSourceKind[];
}

/**
 * One option in a source's location picker: a log group, a bucket and prefix,
 * a gateway. `location` is opaque to the host and handed back verbatim to
 * `fetchAiRequestLogs`.
 */
export interface AiRequestLogLocation {
  /** Stable id for the option (the host uses it to preselect a saved one). */
  id: string;
  label: string;
  /** Secondary line ("us-east-1 · configured as the invocation-log destination"). */
  detail?: string;
  location: Record<string, string>;
  /**
   * True when the provider itself says logs land here (Bedrock's logging
   * configuration names this bucket), so the picker can put it first.
   */
  recommended?: boolean;
}

/** One closed UTC day for one configured source. */
export interface AiRequestLogFetchRange {
  sourceKindId: string;
  location: Record<string, string>;
  /** YYYY-MM-DD, UTC. */
  day: string;
  /**
   * The metadata keys the org mapped to caller dimensions. Only these are kept
   * on aggregates; everything else is counted in `observedMetadataKeys` and
   * dropped, which is what keeps a per-user id out of the store unless someone
   * asked for it.
   */
  metadataKeys: string[];
  /** Withdrawn when the host can no longer prove it owns this collection. */
  signal?: AbortSignal;
}

/** One normalized request, as a plugin parses it from its log format. */
export interface AiRequestRecord {
  /** ISO instant. Records outside the requested day are dropped. */
  timestamp?: string | undefined;
  provider: string;
  model: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  /** Cost the gateway itself computed for the request, when it reports one. */
  reportedCost?: number | undefined;
  reportedCurrency?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** Requests folded into one row: one (provider, model, mapped metadata) per day. */
export interface AiRequestAggregate {
  provider: string;
  model: string;
  /** Mapped metadata keys only; a key the request lacked is absent. */
  metadata: Record<string, string>;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Sum of gateway-reported cost, when every folded request reported one. */
  reportedCost?: number;
  reportedCurrency?: string;
}

export interface AiRequestLogFetchResult {
  aggregates: AiRequestAggregate[];
  /** Requests read for the day, including ones folded into the overflow row. */
  requests: number;
  /** Records that could not be parsed or lacked a provider/model. */
  skipped: number;
  /** Every metadata key seen, with how many requests carried it (top 50). */
  observedMetadataKeys: Record<string, number>;
  /**
   * More distinct metadata combinations than the aggregate cap: the tail was
   * folded into one row per (provider, model) with metadata `(other)`.
   */
  truncated?: boolean;
  /** Part of the source could not be read (one object refused, a page cap hit). */
  degraded?: boolean;
  /** Bytes the provider billed for reading, when it says (Logs Insights). */
  queryBytesScanned?: number;
}

/**
 * The source is missing setup this needs: logging not enabled, a bucket the
 * credential cannot read, a gateway with log collection off. Shown with its fix
 * rather than retried on a tight loop.
 */
export class AiRequestLogSetupError extends Error {
  readonly helpUrl: string | undefined;

  constructor(message: string, helpUrl?: string) {
    super(message);
    this.name = "AiRequestLogSetupError";
    this.helpUrl = helpUrl;
  }
}

/** The metadata value an over-cap combination is folded into. */
export const AI_OVERFLOW_VALUE = "(other)";

/** Default cap on distinct aggregate rows per source-day. */
export const AI_MAX_AGGREGATES_PER_DAY = 2000;

function nonNegative(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function metadataString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v.slice(0, 256);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Folds request records into per-day aggregates while streaming, so a plugin
 * never holds a day's raw requests in memory and never returns them.
 */
export class AiRequestAccumulator {
  private readonly rows = new Map<string, AiRequestAggregate & { costed: boolean }>();
  private readonly keyCounts = new Map<string, number>();
  private requestCount = 0;
  private skippedCount = 0;
  private overflowed = false;

  constructor(
    private readonly day: string,
    private readonly metadataKeys: string[],
    private readonly maxRows = AI_MAX_AGGREGATES_PER_DAY,
  ) {}

  /** Count a record that could not be parsed at all. */
  skip(): void {
    this.skippedCount++;
  }

  add(record: AiRequestRecord): void {
    if (record.timestamp) {
      const day = record.timestamp.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day !== this.day) return;
    }
    const provider = normalizeAiProvider(record.provider ?? "");
    const model = (record.model ?? "").trim();
    if (!provider || !model) {
      this.skippedCount++;
      return;
    }
    this.requestCount++;
    const metadata: Record<string, string> = {};
    if (record.metadata) {
      for (const [k, v] of Object.entries(record.metadata)) {
        if (metadataString(v) === undefined) continue;
        this.keyCounts.set(k, (this.keyCounts.get(k) ?? 0) + 1);
      }
      for (const key of this.metadataKeys) {
        const value = metadataString(record.metadata[key]);
        if (value !== undefined) metadata[key] = value;
      }
    }
    let key = aggregateKey(provider, model, metadata);
    if (!this.rows.has(key) && this.rows.size >= this.maxRows) {
      this.overflowed = true;
      const folded: Record<string, string> = {};
      for (const k of this.metadataKeys) folded[k] = AI_OVERFLOW_VALUE;
      key = aggregateKey(provider, model, folded);
      if (!this.rows.has(key)) this.rows.set(key, emptyRow(provider, model, folded));
      // The overflow row may push one past the cap; that is the point.
    } else if (!this.rows.has(key)) {
      this.rows.set(key, emptyRow(provider, model, metadata));
    }
    const row = this.rows.get(key)!;
    row.requests++;
    row.inputTokens += nonNegative(record.inputTokens);
    row.outputTokens += nonNegative(record.outputTokens);
    row.cacheReadTokens += nonNegative(record.cacheReadTokens);
    row.cacheWriteTokens += nonNegative(record.cacheWriteTokens);
    row.reasoningTokens += nonNegative(record.reasoningTokens);
    if (
      typeof record.reportedCost === "number" &&
      Number.isFinite(record.reportedCost) &&
      row.costed
    ) {
      row.reportedCost = (row.reportedCost ?? 0) + Math.max(0, record.reportedCost);
      row.reportedCurrency = (record.reportedCurrency ?? "USD").toUpperCase();
    } else {
      // One request without a reported cost makes the row's sum a partial
      // figure, which is worse than none: drop it.
      row.costed = false;
      delete row.reportedCost;
      delete row.reportedCurrency;
    }
  }

  result(extra: Partial<AiRequestLogFetchResult> = {}): AiRequestLogFetchResult {
    const observed = [...this.keyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
    return {
      aggregates: [...this.rows.values()].map(({ costed: _costed, ...row }) => row),
      requests: this.requestCount,
      skipped: this.skippedCount,
      observedMetadataKeys: Object.fromEntries(observed),
      ...(this.overflowed ? { truncated: true } : {}),
      ...extra,
    };
  }
}

function aggregateKey(provider: string, model: string, metadata: Record<string, string>): string {
  const meta = Object.keys(metadata)
    .sort()
    .map((k) => `${k}\u0001${metadata[k]}`)
    .join("\u0002");
  return `${provider}\u0000${model}\u0000${meta}`;
}

function emptyRow(
  provider: string,
  model: string,
  metadata: Record<string, string>,
): AiRequestAggregate & { costed: boolean } {
  return {
    provider,
    model,
    metadata,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costed: true,
  };
}

/* ------------------------------------------------------------------ *
 * The documented custom JSONL schema
 * ------------------------------------------------------------------ */

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/**
 * Parse one line of the documented custom request-log format: one JSON object
 * per line with `timestamp`, `provider`, `model`, `input_tokens`,
 * `output_tokens`, optional `cache_read_tokens`, `cache_write_tokens`,
 * `reasoning_tokens`, `cost`, `currency` and a flat `metadata` object.
 * camelCase spellings are accepted too. Returns null for a blank or unusable
 * line. The schema is documented in the AI attribution docs page; change both
 * together.
 */
export function parseAiRequestJsonLine(line: string): AiRequestRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const provider = pick(o, "provider");
  const model = pick(o, "model");
  if (typeof provider !== "string" || typeof model !== "string") return null;
  const metadata = pick(o, "metadata");
  const timestamp = pick(o, "timestamp", "ts", "time");
  const cost = num(pick(o, "cost"));
  const currency = pick(o, "currency");
  return {
    ...(typeof timestamp === "string"
      ? { timestamp }
      : typeof timestamp === "number"
        ? { timestamp: new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString() }
        : {}),
    provider,
    model,
    inputTokens: num(pick(o, "input_tokens", "inputTokens")),
    outputTokens: num(pick(o, "output_tokens", "outputTokens")),
    cacheReadTokens: num(pick(o, "cache_read_tokens", "cacheReadTokens")),
    cacheWriteTokens: num(pick(o, "cache_write_tokens", "cacheWriteTokens")),
    reasoningTokens: num(pick(o, "reasoning_tokens", "reasoningTokens")),
    ...(cost !== undefined ? { reportedCost: cost } : {}),
    ...(typeof currency === "string" ? { reportedCurrency: currency } : {}),
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
  };
}

/**
 * Whether an object key belongs to `day` under the documented layouts
 * (`…/YYYY/MM/DD/…`, `…/YYYY-MM-DD…`, or `…/dt=YYYY-MM-DD/…`).
 */
export function objectKeyMatchesDay(key: string, day: string): boolean {
  const [y, m, d] = day.split("-");
  return key.includes(`${y}/${m}/${d}/`) || key.includes(day) || key.includes(`${y}${m}${d}`);
}

/** Read a possibly gzip-compressed body as text, using the platform stream API. */
export async function readMaybeGzipText(body: ArrayBuffer, gzip: boolean): Promise<string> {
  if (!gzip) return new TextDecoder().decode(body);
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}
