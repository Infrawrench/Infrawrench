import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { enc, sbFetch } from "./api.js";
import type { SbAddons, SbProject } from "./types.js";

/**
 * Estimated daily spend from the billing add-ons each project runs.
 *
 * Supabase publishes no billing, invoice or usage-cost API for organizations
 * (verified against the Management API OpenAPI document, 2026-10): the only
 * money in it is `GET /v1/projects/{ref}/billing/addons`, which lists the
 * add-ons a project has selected (compute size, PITR, IPv4, custom domain,
 * log drains…) with their list price and whether it is hourly or monthly.
 *
 * So this prices today's add-on inventory at list and nothing else: it omits
 * the organization's plan fee, the compute credit that offsets the first
 * instance, and every usage line (egress, storage, MAUs, function
 * invocations). The manifest declares `estimated: true` so the number is
 * labelled before it is trusted, and rows are only emitted for the day the
 * pass runs, because a past day rebuilt from today's inventory would include
 * projects that did not exist then and miss ones deleted since.
 */
export async function fetchSupabaseCostData(
  ctx: SupabaseContext,
  projects: SbProject[],
  range: CostFetchRange,
  now: Date = new Date(),
): Promise<CostRow[]> {
  const today = now.toISOString().slice(0, 10);
  if (today < range.fromDate || today > range.toDate) return [];
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();

  const rows: CostRow[] = [];
  for (const project of projects) {
    // Paused projects run no compute and are not billed for it.
    if (project.status === "INACTIVE") continue;
    const addons = await sbFetch<SbAddons>(
      ctx,
      "GET",
      `/v1/projects/${enc(project.ref)}/billing/addons`,
    );
    for (const addon of addons?.selected_addons ?? []) {
      const price = addon.variant.price;
      if (!price || price.type !== "fixed" || !Number.isFinite(price.amount)) continue;
      const amount = price.interval === "hourly" ? price.amount * 24 : price.amount / daysInMonth;
      if (amount <= 0) continue;
      rows.push({
        date: today,
        service: addonService(addon.type),
        region: project.region,
        resourceId: project.ref,
        tags: {
          project: project.name,
          organization: project.organization_slug,
          variant: addon.variant.name,
        },
        currency: "USD",
        amount: Math.round(amount * 1e6) / 1e6,
      });
    }
  }
  return rows;
}

const ADDON_NAMES: Record<string, string> = {
  compute_instance: "Compute",
  pitr: "Point-in-Time Recovery",
  ipv4: "Dedicated IPv4",
  custom_domain: "Custom Domain",
  auth_mfa_phone: "Auth MFA (Phone)",
  auth_mfa_web_authn: "Auth MFA (WebAuthn)",
  log_drain: "Log Drains",
  etl_pipeline: "ETL Pipelines",
};

export function addonService(type: string): string {
  return ADDON_NAMES[type] ?? type;
}
