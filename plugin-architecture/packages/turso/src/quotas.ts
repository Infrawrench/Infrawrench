/**
 * Plan quotas for a Turso organization.
 *
 * Turso publishes each plan's allowances (`GET .../plans`, camelCase
 * `quotas`, storage and sync in bytes), the organization's current plan
 * (`GET .../subscription`) and the current billing cycle's usage
 * (`GET .../usage`, snake_case). Pairing the three gives one reading per
 * metered dimension. Verified against the turso-docs OpenAPI spec, October 2026.
 */

import type { QuotaUsage } from "@infrawrench/plugin-base";

interface PlanQuotas {
  rowsRead?: number | null;
  rowsWritten?: number | null;
  databases?: number | null;
  locations?: number | null;
  storage?: number | null;
  groups?: number | null;
  bytesSynced?: number | null;
}

interface OrgUsage {
  rows_read?: number;
  rows_written?: number;
  databases?: number;
  locations?: number;
  storage_bytes?: number;
  groups?: number;
  bytes_synced?: number;
}

const DIMENSIONS: Array<{
  id: string;
  name: string;
  quota: keyof PlanQuotas;
  usage: keyof OrgUsage;
  unit?: string;
}> = [
  {
    id: "rows-read",
    name: "Rows read (billing cycle)",
    quota: "rowsRead",
    usage: "rows_read",
    unit: "rows",
  },
  {
    id: "rows-written",
    name: "Rows written (billing cycle)",
    quota: "rowsWritten",
    usage: "rows_written",
    unit: "rows",
  },
  { id: "storage", name: "Storage", quota: "storage", usage: "storage_bytes", unit: "bytes" },
  {
    id: "bytes-synced",
    name: "Embedded replica sync (billing cycle)",
    quota: "bytesSynced",
    usage: "bytes_synced",
    unit: "bytes",
  },
  { id: "databases", name: "Databases", quota: "databases", usage: "databases", unit: "databases" },
  { id: "groups", name: "Groups", quota: "groups", usage: "groups", unit: "groups" },
  { id: "locations", name: "Locations", quota: "locations", usage: "locations", unit: "locations" },
];

export async function fetchTursoQuotas(
  fetchApi: <T>(path: string) => Promise<T>,
  orgName: string,
): Promise<QuotaUsage[]> {
  const base = `/v1/organizations/${encodeURIComponent(orgName)}`;
  const [plans, subscription, usage] = await Promise.all([
    fetchApi<{ plans?: Array<{ name?: string; quotas?: PlanQuotas }> }>(`${base}/plans`),
    fetchApi<{ subscription?: { plan?: string; name?: string } }>(`${base}/subscription`),
    fetchApi<{ organization?: { usage?: OrgUsage } }>(`${base}/usage`),
  ]);

  const planName = subscription.subscription?.plan ?? subscription.subscription?.name ?? "";
  const plan = (plans.plans ?? []).find((p) => p.name === planName);
  if (!plan?.quotas) {
    throw new Error(`Turso plugin: no quotas published for plan "${planName || "unknown"}"`);
  }
  const used = usage.organization?.usage ?? {};

  const rows: QuotaUsage[] = [];
  for (const dim of DIMENSIONS) {
    const limit = Number(plan.quotas[dim.quota] ?? 0);
    // A null or zero allowance means the plan does not cap this dimension.
    if (!Number.isFinite(limit) || limit <= 0) continue;
    rows.push({
      id: dim.id,
      service: "organization",
      name: dim.name,
      limit,
      used: Number(used[dim.usage] ?? 0),
      ...(dim.unit ? { unit: dim.unit } : {}),
      // Paid plans can raise usage ceilings with overages or a plan change.
      adjustable: true,
      docsUrl: "https://turso.tech/pricing",
    });
  }
  return rows;
}
