import {
  buildCostEstimate,
  type CostEstimate,
  type CostEstimateLineItem,
  type HttpHostServices,
  type SizeOption,
} from "@infrawrench/plugin-base";
import { parseSizeId } from "./listers.js";

/**
 * Live list prices from Oracle's public price list API
 * (https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD,
 * no auth, one unpaginated response of ~650 parts, CORS-enabled for simple
 * GETs). Rates are keyed by part number, never by display name: Oracle
 * renames products (Autonomous Database became "Autonomous AI Database" in
 * 2026) but part numbers are stable.
 *
 * `FALLBACK_RATES` is the same data as fetched on 2026-10-04, used only when
 * the API cannot be reached, so an outage at Oracle degrades an estimate to
 * slightly stale rather than to nothing.
 *
 * Every rate is pay-as-you-go list price in USD. Tiered parts (A1, Object
 * Storage, the load balancer) start with a tenancy-wide free allowance; the
 * rate used here is the paid tier, since a single resource cannot know how
 * much of the shared allowance the rest of the tenancy has used.
 */

export const PRICE_LIST_URL =
  "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD";

/** Oracle's own calculators price a month as 744 hours (31 days). */
export const HOURS_PER_MONTH = 744;

export const FALLBACK_RATES: Record<string, number> = {
  B92306: 0.025, // Compute - Standard - E3 - OCPU
  B92307: 0.0015, // E3 - Memory (GB-hour)
  B93113: 0.025, // E4 - OCPU
  B93114: 0.0015, // E4 - Memory
  B97384: 0.03, // E5 - OCPU
  B97385: 0.002, // E5 - Memory
  B111129: 0.03, // E6 - OCPU
  B111130: 0.002, // E6 - Memory
  B90425: 0.03, // E2 (OCPU, memory included)
  B94176: 0.04, // Standard - X9 (VM.Standard3) - OCPU
  B94177: 0.0015, // X9 - Memory
  B93311: 0.054, // Optimized - X9 (VM.Optimized3) - OCPU
  B93312: 0.0015, // Optimized X9 - Memory
  B93297: 0.01, // A1 - OCPU (after the free tier)
  B93298: 0.0015, // A1 - Memory
  B109529: 0.014, // A2 - OCPU
  B109530: 0.002, // A2 - Memory
  B112145: 0.0138, // A4 - OCPU
  B112146: 0.0027, // A4 - Memory
  B88514: 0.0638, // VM.Standard2 (X7) - OCPU, memory included
  B91961: 0.0255, // Block Volume - Storage (GB-month)
  B91962: 0.0017, // Block Volume - Performance Units (VPU per GB-month)
  B91628: 0.0255, // Object Storage - Standard (GB-month)
  B93000: 0.01, // Infrequent Access Storage (GB-month)
  B91633: 0.0026, // Archive Storage (GB-month)
  B93030: 0.0113, // Load Balancer Base (hour)
  B93031: 0.0001, // Load Balancer Bandwidth (Mbps-hour)
  B95702: 0.336, // Autonomous Transaction Processing - ECPU
  B95704: 0.0807, // ATP - ECPU - BYOL
  B95701: 0.336, // Autonomous Lakehouse (Data Warehouse) - ECPU
  B95703: 0.0807, // Lakehouse - ECPU - BYOL
  B99708: 0.0807, // Autonomous JSON Database - ECPU
  B95754: 0.0299, // Autonomous Database Storage (GB-month)
  B95706: 0.1953, // Autonomous Database Storage for Transaction Processing (GB-month)
  B96545: 0.1, // OKE Enhanced Cluster (cluster-hour)
};

interface PriceListItem {
  partNumber: string;
  currencyCodeLocalizations?: Array<{
    currencyCode: string;
    prices?: Array<{ model?: string; value: number; rangeMin?: number }>;
  }>;
}

const CACHE_MS = 6 * 3_600_000;
let cache: { at: number; rates: Promise<Record<string, number>> } | null = null;

