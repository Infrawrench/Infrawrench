/**
 * Plan allowances for a Depot organization: the current billing cycle's
 * usage (one `UsageService/GetUsage` call from the cycle start to now)
 * against the included minutes and storage of the plan picked on the
 * account. Depot does not expose the plan through its API, so the limits are
 * the plan's published allowances plus any overrides, which is also why a
 * plan with no allowance (Business without overrides, usage only) reports
 * nothing rather than a zero limit.
 */

import type { QuotaUsage } from "@infrawrench/plugin-base";
import { getUsage, type DepotTransport } from "./api.js";
import { normalizeUsage } from "./cost-data.js";
import { cycleBounds, type DepotRates } from "./rates.js";

export async function fetchDepotQuotas(
  transport: DepotTransport,
  rates: DepotRates,
  now: Date = new Date(),
): Promise<QuotaUsage[]> {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const { startMs } = cycleBounds(todayMs, rates.cycleStartDay);
  const usage = normalizeUsage(await getUsage(transport, startMs, now.getTime()));

  const buildMinutes = usage.builds.reduce((s, b) => s + b.minutes, 0);
  const actionsMinutes = usage.actions.filter((a) => !a.macos).reduce((s, a) => s + a.billed, 0);
  // Cache and registry share one storage allowance, so the types are summed.
  const storageGb = usage.storage.reduce((s, x) => s + x.gb, 0);

  const out: QuotaUsage[] = [];
  const push = (
    id: string,
    service: string,
    name: string,
    limit: number,
    used: number,
    unit: string,
  ) => {
    if (limit > 0) {
      out.push({
        id,
        service,
        name,
        limit,
        used: Number(used.toFixed(2)),
        unit,
        adjustable: true,
        docsUrl: "https://depot.dev/pricing",
      });
    }
  };
  push(
    "included-build-minutes",
    "container-builds",
    "Included Docker build minutes (billing cycle)",
    rates.includedBuildMinutes,
    buildMinutes,
    "minutes",
  );
  push(
    "included-actions-minutes",
    "github-actions",
    "Included GitHub Actions minutes (billing cycle)",
    rates.includedActionsMinutes,
    actionsMinutes,
    "minutes",
  );
  push(
    "included-storage",
    "storage",
    "Included cache and registry storage",
    rates.includedStorageGb,
    storageGb,
    "GB",
  );
  return out;
}
