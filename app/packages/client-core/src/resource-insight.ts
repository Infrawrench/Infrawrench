import type { CostQueryRequest, CostQueryResponse } from "./costs";
import type { CloudFetch } from "./fetch";
import type { PostureFinding, PostureListResponse, PostureSeverity } from "./posture";
import {
  MAX_VULNERABILITY_RESOURCE_IDS,
  VULNERABILITY_SEVERITY_ORDER,
  fetchVulnerabilities,
  type VulnerabilitySeverity,
} from "./vulnerabilities";

/**
 * Per-resource facts the thin clients (the VS Code extension, the Raycast
 * extension) show beside a resource: what it actually cost recently, which
 * posture findings are open on it, and which vulnerabilities it runs. Each is one existing org-scoped read; this
 * module only shapes the request and the answer so both clients agree.
 */

/** Trailing window, in days, for "what did this cost". */
export const RESOURCE_SPEND_WINDOW_DAYS = 30;

/** The cost API's `topN` ceiling, which is also how many ids one query can group. */
const SPEND_IDS_PER_QUERY = 15;

export interface ResourceSpendRef {
  /** Provider-native id: what the cost data's `resource` dimension holds. */
  externalId: string;
  accountId: string;
}

export interface ResourceSpend {
  amount: number;
  currency: string;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Trailing-window spend per external id (`POST /costs/query`, grouped by
 * resource, filtered to the ids). A resource with no cost rows is absent from
 * the map, which is "no data", never "$0": the caller says so.
 *
 * Several currencies for one resource are kept apart rather than summed.
 */
export async function fetchResourceSpend(
  api: CloudFetch,
  orgId: string,
  refs: readonly ResourceSpendRef[],
  options: { days?: number; now?: number } = {},
): Promise<Map<string, ResourceSpend[]>> {
  const out = new Map<string, ResourceSpend[]>();
  const unique = [...new Map(refs.map((r) => [`${r.accountId}\u0000${r.externalId}`, r])).values()];
  if (unique.length === 0) return out;
  const days = options.days ?? RESOURCE_SPEND_WINDOW_DAYS;
  const now = options.now ?? Date.now();
  const to = isoDay(now);
  const from = isoDay(now - (days - 1) * 86_400_000);

  for (let i = 0; i < unique.length; i += SPEND_IDS_PER_QUERY) {
    const chunk = unique.slice(i, i + SPEND_IDS_PER_QUERY);
    const body: CostQueryRequest = {
      from,
      to,
      binning: "monthly",
      groupBy: "resource",
      filters: [
        { dimension: "resource", op: "in", values: chunk.map((r) => r.externalId) },
        { dimension: "account", op: "in", values: [...new Set(chunk.map((r) => r.accountId))] },
      ],
      topN: SPEND_IDS_PER_QUERY,
      comparePreviousPeriod: false,
      forecast: false,
    };
    const res = await api.org<CostQueryResponse>(orgId, "/costs/query", {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const series of res?.series ?? []) {
      if (!series.key || series.key === "__other__") continue;
      const amount = series.points.reduce((sum, p) => sum + p.amount, 0);
      const list = out.get(series.key) ?? [];
      const same = list.find((s) => s.currency === series.currency);
      if (same) same.amount += amount;
      else list.push({ amount, currency: series.currency });
      out.set(series.key, list);
    }
  }
  return out;
}

const SEVERITY_ORDER: Record<PostureSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Open (undismissed) posture findings grouped by resource id, worst first. */
export function postureFindingsByResource(
  feed: Pick<PostureListResponse, "findings">,
): Map<string, PostureFinding[]> {
  const out = new Map<string, PostureFinding[]>();
  for (const f of feed.findings) {
    const list = out.get(f.resourceId) ?? [];
    list.push(f);
    out.set(f.resourceId, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }
  return out;
}

/** Open vulnerabilities on one running resource, per severity. */
export interface ResourceVulnerabilityTally {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  /** How many of them are in the CISA Known Exploited Vulnerabilities catalog. */
  knownExploited: number;
  total: number;
}

export interface ResourceVulnerabilities {
  /**
   * Whether any connected account runs a scanner. False means "we cannot
   * know", so a client says nothing rather than "none".
   */
  scanned: boolean;
  /** Resource id → its tally; every asked-for resource is present when `scanned`. */
  byResource: Map<string, ResourceVulnerabilityTally>;
}

function emptyTally(): ResourceVulnerabilityTally {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, knownExploited: 0, total: 0 };
}

/**
 * Open (undismissed) vulnerability findings running on each resource: one
 * `GET /vulnerabilities?resourceId=…` read, scoped server-side so the answer
 * is only the findings that touch these resources. Ids past the route's cap
 * are dropped rather than split into more requests: a hover over more
 * resources than that is not one anybody reads line by line.
 */
export async function fetchResourceVulnerabilities(
  api: CloudFetch,
  orgId: string,
  resourceIds: readonly string[],
): Promise<ResourceVulnerabilities> {
  const ids = [...new Set(resourceIds.filter(Boolean))].slice(0, MAX_VULNERABILITY_RESOURCE_IDS);
  const byResource = new Map<string, ResourceVulnerabilityTally>();
  if (ids.length === 0) return { scanned: false, byResource };
  const feed = await fetchVulnerabilities(api, orgId, { resourceIds: ids });
  const scanned = feed.sources.length > 0;
  if (scanned) for (const id of ids) byResource.set(id, emptyTally());
  const wanted = new Set(ids);
  for (const f of feed.findings) {
    for (const r of f.running) {
      if (!wanted.has(r.resourceId)) continue;
      const t = byResource.get(r.resourceId) ?? emptyTally();
      t[f.severity] += 1;
      t.total += 1;
      if (f.kev) t.knownExploited += 1;
      byResource.set(r.resourceId, t);
    }
  }
  return { scanned: scanned || byResource.size > 0, byResource };
}

/**
 * "2 critical, 1 high (1 known exploited)", or "none". Severities with no
 * findings are left out; unscored findings read "unscored", never "low".
 */
export function describeResourceVulnerabilities(t: ResourceVulnerabilityTally): string {
  if (t.total === 0) return "none";
  const words: Record<VulnerabilitySeverity, string> = {
    critical: "critical",
    high: "high",
    medium: "medium",
    low: "low",
    unknown: "unscored",
  };
  const parts = VULNERABILITY_SEVERITY_ORDER.filter((s) => t[s] > 0).map(
    (s) => `${t[s]} ${words[s]}`,
  );
  const kev = t.knownExploited > 0 ? ` (${t.knownExploited} known exploited)` : "";
  return `${parts.join(", ")}${kev}`;
}

/**
 * One synced resource as the account listing returns it
 * (`GET /accounts/:id/resources`). The search endpoint carries no external id
 * or fields, so a client that needs either reads the account's listing.
 */
export interface AccountResourceRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown> | null;
  outputsJson: Record<string, unknown> | null;
  parentResourceId: string | null;
}

export async function fetchAccountResources(
  api: CloudFetch,
  orgId: string,
  accountId: string,
): Promise<AccountResourceRow[]> {
  return (
    (await api.org<AccountResourceRow[]>(
      orgId,
      `/accounts/${encodeURIComponent(accountId)}/resources`,
    )) ?? []
  );
}

/** Field keys a resource's status is read from, first non-empty wins. */
export const RESOURCE_STATUS_FIELD_KEYS = [
  "status",
  "state",
  "phase",
  "lifecycleState",
  "provisioningState",
] as const;

/**
 * A best-effort one-word status from a resource's stored fields (`running`,
 * `stopped`, `ACTIVE`). Plugins name it differently and some have none, so
 * null is a normal answer.
 */
export function resourceStatusFromFields(fields: Record<string, unknown> | null): string | null {
  if (!fields) return null;
  for (const key of RESOURCE_STATUS_FIELD_KEYS) {
    const v = fields[key];
    if (typeof v === "string" && v.trim() !== "" && v.length <= 40) return v.trim();
  }
  return null;
}
