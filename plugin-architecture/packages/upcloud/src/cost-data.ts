/**
 * Billed spend from `GET /1.3/account/billing/summary/{YYYY-MM}` (the
 * current "with resource details" endpoint; the older `billing_summary`
 * ones are deprecated). Every category (`servers.server`,
 * `storages.storage`/`backup`/`template`, `managed_databases`,
 * `managed_object_storages`, load balancers, Kubernetes, networks, ...)
 * lists `resources[]`, each with `resource_id`, `amount` (cumulative for the
 * month) and `details[]` carrying `zone`, `plan` and `labels`.
 *
 * Amounts are month totals, so rows are period-native: dated to the 1st of
 * the month (the host's rule for period-native plugins), restated on every
 * run while the month is open. Zone is the region; labels become tags.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { type UpCloudApi, statusOf } from "./api.js";

const SERVICE_NAMES: Record<string, string> = {
  servers: "Servers",
  storages: "Storage",
  networks: "Network",
  managed_databases: "Managed Databases",
  managed_object_storages: "Managed Object Storage",
  managed_load_balancers: "Managed Load Balancer",
  managed_kubernetes: "Managed Kubernetes",
  network_gateways: "Network Gateways",
  file_storages: "File Storage",
};

type Resource = {
  resource_id?: string;
  amount?: number;
  details?: Array<{
    zone?: string;
    amount?: number;
    labels?: Array<{ key?: string; value?: string }>;
  }>;
};

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = to.slice(0, 7);
  while (d.toISOString().slice(0, 7) <= end && out.length < 24) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

function serviceName(category: string, sub: string): string {
  const base = SERVICE_NAMES[category] ?? category.replace(/_/g, " ");
  if (category === "storages" && sub !== "storage") return `${base} (${sub}s)`;
  if (category === "networks" && sub) return `${base} (${sub.replace(/_/g, " ")})`;
  return base;
}

export function summaryRows(month: string, summary: Record<string, unknown>): CostRow[] {
  const currency = String(summary["currency"] ?? "EUR");
  const date = `${month}-01`;
  const rows: CostRow[] = [];
  for (const [category, value] of Object.entries(summary)) {
    if (!value || typeof value !== "object") continue;
    for (const [sub, group] of Object.entries(value as Record<string, unknown>)) {
      if (!group || typeof group !== "object") continue;
      const g = group as { resources?: Resource[] } & Record<string, unknown>;
      // Storage groups list backups and templates as sibling arrays.
      const lists: Array<[string, Resource[]]> = [];
      if (Array.isArray(g.resources)) lists.push([sub, g.resources]);
      for (const [k, v] of Object.entries(g))
        if (k !== "resources" && Array.isArray(v)) lists.push([k, v as Resource[]]);
      for (const [kind, resources] of lists) {
        for (const r of resources) {
          const amount = Number(r.amount ?? 0);
          if (!Number.isFinite(amount) || amount === 0) continue;
          const detail = r.details?.[r.details.length - 1];
          const tags: Record<string, string> = {};
          for (const l of detail?.labels ?? []) if (l.key) tags[l.key] = l.value ?? "";
          rows.push({
            date,
            service: serviceName(category, kind),
            ...(detail?.zone ? { region: detail.zone } : {}),
            ...(r.resource_id ? { resourceId: r.resource_id } : {}),
            ...(Object.keys(tags).length ? { tags } : {}),
            currency,
            amount: Math.round(amount * 1e5) / 1e5,
          });
        }
      }
    }
  }
  return rows;
}

export async function fetchUpCloudCostData(
  api: UpCloudApi,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  for (const month of monthsBetween(range.fromDate, range.toDate)) {
    // Rows are dated to the 1st; a month whose 1st falls before the range
    // belongs to an earlier window (restatementDays keeps it covered).
    if (`${month}-01` < range.fromDate) continue;
    try {
      const summary = await api.get<Record<string, unknown>>(`/account/billing/summary/${month}`);
      rows.push(...summaryRows(month, summary));
    } catch (err) {
      // A month before the account existed answers 404; anything else is real.
      if (statusOf(err) === 404) continue;
      throw err;
    }
  }
  return rows;
}
