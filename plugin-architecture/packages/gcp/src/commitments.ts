/**
 * Committed-use discount inventory via
 * `compute.regionCommitments.aggregatedList`
 * (`GET https://compute.googleapis.com/compute/v1/projects/{project}/aggregated/commitments`,
 * `pageToken`-paginated).
 *
 * The one thing to know about this API: **it returns no money at all.** A GCP
 * commitment is denominated in resource units — so many vCPUs, so many GB of
 * memory, so many GB of local SSD — and the list response carries neither a
 * price nor a currency. Records here therefore populate `unitCommitments`
 * only and omit every money field. That absence is load-bearing downstream:
 * a unit-denominated commitment's utilization cannot be derived from cost
 * rows, and the host reports it as unknown rather than 0%.
 *
 * `plan` is TWELVE_MONTH or THIRTY_SIX_MONTH — that is the provider's own
 * statement of the term, which is where `termDays` comes from (never from
 * the date difference).
 */

import type { CommitmentRecord, CommitmentState } from "@infrawrench/plugin-base";

/** Everything commitment collection needs from the client, and nothing more. */
export interface GcpCommitmentsContext {
  project: string;
  get<T>(url: string): Promise<T>;
}

interface GcpCommitmentResource {
  type?: string;
  amount?: string;
  acceleratorType?: string;
}

interface GcpCommitment {
  id?: string;
  name?: string;
  description?: string;
  region?: string;
  plan?: string;
  status?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  type?: string;
  category?: string;
  resources?: GcpCommitmentResource[];
}

interface AggregatedScope {
  commitments?: GcpCommitment[];
  warning?: unknown;
}

interface AggregatedListResponse {
  items?: Record<string, AggregatedScope>;
  nextPageToken?: string;
}

/**
 * NOT_YET_ACTIVE is a purchase whose term hasn't started; ACTIVE is applying
 * discounts; EXPIRED, CANCELLED, and anything Google adds later are treated
 * as expired — understating holdings, never overstating them.
 */
export function normalizeGcpCommitmentStatus(raw: string): CommitmentState {
  switch (raw) {
    case "ACTIVE":
      return "active";
    case "NOT_YET_ACTIVE":
      return "queued";
    default:
      return "expired";
  }
}

/** TWELVE_MONTH → 365; THIRTY_SIX_MONTH → 1095; anything else → no term. */
function planTermDays(plan: string | undefined): number | undefined {
  switch (plan) {
    case "TWELVE_MONTH":
      return 365;
    case "THIRTY_SIX_MONTH":
      return 1095;
    default:
      return undefined;
  }
}

/** `https://…/regions/us-central1` or `regions/us-central1` → `us-central1`. */
function regionName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const last = url.split("/").filter(Boolean).pop();
  return last || undefined;
}

/**
 * Unit label the reader can compare against GCP's console. Memory amounts are
 * reported in MB by the API but sold in GB — keep the API's own unit and say
 * so, rather than converting and creating a number the console doesn't show.
 */
function unitLabel(resource: GcpCommitmentResource): string {
  const type = resource.type ?? "";
  if (type === "ACCELERATOR" && resource.acceleratorType) {
    return `ACCELERATOR (${regionName(resource.acceleratorType) ?? resource.acceleratorType})`;
  }
  if (type === "MEMORY") return "MEMORY_MB";
  if (type === "LOCAL_SSD") return "LOCAL_SSD_GB";
  return type || "UNIT";
}

export function mapGcpCommitment(
  commitment: GcpCommitment,
  scopeRegion: string | undefined,
): CommitmentRecord | null {
  const id = commitment.name ?? commitment.id ?? "";
  if (!id) return null;
  const region = regionName(commitment.region) ?? scopeRegion;
  const termDays = planTermDays(commitment.plan);
  const units = (commitment.resources ?? [])
    .map((resource) => ({ unit: unitLabel(resource), amount: Number(resource.amount ?? 0) }))
    .filter((entry) => Number.isFinite(entry.amount) && entry.amount > 0);
  const label = commitment.type ? `Committed use — ${commitment.type}` : "Committed use discount";
  return {
    id,
    kind: "committed_use",
    description: commitment.description ? `${label} (${commitment.description})` : label,
    ...(region ? { region } : {}),
    startDate: commitment.startTimestamp ?? "",
    ...(commitment.endTimestamp ? { endDate: commitment.endTimestamp } : {}),
    ...(termDays !== undefined ? { termDays } : {}),
    // No money fields, deliberately: the API reports none, and a substituted
    // zero would render as "free" in a finance review.
    ...(units.length > 0 ? { unitCommitments: units } : {}),
    state: normalizeGcpCommitmentStatus(commitment.status ?? ""),
  };
}

export async function fetchGcpCommitments(ctx: GcpCommitmentsContext): Promise<CommitmentRecord[]> {
  const records: CommitmentRecord[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/aggregated/commitments`,
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await ctx.get<AggregatedListResponse>(url.toString());
    for (const [scope, entry] of Object.entries(page.items ?? {})) {
      // Scope keys look like "regions/us-central1"; scopes without
      // commitments carry only a warning entry.
      const scopeRegion = scope.startsWith("regions/") ? scope.slice("regions/".length) : undefined;
      for (const commitment of entry.commitments ?? []) {
        const record = mapGcpCommitment(commitment, scopeRegion);
        if (record) records.push(record);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return records;
}
