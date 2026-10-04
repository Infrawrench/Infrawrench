import { HOURS_PER_MONTH, LIST_PRICES, instanceSpec } from "./catalog.js";

/**
 * Where a CoreWeave price comes from.
 *
 * CoreWeave meters usage but never prices it through an API, and most GPU
 * capacity is bought on contract, so two sources are combined:
 *
 *  1. **Negotiated rates** the user typed into the account's optional
 *     "Negotiated rates" credential, which win wherever they are present;
 *  2. **Published on-demand list prices** from {@link instanceSpec}.
 *
 * The negotiated form is a forgiving `key=value` list, comma or newline
 * separated, the same shape the Kubernetes plugin's "Node hourly rates"
 * field takes:
 *
 *     gd-8xh100ib-i128=35.50, reserved/gb200-4x=30
 *     spot/gd-8xh100ib-i128=19.90
 *     storage=0.06, objectStorage=0.05, ip=4
 *
 * A bare instance type is a USD price per **instance-hour** (what the pricing
 * page quotes, not per GPU). A `plan/` prefix limits it to one capacity plan
 * (`on-demand`, `reserved`, `spot`, `flex`). `storage` is USD per GB-month of
 * Distributed File Storage, `objectStorage` the same for AI Object Storage,
 * and `ip` USD per public IP per month.
 */

export type CapacityPlan = "on-demand" | "reserved" | "spot" | "flex";
export type RateSource = "negotiated" | "list" | "unpriced";

export interface NegotiatedRates {
  instance: Record<string, number>;
  byPlan: Record<CapacityPlan, Record<string, number>>;
  storageGbMonth?: number;
  objectGbMonth?: number;
  ipMonth?: number;
}

export interface PricedRate {
  /** USD per unit of the quantity it was asked for. */
  rate: number;
  source: RateSource;
}

const PLANS: CapacityPlan[] = ["on-demand", "reserved", "spot", "flex"];

function emptyRates(): NegotiatedRates {
  return { instance: {}, byPlan: { "on-demand": {}, reserved: {}, spot: {}, flex: {} } };
}

