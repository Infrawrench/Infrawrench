import type { CostQueryRequest, CostQueryResponse } from "./costs";
import type { CloudFetch } from "./fetch";
import type { PostureFinding, PostureListResponse, PostureSeverity } from "./posture";

/**
 * Per-resource facts the thin clients (the VS Code extension, the Raycast
 * extension) show beside a resource: what it actually cost recently and which
 * posture findings are open on it. Each is one existing org-scoped read; this
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

const STATUS_FIELD_KEYS = ["status", "state", "phase", "lifecycleState", "provisioningState"];

/**
 * A best-effort one-word status from a resource's stored fields (`running`,
 * `stopped`, `ACTIVE`). Plugins name it differently and some have none, so
 * null is a normal answer.
 */
export function resourceStatusFromFields(fields: Record<string, unknown> | null): string | null {
  if (!fields) return null;
  for (const key of STATUS_FIELD_KEYS) {
    const v = fields[key];
    if (typeof v === "string" && v.trim() !== "" && v.length <= 40) return v.trim();
  }
  return null;
}
