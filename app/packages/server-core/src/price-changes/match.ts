/**
 * The pure half of the detector: warehouse price moves in, the org's changes
 * out. Kept free of the database and the network so the matching rules are
 * tested directly.
 */
import {
  priceChangeKey,
  priceChangeMonthlyImpact,
  PRICE_CHANGE_LOOKBACK_DAYS,
} from "@infrawrench/client-core";
import { INSTANCE_PRICING_DIMENSIONS, type InstancePricingUsage } from "@infrawrench/plugin-base";
import type { StoredPriceChangeResource } from "../db/price-change-schema";
import type { WarehouseRow } from "./warehouse";

/** One price move for one product, as the warehouse query returns it. */
export interface PriceMove {
  instanceType: string;
  region: string;
  /** The product's dimension columns, `''` where the row leaves one unset. */
  dimensions: Record<string, string>;
  variant: Record<string, string>;
  oldUsd: number;
  newUsd: number;
  effectiveAt: Date;
}

/** One resource's billed instance type, with who owns it. */
export interface UsageEntry {
  resourceId: string;
  pluginId: string;
  accountId: string;
  usage: InstancePricingUsage;
}

/** A change for the org, before it is stored. */
export interface DetectedPriceChange {
  changeKey: string;
  pluginId: string;
  platform: string;
  instanceType: string;
  region: string;
  selection: Record<string, string>;
  oldHourlyUsd: number;
  newHourlyUsd: number;
  effectiveAt: Date;
  units: number;
  approximate: boolean;
  monthlyImpactUsd: number;
  resources: StoredPriceChangeResource[];
}

const VARIANT_KEY = /^variant\.(.+)$/;

/** A warehouse row as a move; null for a row missing a figure. */
export function parsePriceMove(row: WarehouseRow): PriceMove | null {
  const oldUsd = Number(row["old_usd"]);
  const newUsd = Number(row["new_usd"]);
  const at = Number(row["effective_at"]);
  if (!(oldUsd > 0) || !(newUsd > 0) || !Number.isFinite(at)) return null;
  const dimensions: Record<string, string> = {};
  for (const d of INSTANCE_PRICING_DIMENSIONS) dimensions[d] = String(row[d] ?? "");
  const raw: unknown = row["variant"];
  const variant: Record<string, string> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw)) variant[k] = String(v ?? "");
  }
  return {
    instanceType: String(row["instance_type"] ?? ""),
    region: String(row["region"] ?? ""),
    dimensions,
    variant,
    oldUsd,
    newUsd,
    effectiveAt: new Date(at * 1000),
  };
}

/**
 * Whether a move is of the variant a resource runs. A dimension the row
 * leaves unset matches anything (EC2's spot rows have no tenancy), the rule
 * the pricing panel's SQL uses; a key that is neither a dimension column nor
 * `variant.<key>` is ignored.
 */
export function moveMatchesSelection(
  move: PriceMove,
  selection: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!selection) return true;
  return Object.entries(selection).every(([key, value]) => {
    const variantKey = VARIANT_KEY.exec(key)?.[1];
    const own =
      variantKey !== undefined
        ? (move.variant[variantKey] ?? "")
        : key in move.dimensions
          ? move.dimensions[key]
          : undefined;
    return own === undefined || own === "" || own === value;
  });
}

/** Earliest instant a scan reads from. */
export function lookbackStart(now: Date): Date {
  return new Date(now.getTime() - PRICE_CHANGE_LOOKBACK_DAYS * 86_400_000);
}

/**
 * Match moves against the org's usage and fold them into one change per
 * product and instant. When several products match one resource at the same
 * instant (a dimension the resource does not pin), the cheapest new price is
 * taken, as the pricing panel quotes the cheapest matching row.
 */
export function matchPriceMoves(
  moves: readonly PriceMove[],
  entries: readonly UsageEntry[],
): DetectedPriceChange[] {
  const byTypeRegion = new Map<string, PriceMove[]>();
  for (const m of moves) {
    const k = `${m.instanceType}\u0000${m.region}`;
    const list = byTypeRegion.get(k);
    if (list) list.push(m);
    else byTypeRegion.set(k, [m]);
  }

  const changes = new Map<string, DetectedPriceChange>();
  for (const entry of entries) {
    const { usage } = entry;
    const candidates = byTypeRegion.get(`${usage.instanceType}\u0000${usage.region}`) ?? [];
    const best = new Map<number, PriceMove>();
    for (const m of candidates) {
      if (!moveMatchesSelection(m, usage.selection)) continue;
      const at = m.effectiveAt.getTime();
      const held = best.get(at);
      if (!held || m.newUsd < held.newUsd) best.set(at, m);
    }
    for (const move of best.values()) {
      const selection = { ...usage.selection };
      const changeKey = priceChangeKey({
        platform: usage.platform,
        instanceType: usage.instanceType,
        region: usage.region,
        selection,
        effectiveAt: move.effectiveAt,
      });
      const resource: StoredPriceChangeResource = {
        resourceId: entry.resourceId,
        accountId: entry.accountId,
        units: usage.units,
        approximate: usage.approximate === true,
      };
      const held = changes.get(changeKey);
      if (held) {
        // One resource can list a type twice (a cluster); count it once per entry.
        held.units += usage.units;
        held.approximate ||= resource.approximate;
        held.resources.push(resource);
        held.monthlyImpactUsd = priceChangeMonthlyImpact(
          held.oldHourlyUsd,
          held.newHourlyUsd,
          held.units,
        );
        continue;
      }
      changes.set(changeKey, {
        changeKey,
        pluginId: entry.pluginId,
        platform: usage.platform,
        instanceType: usage.instanceType,
        region: usage.region,
        selection,
        oldHourlyUsd: move.oldUsd,
        newHourlyUsd: move.newUsd,
        effectiveAt: move.effectiveAt,
        units: usage.units,
        approximate: resource.approximate,
        monthlyImpactUsd: priceChangeMonthlyImpact(move.oldUsd, move.newUsd, usage.units),
        resources: [resource],
      });
    }
  }
  return [...changes.values()];
}

/** Platform to the instance types and regions its entries need, for batching queries. */
export function usageByPlatform(
  entries: readonly UsageEntry[],
): Map<string, { types: Set<string>; regions: Set<string> }> {
  const out = new Map<string, { types: Set<string>; regions: Set<string> }>();
  for (const { usage } of entries) {
    let p = out.get(usage.platform);
    if (!p) {
      p = { types: new Set(), regions: new Set() };
      out.set(usage.platform, p);
    }
    p.types.add(usage.instanceType);
    p.regions.add(usage.region);
  }
  return out;
}
