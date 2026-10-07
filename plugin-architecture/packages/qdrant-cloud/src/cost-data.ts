import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { isStatus, millicents, type QdrantApi } from "./api.js";
import type { QcMeteringItem } from "./types.js";

/**
 * Billed usage from the metering service:
 * `GET /api/metering/v1/accounts/{id}/meterings/{year}/{month}` returns every
 * metering window of the month (`startTime`..`endTime`, an amount and a
 * discount in millicents, the cluster and the billable entity type:
 * cluster booking, extra disk, storage tier, backup, inference tokens).
 * Needs the `read:payment_information` permission.
 *
 * A window is spread over the UTC days it covers in proportion to its
 * duration, so a row never lands on a day the usage did not happen. Amounts
 * are net of discounts (`amount - discount`).
 */

const DAY_MS = 86_400_000;

function monthsBetween(from: string, to: string): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function serviceName(type: string | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("disk")) return "Extra Disk";
  if (t.includes("storage")) return "Storage Tier";
  if (t.includes("backup")) return "Backups";
  if (t.includes("inference")) return "Inference";
  if (t.includes("cluster") || t.includes("booking")) return "Clusters";
  return type || "Other";
}

/** Split one metering window across the UTC days it overlaps. */
export function spreadItem(item: QcMeteringItem): CostRow[] {
  const net = millicents(item.amountMillicents) - millicents(item.discountAmountMillicents);
  if (!net) return [];
  const start = Date.parse(item.startTime ?? "");
  const end = Date.parse(item.endTime ?? "");
  const currency = item.currency || "USD";
  const base: Omit<CostRow, "date" | "amount"> = {
    service: serviceName(item.billableEntityType),
    currency,
    ...(item.clusterId ? { resourceId: item.clusterId } : {}),
    ...(item.clusterLabels && Object.keys(item.clusterLabels).length
      ? { tags: { ...item.clusterLabels } }
      : {}),
  };
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const date = (item.startTime ?? item.endTime ?? "").slice(0, 10);
    return date ? [{ ...base, date, amount: net }] : [];
  }
  const rows: CostRow[] = [];
  let cursor = start;
  while (cursor < end) {
    const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
    const next = Math.min(end, dayStart + DAY_MS);
    const share = (next - cursor) / (end - start);
    rows.push({
      ...base,
      date: new Date(dayStart).toISOString().slice(0, 10),
      amount: net * share,
      ...(item.usageHours ? { usageAmount: item.usageHours * share, usageUnit: "Hours" } : {}),
    });
    cursor = next;
  }
  return rows;
}

/** Merge rows sharing a day and dimensions, rounded to 1/100 000 of a unit. */
export function aggregateRows(rows: CostRow[]): CostRow[] {
  const acc = new Map<string, CostRow>();
  for (const r of rows) {
    const key = [r.date, r.service, r.resourceId, r.currency, JSON.stringify(r.tags ?? {})].join(
      "|",
    );
    const cur = acc.get(key);
    if (cur) {
      cur.amount += r.amount;
      if (r.usageAmount !== undefined) cur.usageAmount = (cur.usageAmount ?? 0) + r.usageAmount;
    } else {
      acc.set(key, { ...r });
    }
  }
  return [...acc.values()].map((r) => ({
    ...r,
    amount: Math.round(r.amount * 100_000) / 100_000,
    ...(r.usageAmount !== undefined
      ? { usageAmount: Math.round(r.usageAmount * 1000) / 1000 }
      : {}),
  }));
}

export async function fetchQdrantCostData(
  api: QdrantApi,
  accountId: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  for (const { year, month } of monthsBetween(range.fromDate, range.toDate)) {
    let items: QcMeteringItem[];
    try {
      const res = await api.cloud<{ items?: QcMeteringItem[] }>(
        `/api/metering/v1/accounts/${encodeURIComponent(accountId)}/meterings/${year}/${month}`,
      );
      items = res?.items ?? [];
    } catch (e) {
      if (isStatus(e, 401, 403)) {
        throw new CostSetupError(
          "The management key cannot read billing. Give its role the read:payment_information permission in Qdrant Cloud, Access Management.",
        );
      }
      throw e;
    }
    for (const item of items) rows.push(...spreadItem(item));
  }
  return aggregateRows(rows.filter((r) => r.date >= range.fromDate && r.date <= range.toDate));
}
