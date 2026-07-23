/**
 * Actual-spend collection via Cloudflare's PayGo billable-usage API.
 *
 * `GET /accounts/{account_id}/billing/usage/paygo` (SDK:
 * `cf.billing.usage.paygo`) returns FOCUS-style charge records for self-serve
 * (PayGo) accounts: `ContractedCost` money per `ChargePeriodStart..End`,
 * `ServiceName`, consumed quantity/unit, and optionally the zone. Charge
 * periods follow the subscription billing cycle rather than calendar days, so
 * rows are dated to the charge-period start and the manifest declares
 * `periodNative`.
 *
 * CAUTION: this endpoint is v1 ALPHA (verified against
 * developers.cloudflare.com, July 2026) — access is restricted to select
 * accounts and breaking changes are possible. Requests that 400/404 are
 * surfaced with a clear "not available for this account" error. The docs also
 * note `from`/`to` must span the account's billing-cycle anchor day or no
 * data is returned; the host's month-aligned chunks satisfy that for any
 * anchor day that exists in the month.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CloudflareApi, formatCloudflareError } from "./clients/shared.js";

export async function fetchCloudflareCostData(
  api: CloudflareApi,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const account_id = await api.getAccountId();

  let result;
  try {
    result = await api.cf.billing.usage.paygo({
      account_id,
      from: range.fromDate,
      to: range.toDate,
    });
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 400 || status === 404) {
      // Alpha rollout: the endpoint 404s for accounts that aren't enrolled
      // (or may move without notice while in alpha).
      throw new Error(
        "Cloudflare plugin: the PayGo billable-usage API (v1 alpha) is not available " +
          "for this account — Cloudflare currently restricts it to select self-serve " +
          `accounts. (${formatCloudflareError(err)})`,
      );
    }
    throw new Error(formatCloudflareError(err), { cause: err });
  }

  // Aggregate per (date, service, zone, currency): an account can hold several
  // subscriptions of the same service whose charge periods start on the same
  // day, and those must collapse into one stable dimension key.
  const buckets = new Map<string, CostRow>();
  for (const item of result ?? []) {
    const amount = item.ContractedCost;
    if (!Number.isFinite(amount) || amount === 0) continue;
    const date = (item.ChargePeriodStart ?? "").slice(0, 10);
    // Keep only periods starting inside the requested chunk so month-aligned
    // chunks never write overlapping rows for the same charge period.
    if (!date || date < range.fromDate || date > range.toDate) continue;

    // The alpha response documents optional ZoneName/ZoneId fields the SDK
    // types don't carry yet — read them defensively.
    const extra = item as unknown as Record<string, unknown>;
    const zoneName = typeof extra["ZoneName"] === "string" ? (extra["ZoneName"] as string) : "";

    const service = item.ServiceName ?? "";
    const currency = item.BillingCurrency || "USD";
    const key = `${date}|${service}|${zoneName}|${currency}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.amount += amount;
      // Consumed quantities only stay meaningful while every merged record
      // shares a unit; otherwise drop them and keep the money.
      if (existing.usageUnit === item.ConsumedUnit && Number.isFinite(item.ConsumedQuantity)) {
        existing.usageAmount = (existing.usageAmount ?? 0) + item.ConsumedQuantity;
      } else {
        delete existing.usageAmount;
        delete existing.usageUnit;
      }
    } else {
      buckets.set(key, {
        date,
        service,
        ...(zoneName ? { tags: { zone: zoneName } } : {}),
        currency,
        amount,
        ...(Number.isFinite(item.ConsumedQuantity) && item.ConsumedUnit
          ? { usageAmount: item.ConsumedQuantity, usageUnit: item.ConsumedUnit }
          : {}),
      });
    }
  }
  return [...buckets.values()].filter((row) => row.amount !== 0);
}
