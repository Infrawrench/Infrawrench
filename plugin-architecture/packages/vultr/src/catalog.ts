/**
 * Plan catalog: `GET /v2/plans?type=all` (public, no key needed) carries
 * every instance plan with `monthly_cost`, `hourly_cost`, the regions it can
 * deploy in, and `location_cost` overrides for regions that cost more (São
 * Paulo, for instance). The same catalog feeds the create form's size
 * picker, the size-picker pricing, `estimateCost`, VKE node pools and the
 * resize prompt. Cached per client for six hours.
 */

import type { SizeOption } from "@infrawrench/plugin-base";
import type { VultrApi } from "./api.js";
import type { VultrPlan } from "./types.js";

const TTL_MS = 6 * 60 * 60 * 1000;

/** Plan type prefixes as Vultr's control panel names them. */
const PLAN_FAMILIES: Record<string, string> = {
  vc2: "Cloud Compute (Regular)",
  vhf: "Cloud Compute (High Frequency)",
  vhp: "Cloud Compute (High Performance)",
  voc: "Optimized Cloud Compute",
  vx1: "VX1 Cloud Compute",
  vcg: "Cloud GPU",
  vdc: "Dedicated Cloud",
  vdm: "Dedicated Cloud",
};

export function planCategory(plan: VultrPlan): string {
  const type = (plan.type ?? plan.id.split("-")[0] ?? "").toLowerCase();
  return PLAN_FAMILIES[type] ?? type.toUpperCase();
}

export interface PlanCatalogCache {
  get(): Promise<VultrPlan[]>;
}

export function createPlanCatalog(api: VultrApi): PlanCatalogCache {
  let cached: { at: number; plans: VultrPlan[] } | null = null;
  let inflight: Promise<VultrPlan[]> | null = null;
  return {
    async get() {
      if (cached && Date.now() - cached.at < TTL_MS) return cached.plans;
      if (inflight) return inflight;
      inflight = api
        .all<VultrPlan>("/plans", "plans", { type: "all" })
        .then((plans) => {
          cached = { at: Date.now(), plans };
          return plans;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/** Monthly price of a plan in a region, honouring `location_cost` overrides. */
export function planMonthly(plan: VultrPlan, region?: string): number | undefined {
  const override = region ? plan.location_cost?.[region]?.monthly_cost : undefined;
  const value = override ?? plan.monthly_cost;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function planSizeOption(plan: VultrPlan, region?: string): SizeOption {
  const price = planMonthly(plan, region);
  return {
    id: plan.id,
    label: plan.gpu_type ? `${plan.id} (${plan.gpu_type})` : plan.id,
    vcpus: plan.vcpu_count ?? 0,
    memoryMb: plan.ram ?? 0,
    diskGb: plan.disk ?? 0,
    category: planCategory(plan),
    ...(price !== undefined ? { priceMonthly: price } : {}),
    ...(plan.locations?.length ? { availableFor: plan.locations } : {}),
  };
}

/** Size options for the instance form; free and zero-price legacy plans are dropped. */
export function instanceSizeOptions(
  plans: VultrPlan[],
  opts: { excludeGpu?: boolean } = {},
): SizeOption[] {
  return plans
    .filter((p) => (p.locations?.length ?? 0) > 0 && (p.monthly_cost ?? 0) > 0)
    .filter((p) => !(opts.excludeGpu && (p.type === "vcg" || (p.gpu_vram_gb ?? 0) > 0)))
    .map((p) => planSizeOption(p));
}

/** Regional monthly prices for the size picker. */
export function sizePricing(
  plans: VultrPlan[],
  region: string | undefined,
  ids: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const wanted = new Set(ids);
  for (const p of plans) {
    if (!wanted.has(p.id)) continue;
    const price = planMonthly(p, region);
    if (price !== undefined) out[p.id] = price;
  }
  return out;
}
