/**
 * Synthetic probes — HTTP uptime/latency checks run on an interval from the
 * egress-proxy Worker on Cloudflare's edge, i.e. from *outside* the cluster:
 * a probe measures what a user on the internet would see.
 *
 * This module is the shared pure half every surface uses: the wire contract
 * for `/api/org/:orgId/probes`, the input limits the editor UIs and the server
 * boundary both clamp against (the `SCHEDULE_LIMITS` stance — the form and the
 * API can't disagree about what a valid interval is), and the Bearer fetch
 * helpers mobile and the CLI call.
 *
 * The plugin-base import is type-only on purpose (the expiry.ts stance): no
 * runtime dependency on plugin-base, so the mobile bundle stays lean.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

export type ProbeStatus = "up" | "down" | "unknown";

/** Methods a probe may use — checks, not mutations, so no bodies are sent. */
export const PROBE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
export type ProbeMethod = (typeof PROBE_METHODS)[number];

/**
 * Bounds every probe input is clamped into, shared by the editor UIs, the API
 * boundary and the poller pass so all three agree.
 */
export const PROBE_LIMITS = {
  /** Floor on the probe interval — the edge proxy is shared infrastructure. */
  minIntervalSeconds: 60,
  /** A day. Slower than this and it stops being monitoring. */
  maxIntervalSeconds: 24 * 60 * 60,
  minTimeoutMs: 1_000,
  /** Mirrors the egress proxy's own probe ceiling. */
  maxTimeoutMs: 60_000,
  minFailureThreshold: 1,
  maxFailureThreshold: 20,
  /** Hard cap on probes per org — a governance rail, not a product tier. */
  maxPerOrg: 100,
} as const;

/** Defaults for a fresh probe, used by editors and the create endpoint alike. */
export const PROBE_DEFAULTS = {
  method: "GET" as ProbeMethod,
  intervalSeconds: 60,
  timeoutMs: 10_000,
  failureThreshold: 3,
} as const;

/** Wire shape of a probe row as every read endpoint returns it. */
export interface SyntheticProbe {
  id: string;
  name: string;
  url: string;
  method: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  enabled: boolean;
  /** Linked resource identity — which output suggested the URL. All nullable. */
  accountId: string | null;
  resourceId: string | null;
  pluginId: string | null;
  resourceTypeId: string | null;
  outputKey: string | null;
  status: ProbeStatus;
  consecutiveFailures: number;
  lastProbeAt: string | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  /** Failure detail for the last failed probe; null after a success. */
  lastError: string | null;
  lastStateChangeAt: string | null;
  /**
   * Fraction of the trailing 24h the endpoint was up (0–1), computed from the
   * recorded "Up" series; null before the first result lands in ClickHouse.
   */
  uptime24h: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProbeListResponse {
  probes: SyntheticProbe[];
}

/** Body of `POST /api/org/:orgId/probes`. */
export interface ProbeCreate {
  name: string;
  url: string;
  method?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  enabled?: boolean;
  /** Set when the URL came from a suggestion; all-or-nothing with resourceId. */
  accountId?: string | null;
  resourceId?: string | null;
  pluginId?: string | null;
  resourceTypeId?: string | null;
  outputKey?: string | null;
}

/** Body of `PUT /api/org/:orgId/probes/:id`; omitted fields keep their value. */
export interface ProbePatch {
  name?: string;
  url?: string;
  method?: string;
  intervalSeconds?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  enabled?: boolean;
}

/** One endpoint candidate mined from a synced resource's outputs/fields. */
export interface ProbeSuggestion {
  /** Normalized to an absolute URL (bare hosts get `https://`). */
  url: string;
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  /** The output/field key the URL was mined from (e.g. "endpoint"). */
  outputKey: string;
}

export interface ProbeSuggestionsResponse {
  suggestions: ProbeSuggestion[];
}

/** `GET /probes/:id/metrics` — the recorded Latency/Up series over a range. */
export interface ProbeMetricsResponse {
  series: MetricSeries[];
}

/**
 * Clamp a numeric input into its PROBE_LIMITS range, falling back when it
 * isn't a finite number. Shared by the editor UIs and the API boundary.
 */
export function clampProbeNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * Validate and normalize a probe URL. Returns the normalized absolute URL, or
 * a human-readable problem — the editor UIs and the API boundary reject the
 * same inputs with the same words (the `validateScheduleTiming` stance).
 */
export function normalizeProbeUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "A URL is required." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "The URL must be absolute, e.g. https://api.example.com/health." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Only http and https endpoints can be probed." };
  }
  if (!parsed.hostname) return { error: "The URL has no host." };
  return { url: parsed.toString() };
}

/** Normalize a probe method, defaulting unknown input to GET. */
export function normalizeProbeMethod(raw: unknown): ProbeMethod {
  const upper = String(raw ?? PROBE_DEFAULTS.method).toUpperCase();
  return (PROBE_METHODS as readonly string[]).includes(upper)
    ? (upper as ProbeMethod)
    : PROBE_DEFAULTS.method;
}

/** `0.9987` → `"99.87%"`; `1` → `"100%"` — the uptime rendering every surface uses. */
export function formatUptime(fraction: number): string {
  const pct = fraction * 100;
  const rounded = Number(pct.toFixed(2));
  return `${rounded}%`;
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile + any host that talks the cloud API directly)
// ---------------------------------------------------------------------------

/** Read `GET /api/org/:orgId/probes` (permission `resources:read`). */
export async function fetchProbes(api: CloudFetch, orgId: string): Promise<ProbeListResponse> {
  const res = await api.org<ProbeListResponse>(orgId, "/probes");
  return res ?? { probes: [] };
}

/** Create a probe (`resources:write`). */
export async function createProbe(
  api: CloudFetch,
  orgId: string,
  body: ProbeCreate,
): Promise<SyntheticProbe | null> {
  return api.org<SyntheticProbe>(orgId, "/probes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Update a probe — settings and the enable toggle (`resources:write`). */
export async function updateProbe(
  api: CloudFetch,
  orgId: string,
  probeId: string,
  patch: ProbePatch,
): Promise<SyntheticProbe | null> {
  return api.org<SyntheticProbe>(orgId, `/probes/${encodeURIComponent(probeId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Delete a probe (`resources:write`). */
export async function deleteProbe(api: CloudFetch, orgId: string, probeId: string): Promise<void> {
  await api.org(orgId, `/probes/${encodeURIComponent(probeId)}`, { method: "DELETE" });
}

/** Endpoint candidates mined from resource outputs (`resources:read`). */
export async function fetchProbeSuggestions(
  api: CloudFetch,
  orgId: string,
): Promise<ProbeSuggestionsResponse> {
  const res = await api.org<ProbeSuggestionsResponse>(orgId, "/probes/suggestions");
  return res ?? { suggestions: [] };
}

/** The recorded Latency/Up series for one probe (`resources:read`). */
export async function fetchProbeMetrics(
  api: CloudFetch,
  orgId: string,
  probeId: string,
  range: { startMs: number; endMs: number },
): Promise<ProbeMetricsResponse> {
  const params = new URLSearchParams({
    startMs: String(range.startMs),
    endMs: String(range.endMs),
  });
  const res = await api.org<ProbeMetricsResponse>(
    orgId,
    `/probes/${encodeURIComponent(probeId)}/metrics?${params.toString()}`,
  );
  return res ?? { series: [] };
}