function coerce(raw: string): number | undefined {
  const n = Number(raw.trim().replace(/^\$/, ""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseNegotiatedRates(raw: string | undefined | null): NegotiatedRates {
  const out = emptyRates();
  const text = (raw ?? "").trim();
  if (!text) return out;
  for (const entry of text.split(/[,\n]/)) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const key = entry.slice(0, eq).trim();
    const value = coerce(entry.slice(eq + 1));
    if (!key || value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "storage") out.storageGbMonth = value;
    else if (lower === "objectstorage") out.objectGbMonth = value;
    else if (lower === "ip") out.ipMonth = value;
    else {
      const slash = key.indexOf("/");
      if (slash > 0) {
        const plan = normalisePlan(key.slice(0, slash));
        const sku = key.slice(slash + 1).trim();
        if (plan && sku) out.byPlan[plan][sku] = value;
      } else {
        out.instance[key] = value;
      }
    }
  }
  return out;
}

/** Map FOCUS `x_CapacityPlan` (or a user-typed plan) onto our four plans. */
export function normalisePlan(raw: string | null | undefined): CapacityPlan | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return undefined;
  if (v === "on-demand" || v === "ondemand" || v === "standard") return "on-demand";
  if (v.startsWith("reserv") || v === "committed") return "reserved";
  if (v === "spot" || v === "dynamic") return "spot";
  if (v.startsWith("flex")) return "flex";
  return undefined;
}

export function hasNegotiatedRates(rates: NegotiatedRates): boolean {
  return (
    Object.keys(rates.instance).length > 0 ||
    PLANS.some((p) => Object.keys(rates.byPlan[p]).length > 0) ||
    rates.storageGbMonth !== undefined ||
    rates.objectGbMonth !== undefined ||
    rates.ipMonth !== undefined
  );
}

/** USD per instance-hour for an instance type on a plan. */
export function instanceHourRate(
  rates: NegotiatedRates,
  sku: string,
  plan?: CapacityPlan,
): PricedRate {
  const planned = plan ? rates.byPlan[plan][sku] : undefined;
  if (planned !== undefined) return { rate: planned, source: "negotiated" };
  const flat = rates.instance[sku];
  if (flat !== undefined) return { rate: flat, source: "negotiated" };
  const list = instanceSpec(sku)?.hourlyUsd;
  if (typeof list === "number") return { rate: list, source: "list" };
  return { rate: 0, source: "unpriced" };
}

const GIB_IN_GB = 1.073741824;

/**
 * USD per unit of a FOCUS `PricingUnit` for one usage row. Units come from
 * CoreWeave's SKU metadata: `GPU-Hour`, `Instance-Hour`, `GiB-Hour` and
 * `IP-Hour` are the four the export documents. An unknown unit is unpriced
 * rather than guessed.
 */
export function rateForUsage(
  rates: NegotiatedRates,
  row: { sku: string; unit: string; service: string; plan?: CapacityPlan | undefined },
): PricedRate {
  const unit = row.unit.toLowerCase().replace(/[\s_]/g, "-");
  if (unit === "instance-hour" || unit === "instance-hours" || unit === "node-hour") {
    return instanceHourRate(rates, row.sku, row.plan);
  }
  if (unit === "gpu-hour" || unit === "gpu-hours") {
    const perInstance = instanceHourRate(rates, row.sku, row.plan);
    const gpus = instanceSpec(row.sku)?.gpuCount ?? 0;
    if (perInstance.source === "unpriced" || gpus <= 0) return { rate: 0, source: "unpriced" };
    return { rate: perInstance.rate / gpus, source: perInstance.source };
  }
  if (unit === "gib-hour" || unit === "gib-hours") {
    const object = /object/i.test(row.service) || /object|caios/i.test(row.sku);
    const negotiated = object ? rates.objectGbMonth : rates.storageGbMonth;
    const perGbMonth =
      negotiated ?? (object ? LIST_PRICES.objectHotGbMonth : LIST_PRICES.dfsGbMonth);
    return {
      rate: (perGbMonth * GIB_IN_GB) / HOURS_PER_MONTH,
      source: negotiated !== undefined ? "negotiated" : "list",
    };
  }
  if (unit === "ip-hour" || unit === "ip-hours" || unit === "address-hour") {
    const perMonth = rates.ipMonth ?? LIST_PRICES.publicIpMonth;
    return {
      rate: perMonth / HOURS_PER_MONTH,
      source: rates.ipMonth !== undefined ? "negotiated" : "list",
    };
  }
  return { rate: 0, source: "unpriced" };
}

/**
 * The `nodeHourlyRates` payload handed to the Kubernetes peer, in the JSON
 * shape `plugin-kubernetes/src/node-rates.ts` parses. Covers every instance
 * type a negotiated or list price exists for; `source` says `manual` when the
 * user's rates are in play, `list-price` otherwise. Storage classes are left
 * out: CKS storage classes are not documented by name, and a wrong mapping
 * would price the wrong volumes.
 */
export function nodeHourlyRatesJson(rates: NegotiatedRates, instanceTypes: string[]): string {
  const byInstanceType: Record<string, number> = {};
  let negotiated = false;
  for (const sku of new Set(instanceTypes)) {
    const priced = instanceHourRate(rates, sku, "on-demand");
    if (priced.source === "unpriced") continue;
    if (priced.source === "negotiated") negotiated = true;
    byInstanceType[sku] = priced.rate;
  }
  if (Object.keys(byInstanceType).length === 0) return "";
  return JSON.stringify({
    currency: "USD",
    source: negotiated ? "manual" : "list-price",
    byInstanceType,
    byNodeName: {},
  });
}