/** The paid pay-as-you-go rate of one item: its highest tier. */
export function paidRate(item: PriceListItem): number | undefined {
  const prices = item.currencyCodeLocalizations?.find((c) => c.currencyCode === "USD")?.prices;
  if (!prices || prices.length === 0) return undefined;
  const payg = prices.filter((p) => !p.model || p.model === "PAY_AS_YOU_GO");
  const top = [...payg].sort((a, b) => (b.rangeMin ?? 0) - (a.rangeMin ?? 0))[0];
  return top && Number.isFinite(top.value) ? top.value : undefined;
}

/** Fetch (and cache for six hours) the USD rate card. Never throws. */
export function priceRates(http?: HttpHostServices): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rates;
  const rates = (async () => {
    try {
      let body: string;
      if (http) {
        const res = await http.request({ url: PRICE_LIST_URL, method: "GET", headers: {} });
        if (res.status < 200 || res.status >= 300) throw new Error(String(res.status));
        body = res.body;
      } else {
        const res = await fetch(PRICE_LIST_URL);
        if (!res.ok) throw new Error(String(res.status));
        body = await res.text();
      }
      const parsed = JSON.parse(body) as { items?: PriceListItem[] };
      const out: Record<string, number> = { ...FALLBACK_RATES };
      for (const item of parsed.items ?? []) {
        const rate = paidRate(item);
        if (rate !== undefined) out[item.partNumber] = rate;
      }
      return out;
    } catch {
      // Retry sooner than six hours when the live list could not be read.
      if (cache) cache.at = Date.now() - CACHE_MS + 600_000;
      return { ...FALLBACK_RATES };
    }
  })();
  cache = { at: Date.now(), rates };
  return rates;
}

/** For tests. */
export function resetPriceCache(): void {
  cache = null;
}

interface ShapeParts {
  ocpu: string;
  /** Absent when memory is bundled into the OCPU price (Standard2, E2). */
  memory?: string;
  /** vCPUs per OCPU: 2 on x86, A2 and A4; 1 on A1. */
  vcpusPerOcpu: number;
}

/** Shape name → price list parts (verified against the live list, 2026-10). */
export function shapeParts(shape: string): ShapeParts | null {
  const s = shape.toUpperCase();
  if (s.includes("E2.1.MICRO")) return null; // Always Free
  if (/\.E6\.(?!AX)/.test(s) || /\.E6\.FLEX$/.test(s))
    return { ocpu: "B111129", memory: "B111130", vcpusPerOcpu: 2 };
  if (s.includes(".E5.")) return { ocpu: "B97384", memory: "B97385", vcpusPerOcpu: 2 };
  if (s.includes(".E4.")) return { ocpu: "B93113", memory: "B93114", vcpusPerOcpu: 2 };
  if (s.includes(".E3.")) return { ocpu: "B92306", memory: "B92307", vcpusPerOcpu: 2 };
  if (/\.E2\.\d/.test(s)) return { ocpu: "B90425", vcpusPerOcpu: 2 };
  if (s.includes(".A1.")) return { ocpu: "B93297", memory: "B93298", vcpusPerOcpu: 1 };
  if (s.includes(".A2.")) return { ocpu: "B109529", memory: "B109530", vcpusPerOcpu: 2 };
  if (/\.A4\.(?!AX)/.test(s) || /\.A4\.FLEX$/.test(s))
    return { ocpu: "B112145", memory: "B112146", vcpusPerOcpu: 2 };
  if (s.startsWith("VM.STANDARD3.")) return { ocpu: "B94176", memory: "B94177", vcpusPerOcpu: 2 };
  if (s.startsWith("VM.OPTIMIZED3.")) return { ocpu: "B93311", memory: "B93312", vcpusPerOcpu: 2 };
  if (/^(VM|BM)\.STANDARD2\./.test(s)) return { ocpu: "B88514", vcpusPerOcpu: 2 };
  return null;
}

