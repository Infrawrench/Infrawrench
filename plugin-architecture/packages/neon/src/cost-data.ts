/**
 * Actual-spend collection from Neon's consumption-history API.
 *
 * Neon's API reports usage units, not dollars — `GET /consumption_history/v2/
 * projects` returns per-project daily metrics (CU-seconds, bytes-month of
 * storage, transfer bytes…). We convert those to money with Neon's published
 * usage-based rates (verified against neon.com/pricing and
 * neon.com/docs/introduction/usage-metrics, July 2026):
 *
 *   compute                       $0.106/CU-hour (Launch) · $0.222/CU-hour (Scale)
 *   root/child branch storage     $0.35/GB-month
 *   instant restore storage       $0.20/GB-month
 *   snapshot storage              $0.09/GB-month
 *   extra branches                $1.50/branch-month
 *   public network transfer       $0.10/GB (the 500 GB/project/month free
 *                                 allowance is NOT modeled — see below)
 *   private network transfer      $0.01/GB
 *
 * Caveats: the compute rate is picked from the organization's plan (`launch`
 * vs `scale`); unrecognized paid plans (agent, business, enterprise, custom
 * deals) fall back to the Launch rate, so amounts are an estimate, not an
 * invoice. Plan-included allowances (monthly compute/storage/transfer quotas)
 * are not subtracted, which overestimates small accounts. Neon meters storage
 * in binary gigabytes, so 1 GB = 2^30 bytes here.
 *
 * The consumption API keeps 60 days of daily history and is only available on
 * paid usage-based plans; free-plan organizations are skipped (nothing billed).
 */

import type { Api, Organization } from "@neondatabase/api-client";
import { ConsumptionHistoryGranularity } from "@neondatabase/api-client";
import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

const BYTES_PER_GB = 2 ** 30;

const COMPUTE_USD_PER_CU_HOUR: Record<string, number> = {
  launch: 0.106,
  scale: 0.222,
};

/** Rate per metric unit, keyed by the API's metric_name. */
function metricDollars(metricName: string, value: number, cuHourRate: number): number {
  switch (metricName) {
    case "compute_unit_seconds":
      return (value / 3600) * cuHourRate;
    case "root_branch_bytes_month":
    case "child_branch_bytes_month":
      return (value / BYTES_PER_GB) * 0.35;
    case "instant_restore_bytes_month":
      return (value / BYTES_PER_GB) * 0.2;
    case "snapshot_storage_bytes_month":
      return (value / BYTES_PER_GB) * 0.09;
    case "extra_branches_month":
      return value * 1.5;
    case "public_network_transfer_bytes":
      return (value / BYTES_PER_GB) * 0.1;
    case "private_network_transfer_bytes":
      return (value / BYTES_PER_GB) * 0.01;
    default:
      return 0;
  }
}

/** Bucket each metric into the user-facing service the dashboard shows. */
function metricService(metricName: string): string {
  switch (metricName) {
    case "compute_unit_seconds":
      return "Compute";
    case "extra_branches_month":
      return "Branches";
    case "public_network_transfer_bytes":
    case "private_network_transfer_bytes":
      return "Network";
    default:
      return "Storage";
  }
}

const METRICS = [
  "compute_unit_seconds",
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "instant_restore_bytes_month",
  "snapshot_storage_bytes_month",
  "extra_branches_month",
  "public_network_transfer_bytes",
  "private_network_transfer_bytes",
];

/**
 * Resolve the organizations this API key can see. Personal keys can list them
 * directly; org-scoped keys can't call /users/me/organizations, so fall back
 * to the org IDs stamped on the visible projects (plan resolved per org).
 */
async function resolveOrganizations(api: Api<unknown>): Promise<Organization[]> {
  try {
    const resp = await api.getCurrentUserOrganizations();
    const orgs = resp.data.organizations ?? [];
    if (orgs.length > 0) return orgs;
  } catch {
    /* org-scoped key — derive from projects below */
  }

  const orgIds = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const resp = await api.listProjects(cursor ? { cursor } : {});
    for (const p of resp.data.projects) {
      if (p.org_id) orgIds.add(p.org_id);
    }
    const next = resp.data.pagination?.cursor;
    if (!next || resp.data.projects.length === 0) break;
    cursor = next;
  }

  const orgs: Organization[] = [];
  for (const orgId of orgIds) {
    const resp = await api.getOrganization(orgId);
    orgs.push(resp.data);
  }
  return orgs;
}

export async function fetchNeonCostData(
  api: Api<unknown>,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const organizations = await resolveOrganizations(api);
  if (organizations.length === 0) {
    throw new Error(
      "Neon plugin: couldn't resolve an organization for this API key, so consumption " +
        "history can't be queried.",
    );
  }

  // Aggregate per (date, service, project) so per-metric rows collapse into
  // stable dimension keys.
  const buckets = new Map<string, CostRow>();

  for (const org of organizations) {
    // The consumption API only exists on paid usage-based plans, and free
    // plans have no metered spend anyway.
    if (org.plan === "free" || org.plan.startsWith("free_")) continue;
    const cuHourRate = COMPUTE_USD_PER_CU_HOUR[org.plan] ?? COMPUTE_USD_PER_CU_HOUR["launch"]!;

    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const resp = await api.getConsumptionHistoryPerProjectV2({
        org_id: org.id,
        // `to` is rounded to day granularity; over-ask by using end-of-day and
        // filter rows back to the inclusive range below.
        from: `${range.fromDate}T00:00:00Z`,
        to: `${range.toDate}T23:59:59Z`,
        granularity: ConsumptionHistoryGranularity.Daily,
        metrics: METRICS,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const project of resp.data.projects ?? []) {
        for (const period of project.periods ?? []) {
          for (const timeframe of period.consumption ?? []) {
            const date = (timeframe.timeframe_start ?? "").slice(0, 10);
            if (!date || date < range.fromDate || date > range.toDate) continue;
            for (const metric of timeframe.metrics ?? []) {
              const amount = metricDollars(metric.metric_name, metric.value, cuHourRate);
              if (amount === 0) continue;
              const service = metricService(metric.metric_name);
              const key = `${date}|${service}|${project.project_id}`;
              const existing = buckets.get(key);
              if (existing) {
                existing.amount += amount;
              } else {
                buckets.set(key, {
                  date,
                  service,
                  resourceId: project.project_id,
                  currency: "USD",
                  amount,
                });
              }
            }
          }
        }
      }

      const next = resp.data.pagination?.cursor;
      if (!next || (resp.data.projects ?? []).length === 0) break;
      cursor = next;
    }
  }

  return [...buckets.values()].filter((row) => row.amount !== 0);
}
