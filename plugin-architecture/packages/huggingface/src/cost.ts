import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { InferenceUsagePeriod, JobsUsage } from "./wire.js";

function inRange(date: string, range: CostFetchRange): boolean {
  return date >= range.fromDate && date <= range.toDate;
}

/**
 * Organization Inference Providers usage, one row per day, model, provider
 * and member. `costCents` is the billed amount rounded to the cent per row
 * (Hugging Face's own caveat: tiny requests can read as 0).
 * https://huggingface.co/docs/inference-providers/pricing
 */
export function inferenceUsageRows(
  periods: InferenceUsagePeriod[],
  range: CostFetchRange,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const period of periods) {
    const date = String(period.period ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inRange(date, range)) continue;
    for (const u of period.usage ?? []) {
      const cents = Number(u.costCents ?? 0);
      const requests = Number(u.requestCount ?? 0);
      if (!cents && !requests) continue;
      const tags: Record<string, string> = {};
      if (u.provider) tags["provider"] = u.provider;
      if (u.user) tags["member"] = u.user;
      rows.push({
        date,
        service: "Inference Providers",
        ...(u.model ? { resourceId: u.model } : {}),
        tags,
        currency: "USD",
        amount: cents / 100,
        usageAmount: requests,
        usageUnit: "requests",
      });
    }
  }
  return rows;
}

/**
 * The token user's Jobs usage for the current billing period. Each job is
 * dated to the day it started, so a long job lands on one day: the API gives
 * a per-job total, not a daily split.
 */
export function jobsUsageRows(usage: JobsUsage, range: CostFetchRange): CostRow[] {
  const rows: CostRow[] = [];
  for (const job of usage.usage?.jobDetails ?? []) {
    const date = String(job.startedAt ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inRange(date, range)) continue;
    const micro = Number(job.totalCostMicroUsd ?? 0);
    if (!micro && !job.totalMinutes) continue;
    rows.push({
      date,
      service: "Jobs",
      ...(job.jobId ? { resourceId: job.jobId } : {}),
      tags: job.hardwareFlavor ? { hardware: job.hardwareFlavor } : {},
      currency: "USD",
      amount: micro / 1_000_000,
      usageAmount: Number(job.totalMinutes ?? 0),
      usageUnit: "minutes",
    });
  }
  return rows;
}