export function vcpusPerOcpu(shape: string): number {
  return shapeParts(shape)?.vcpusPerOcpu ?? (/\.A1\./i.test(shape) ? 1 : 2);
}

/** Monthly compute price for a shape configuration, or undefined when unpriced. */
export function instanceMonthly(
  rates: Record<string, number>,
  shape: string,
  ocpus: number,
  memoryGb: number,
): { amount: number; items: CostEstimateLineItem[] } | undefined {
  const parts = shapeParts(shape);
  if (!parts) return undefined;
  const ocpuRate = rates[parts.ocpu];
  if (ocpuRate === undefined) return undefined;
  const items: CostEstimateLineItem[] = [
    {
      label: `Compute (${shape})`,
      monthlyAmount: ocpus * ocpuRate * HOURS_PER_MONTH,
      detail: `${ocpus} OCPU × ${HOURS_PER_MONTH} h × $${ocpuRate}/OCPU-h`,
      quantity: ocpus,
      unit: "OCPU",
    },
  ];
  if (parts.memory) {
    const memRate = rates[parts.memory];
    if (memRate === undefined) return undefined;
    items.push({
      label: "Memory",
      monthlyAmount: memoryGb * memRate * HOURS_PER_MONTH,
      detail: `${memoryGb} GB × ${HOURS_PER_MONTH} h × $${memRate}/GB-h`,
      quantity: memoryGb,
      unit: "GB",
    });
  }
  return { amount: items.reduce((sum, i) => sum + i.monthlyAmount, 0), items };
}

export interface OciShape {
  shape: string;
  processorDescription?: string;
  ocpus?: number;
  memoryInGBs?: number;
  isFlexible?: boolean;
  ocpuOptions?: { min?: number; max?: number };
  memoryOptions?: { minInGBs?: number; maxInGBs?: number; defaultPerOcpuInGBs?: number };
  billingType?: string;
  gpus?: number;
}

const FLEX_OCPU_STEPS = [1, 2, 4, 8, 16, 32, 64];

/**
 * Size-picker options from `ListShapes`: each fixed shape once, each flex
 * shape at 1/2/4/…/64 OCPUs (inside the shape's range) with OCI's default
 * memory per OCPU. The id format is the instance's `size` field, so the
 * right-sizing host can match a running instance against this catalogue.
 */
