/**
 * Quotas: `GET /v2/quota` returns `{ resource, usage, limit }` for every
 * organization quota (instances, GPUs, elastic IPs, SKS clusters, DBaaS,
 * snapshots, templates, ...). Both halves come from Exoscale; a quota with no
 * positive limit is skipped.
 */

import type { QuotaUsage } from "@infrawrench/plugin-base";
import { QuotaAccessError } from "@infrawrench/plugin-base";
import { DEFAULT_ZONE, type ExoscaleApi, statusOf } from "./api.js";

export function quotasFrom(
  list: Array<{ resource?: string; usage?: number; limit?: number }>,
): QuotaUsage[] {
  return list
    .filter((q) => q.resource && Number(q.limit) > 0)
    .map((q) => ({
      id: String(q.resource),
      service: "Organization",
      name: String(q.resource).replace(/-/g, " "),
      used: Math.max(0, Number(q.usage ?? 0)),
      limit: Number(q.limit),
      adjustable: true,
    }));
}

export async function fetchQuotas(api: ExoscaleApi): Promise<QuotaUsage[]> {
  try {
    const res = await api.get<{
      quotas?: Array<{ resource?: string; usage?: number; limit?: number }>;
    }>(DEFAULT_ZONE, "/quota");
    return quotasFrom(res.quotas ?? []);
  } catch (err) {
    const s = statusOf(err);
    if (s === 401 || s === 403) {
      throw new QuotaAccessError("This API key's role cannot read the organization's quotas.", {
        label: "Manage IAM roles",
        url: "https://portal.exoscale.com/iam/roles",
      });
    }
    throw err;
  }
}
