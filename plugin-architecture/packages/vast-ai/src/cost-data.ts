import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { isStatus, type VastApi } from "./api.js";
import type { VChargeEntry } from "./types.js";

/**
 * Billed spend from `GET /api/v0/charges/` (the console's Billing page and
 * `vastai show invoices-v1 --charges`; verified 2026-10). One row per
 * contract (instance or volume) for the requested `day` range, each broken
 * into items (`gpu`, `disk`, `bwd`, `bwu`) with their own `start`/`end` (unix
 * seconds) and `amount` (USD).
 *
 * Items are not bucketed by day, so each item's amount is spread over the
 * UTC days its `[start, end]` covers, in proportion to the time in each, and
 * days outside the requested range are dropped. GPU and disk accrue at a
 * fixed hourly rate, which is what makes that allocation faithful; bandwidth
 * is spread the same way for lack of anything better.
 */

export const BILLING_URL = "https://cloud.vast.ai/billing/";
const DAY = 86_400;

const SERVICES: Record<string, string> = {
  gpu: "GPU",
  disk: "Storage",
  bwd: "Bandwidth (download)",
  bwu: "Bandwidth (upload)",
};

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

function dayOf(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/** Split `amount` over the UTC days `[start, end]` overlaps, by time share. */
export function spreadByDay(start: number, end: number, amount: number): Array<[string, number]> {
  if (!Number.isFinite(start) || !Number.isFinite(amount)) return [];
  if (!Number.isFinite(end) || end <= start) return [[dayOf(start), amount]];
  const out: Array<[string, number]> = [];
  const total = end - start;
  let cursor = start;
  while (cursor < end && out.length < 1000) {
    const nextMidnight = (Math.floor(cursor / DAY) + 1) * DAY;
    const sliceEnd = Math.min(end, nextMidnight);
    out.push([dayOf(cursor), (amount * (sliceEnd - cursor)) / total]);
    cursor = sliceEnd;
  }
  return out;
}

/** `instance-123` → `{type: "instance", id: "123"}`. */
export function parseSource(source: string | null | undefined): { type: string; id: string } {
  const m = /^([a-z_]+)-(\d+)$/.exec(source ?? "");
  return m ? { type: m[1]!, id: m[2]! } : { type: "", id: "" };
}

export function mapCharges(entries: VChargeEntry[], range: CostFetchRange): CostRow[] {
  const rows = new Map<string, CostRow>();
  const add = (row: CostRow) => {
    const key = [row.date, row.service, row.resourceId ?? "", JSON.stringify(row.tags ?? {})].join(
      "|",
    );
    const prev = rows.get(key);
    if (prev) prev.amount += row.amount;
    else rows.set(key, row);
  };
  for (const entry of entries) {
    const { type, id } = parseSource(entry.source);
    const tags: Record<string, string> = {};
    if (entry.metadata?.label) tags["label"] = entry.metadata.label;
    if (entry.metadata?.endpoint_id) tags["endpoint"] = String(entry.metadata.endpoint_id);
    const items = entry.items?.length
      ? entry.items
      : [{ ...entry, type: type === "volume" ? "disk" : "gpu" }];
    for (const item of items) {
      if (typeof item.amount !== "number" || item.amount === 0) continue;
      const service =
        type === "volume" ? "Volumes" : (SERVICES[item.type ?? ""] ?? item.type ?? "Other");
      for (const [date, amount] of spreadByDay(
        item.start ?? entry.start ?? NaN,
        item.end ?? entry.end ?? NaN,
        item.amount,
      )) {
        if (date < range.fromDate || date > range.toDate) continue;
        add({
          date,
          service,
          ...(id ? { resourceId: id } : {}),
          ...(Object.keys(tags).length ? { tags: { ...tags } } : {}),
          currency: "USD",
          amount,
        });
      }
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }))
    .filter((r) => r.amount !== 0);
}

export async function fetchVastCostData(api: VastApi, range: CostFetchRange): Promise<CostRow[]> {
  let entries: VChargeEntry[];
  try {
    entries = await api.paginate<VChargeEntry>("/api/v0/charges/", "results", {
      select_filters: {
        day: { gte: dayStart(range.fromDate), lte: dayStart(range.toDate) + DAY - 1 },
      },
      format: "table",
      limit: 100,
    });
  } catch (e) {
    if (isStatus(e, 401, 403)) {
      throw new CostSetupError(
        "Vast.ai refused the charge history for this API key. Billing data needs a key with the billing_read permission (a full-access key has it).",
        { label: "Manage Vast.ai API keys", url: "https://cloud.vast.ai/manage-keys/" },
      );
    }
    throw e;
  }
  return mapCharges(entries, range);
}