export function sizeOptionsFromShapes(
  shapes: OciShape[],
  rates: Record<string, number>,
): SizeOption[] {
  const out: SizeOption[] = [];
  const seen = new Set<string>();
  for (const sh of shapes) {
    if (!sh.shape.startsWith("VM.")) continue;
    if (seen.has(sh.shape)) continue;
    seen.add(sh.shape);
    const category = sh.processorDescription || sh.shape.split(".").slice(0, 3).join(".");
    const perOcpu = vcpusPerOcpu(sh.shape);
    const push = (id: string, label: string, ocpus: number, memoryGb: number) => {
      const price = instanceMonthly(rates, sh.shape, ocpus, memoryGb);
      out.push({
        id,
        label,
        vcpus: Math.max(1, Math.round(ocpus * perOcpu)),
        memoryMb: Math.round(memoryGb * 1024),
        category,
        ...(price ? { priceMonthly: Number(price.amount.toFixed(2)) } : {}),
      });
    };
    if (sh.isFlexible) {
      const min = sh.ocpuOptions?.min ?? 1;
      const max = sh.ocpuOptions?.max ?? 64;
      const perGb = sh.memoryOptions?.defaultPerOcpuInGBs ?? 16;
      for (const ocpus of FLEX_OCPU_STEPS) {
        if (ocpus < min || ocpus > max) continue;
        let mem = ocpus * perGb;
        if (sh.memoryOptions?.maxInGBs !== undefined)
          mem = Math.min(mem, sh.memoryOptions.maxInGBs);
        if (sh.memoryOptions?.minInGBs !== undefined)
          mem = Math.max(mem, sh.memoryOptions.minInGBs);
        push(`${sh.shape}/${ocpus}/${mem}`, `${sh.shape} · ${ocpus} OCPU · ${mem} GB`, ocpus, mem);
      }
    } else if (sh.ocpus !== undefined && sh.memoryInGBs !== undefined) {
      push(sh.shape, sh.shape, sh.ocpus, sh.memoryInGBs);
    }
  }
  return out;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const LIST_PRICE_NOTE =
  "Pay-as-you-go list price in USD; Always Free allowances and negotiated rates not applied.";

function blockVolumeItems(
  rates: Record<string, number>,
  label: string,
  sizeGb: number,
  vpus: number,
): CostEstimateLineItem[] {
  const storage = rates["B91961"] ?? 0;
  const vpu = rates["B91962"] ?? 0;
  const items: CostEstimateLineItem[] = [
    {
      label,
      monthlyAmount: sizeGb * storage,
      detail: `${sizeGb} GB × $${storage}/GB-month`,
      quantity: sizeGb,
      unit: "GB",
    },
  ];
  if (vpus > 0) {
    items.push({
      label: `${label} performance`,
      monthlyAmount: sizeGb * vpus * vpu,
      detail: `${sizeGb} GB × ${vpus} VPU × $${vpu}/VPU-GB-month`,
    });
  }
  return items;
}

/**
 * `estimateCost` for every priced type. `fields` uses create-form keys, with
 * the stored spellings accepted too (`size` for an existing instance,
 * `shape`/`ocpus`/`memoryGb` from the create form).
 */
export function estimateFor(
  rates: Record<string, number>,
  typeId: string,
  fields: Record<string, string>,
): CostEstimate | null {
  const notes = [LIST_PRICE_NOTE];
  switch (typeId) {
    case "instance": {
      let shape = fields["shape"] ?? "";
      let ocpus = num(fields["ocpus"]);
      let memoryGb = num(fields["memoryGb"]);
      if (fields["size"]) {
        const parsed = parseSizeId(fields["size"]);
        shape = parsed.shape;
        ocpus = parsed.ocpus ?? ocpus;
        memoryGb = parsed.memoryGb ?? memoryGb;
      }
      if (!shape || ocpus === undefined || memoryGb === undefined) return null;
      const compute = instanceMonthly(rates, shape, ocpus, memoryGb);
      if (!compute) return null;
      const bootGb = num(fields["bootVolumeSizeGb"]);
      const items = [...compute.items];
      if (bootGb) items.push(...blockVolumeItems(rates, "Boot volume", bootGb, 10));
      return buildCostEstimate(items, {
        notes: [
          ...notes,
          ...(bootGb ? [] : ["Boot volume billed separately as a Boot Volume."]),
          "Excludes outbound data transfer beyond the free 10 TB per month.",
        ],
      });
    }
    case "block-volume":
    case "boot-volume": {
      const sizeGb = num(fields["sizeGb"]);
      if (!sizeGb) return null;
      const vpus = num(fields["vpusPerGb"]) ?? 10;
      return buildCostEstimate(
        blockVolumeItems(
          rates,
          typeId === "boot-volume" ? "Boot volume" : "Block volume",
          sizeGb,
          vpus,
        ),
        { notes },
      );
    }
    case "load-balancer": {
      const base = rates["B93030"];
      const bw = rates["B93031"];
      if (base === undefined || bw === undefined) return null;
      const minMbps = num(fields["minBandwidthMbps"]) ?? 10;
      return buildCostEstimate(
        [
          {
            label: "Load balancer base",
            monthlyAmount: base * HOURS_PER_MONTH,
            detail: `${HOURS_PER_MONTH} h × $${base}/h`,
          },
          {
            label: "Minimum bandwidth",
            monthlyAmount: minMbps * bw * HOURS_PER_MONTH,
            detail: `${minMbps} Mbps × ${HOURS_PER_MONTH} h × $${bw}/Mbps-h`,
          },
        ],
        {
          notes: [
            ...notes,
            "Bandwidth above the minimum is billed by use; the first load balancer at 10 Mbps is Always Free.",
          ],
        },
      );
    }
    case "autonomous-database": {
      if (fields["freeTier"] === "true") return null;
      const workload = (fields["workload"] ?? "OLTP").toUpperCase();
      const byol = (fields["licenseModel"] ?? "").toUpperCase() === "BRING_YOUR_OWN_LICENSE";
      const computeModel = (fields["computeModel"] ?? "ECPU").toUpperCase();
      if (computeModel !== "ECPU") return null;
      const part =
        workload === "AJD"
          ? "B99708"
          : workload === "DW" || workload === "LH"
            ? byol
              ? "B95703"
              : "B95701"
            : byol
              ? "B95704"
              : "B95702";
      const rate = rates[part];
      const ecpus = num(fields["computeCount"]);
      if (rate === undefined || !ecpus) return null;
      const items: CostEstimateLineItem[] = [
        {
          label: "Compute",
          monthlyAmount: ecpus * rate * HOURS_PER_MONTH,
          detail: `${ecpus} ECPU × ${HOURS_PER_MONTH} h × $${rate}/ECPU-h`,
          quantity: ecpus,
          unit: "ECPU",
        },
      ];
      const storageTb = num(fields["storageTb"]);
      const storagePart = workload === "DW" || workload === "LH" ? "B95754" : "B95706";
      const storageRate = rates[storagePart];
      if (storageTb && storageRate !== undefined) {
        items.push({
          label: "Storage",
          monthlyAmount: storageTb * 1024 * storageRate,
          detail: `${storageTb * 1024} GB × $${storageRate}/GB-month`,
          quantity: storageTb * 1024,
          unit: "GB",
        });
      }
      return buildCostEstimate(items, {
        notes: [
          ...notes,
          "Compute stops billing while the database is stopped; storage does not. Auto scaling can bill up to 3× the base ECPUs while busy.",
        ],
      });
    }
    case "bucket": {
      const sizeGb = num(fields["approximateSizeGb"]);
      if (!sizeGb) return null;
      const archive = fields["storageTier"] === "Archive";
      const rate = rates[archive ? "B91633" : "B91628"];
      if (rate === undefined) return null;
      return buildCostEstimate(
        [
          {
            label: archive ? "Archive storage" : "Standard storage",
            monthlyAmount: sizeGb * rate,
            detail: `${sizeGb} GB × $${rate}/GB-month`,
            quantity: sizeGb,
            unit: "GB",
          },
        ],
        {
          notes: [
            ...notes,
            "Excludes requests and retrieval; objects auto-tiered to Infrequent Access cost less.",
          ],
        },
      );
    }
    case "oke-cluster": {
      if (fields["clusterType"] !== "ENHANCED_CLUSTER") return null;
      const rate = rates["B96545"];
      if (rate === undefined) return null;
      return buildCostEstimate(
        [
          {
            label: "Enhanced cluster",
            monthlyAmount: rate * HOURS_PER_MONTH,
            detail: `${HOURS_PER_MONTH} h × $${rate}/cluster-h`,
          },
        ],
        { notes: [...notes, "Worker nodes are billed as Compute instances."] },
      );
    }
    case "node-pool": {
      const shape = fields["nodeShape"] ?? "";
      const ocpus = num(fields["ocpus"]);
      const memoryGb = num(fields["memoryGb"]);
      const count = num(fields["nodeCount"]);
      if (!shape || ocpus === undefined || memoryGb === undefined || !count) return null;
      const node = instanceMonthly(rates, shape, ocpus, memoryGb);
      if (!node) return null;
      return buildCostEstimate(
        [
          {
            label: `${count} × ${shape} nodes`,
            monthlyAmount: node.amount * count,
            detail: `${count} nodes × $${node.amount.toFixed(2)}`,
            quantity: count,
            unit: "nodes",
          },
        ],
        { notes: [...notes, "Node boot volumes are billed separately."] },
      );
    }
    default:
      return null;
  }
}
