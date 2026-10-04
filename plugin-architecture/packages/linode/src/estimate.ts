/**
 * Forward-looking monthly prices for create forms, edit modals and detail
 * headers. Field keys are the create form's; stored fields use the same keys
 * (the listers write `type`, `region`, `sizeGb`, ...) so existing resources
 * price through the same path. Every rate is from the live catalog in
 * `pricing.ts`, regional where Linode publishes a regional price.
 */

import type { CostEstimate, CostEstimateLineItem } from "@infrawrench/plugin-base";
import { buildCostEstimate } from "@infrawrench/plugin-base";
import {
  type PriceCatalog,
  backupsPrice,
  databasePrice,
  findLinodeType,
  monthlyOf,
  regionalPrice,
  simpleType,
} from "./pricing.js";

const truthy = (v: string | undefined) => v === "true" || v === "1" || v === "yes";
const int = (v: string | undefined, d: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : d;
};

function planLine(
  catalog: PriceCatalog,
  typeId: string | undefined,
  region: string | undefined,
  count = 1,
): CostEstimateLineItem | null {
  const t = findLinodeType(catalog, typeId);
  const monthly = monthlyOf(regionalPrice(t, region));
  if (!t || monthly == null) return null;
  const label = t.label ?? t.id;
  return {
    label: count === 1 ? `Linode ${label}` : `${count} × ${label}`,
    monthlyAmount: monthly * count,
    ...(count > 1
      ? { quantity: count, unit: "nodes", detail: `${count} × $${monthly.toFixed(2)}/month` }
      : {}),
  };
}

export function estimateFromCatalog(
  catalog: PriceCatalog,
  typeId: string,
  fields: Record<string, string>,
): CostEstimate | null {
  const region = fields["region"] || undefined;
  switch (typeId) {
    case "linode": {
      const t = findLinodeType(catalog, fields["type"]);
      const backups = truthy(fields["backupsEnabled"]) ? monthlyOf(backupsPrice(t, region)) : null;
      return buildCostEstimate(
        [
          planLine(catalog, fields["type"], region),
          backups != null ? { label: "Backups add-on", monthlyAmount: backups } : null,
        ],
        {
          notes: [
            "Linode bills hourly up to this monthly cap, and keeps billing while powered off. Transfer beyond the pool is extra.",
          ],
        },
      );
    }
    case "volume": {
      const size = int(fields["sizeGb"], 20);
      const perGb = monthlyOf(regionalPrice(simpleType(catalog.volumeTypes, "volume"), region));
      if (perGb == null) return null;
      return buildCostEstimate([
        {
          label: `Block Storage (${size} GB)`,
          monthlyAmount: perGb * size,
          quantity: size,
          unit: "GB",
          detail: `${size} GB × $${perGb.toFixed(2)}/GB`,
        },
      ]);
    }
    case "nodebalancer": {
      const monthly = monthlyOf(
        regionalPrice(simpleType(catalog.nodeBalancerTypes, "nodebalancer"), region),
      );
      if (monthly == null) return null;
      return buildCostEstimate([{ label: "NodeBalancer", monthlyAmount: monthly }]);
    }
    case "lke-cluster": {
      const count = int(fields["nodeCount"], 3);
      const ha = truthy(fields["highAvailability"]);
      const haPrice = ha
        ? monthlyOf(regionalPrice(simpleType(catalog.lkeTypes, "lke-ha"), region))
        : null;
      return buildCostEstimate(
        [
          planLine(catalog, fields["nodeType"], region, count),
          haPrice != null ? { label: "HA control plane", monthlyAmount: haPrice } : null,
        ],
        {
          notes: [
            "The standard control plane is free; node pools you add later are billed on top.",
          ],
        },
      );
    }
    case "lke-node-pool":
      return buildCostEstimate([
        planLine(catalog, fields["type"], region, int(fields["count"], 3)),
      ]);
    case "database": {
      const engine = (fields["engineVersion"] ?? fields["engine"] ?? "").split("/")[0];
      const size = int(fields["clusterSize"], 1);
      const monthly = monthlyOf(databasePrice(catalog, fields["type"], engine, size));
      if (monthly == null) return null;
      return buildCostEstimate([
        {
          label: size === 1 ? "Managed Database (1 node)" : `Managed Database (${size} nodes)`,
          monthlyAmount: monthly,
          quantity: size,
          unit: "nodes",
        },
      ]);
    }
    case "bucket": {
      const base = monthlyOf(
        regionalPrice(simpleType(catalog.objectStorageTypes, "objectstorage"), region),
      );
      if (base == null) return null;
      return buildCostEstimate([{ label: "Object Storage subscription", monthlyAmount: base }], {
        partial: true,
        notes: [
          "One subscription covers every bucket on the account; storage and transfer beyond the included amount are extra.",
        ],
      });
    }
    case "reserved-ip": {
      const monthly = monthlyOf(
        regionalPrice(simpleType(catalog.reservedIpTypes, "reserved-ipv4"), region),
      );
      if (monthly == null) return null;
      return buildCostEstimate([{ label: "Reserved IPv4", monthlyAmount: monthly }], {
        notes: ["Billed whether or not the address is assigned."],
      });
    }
    default:
      return null;
  }
}

/** Regional monthly prices for the plan picker. */
export function sizePricing(
  catalog: PriceCatalog,
  regionId: string | undefined,
  sizeIds: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of sizeIds) {
    const t = findLinodeType(catalog, id);
    const monthly = monthlyOf(regionalPrice(t, regionId));
    if (monthly != null) out[id] = monthly;
  }
  return out;
}
