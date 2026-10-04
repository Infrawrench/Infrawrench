/**
 * Spend collection for Linode (Akamai Cloud Computing).
 *
 * Two sources, because Linode exposes two kinds of money:
 *
 * 1. **Closed invoices** (`GET /account/invoices` + `/{id}/items`): billed,
 *    final amounts. Each item carries `from`/`to` (the span it covers within
 *    the month), `amount` (pre-tax), `tax`, a `region` and a label that names
 *    the service and the entity (see `invoice-label.ts`). Each item's amount
 *    is spread evenly over the days it covers, so a Linode created on the
 *    20th shows up from the 20th, and the tax rides beside it as a `tax`
 *    charge-type row. Negative items (promotional credit, refunds) are
 *    `credit` rows.
 *
 * 2. **The open billing period**: Linode has no uninvoiced line items in its
 *    API, only `balance_uninvoiced` on `GET /account`, its running estimate
 *    of the next invoice (confirmed by Linode staff, community question
 *    21556). The total is therefore Linode's own figure, and the breakdown is
 *    ours: every resource in the inventory is priced from the live `.../types`
 *    catalog for the hours it has existed this period (hourly, capped at the
 *    plan's monthly price, exactly how Linode bills). Whatever Linode's total
 *    holds beyond that (resources deleted this month, transfer overage,
 *    images, anything we cannot price) is one "Other uninvoiced charges" row,
 *    so the period always sums to `balance_uninvoiced`. When the invoice
 *    lands these days are rewritten from it, and the host's reconciliation
 *    zeroes any estimated key the invoice no longer carries.
 *
 * The window is `restatementDays: 62` so the 1st of the previous month is
 * always inside it: the invoice for a month is generated on or just after
 * the 1st of the next, and must replace that month's estimate when it does.
 */

import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { LinodeApi, Page } from "./api.js";
import { SERVICE, parseInvoiceItemLabel } from "./invoice-label.js";
import {
  type PriceCatalog,
  type ResolvedPrice,
  backupsPrice,
  databasePrice,
  findLinodeType,
  regionalPrice,
  simpleType,
} from "./pricing.js";
import type {
  LinodeAccount,
  LinodeBucket,
  LinodeDatabase,
  LinodeInstance,
  LinodeInvoice,
  LinodeInvoiceItem,
  LinodeLkeCluster,
  LinodeNodeBalancer,
  LinodeReservedIp,
  LinodeVolume,
} from "./types.js";

const DAY_MS = 86_400_000;
const CURRENCY = "USD";
export const OTHER_UNINVOICED = "Other uninvoiced charges";
export const UNINVOICED_ADJUSTMENTS = "Uninvoiced credits and adjustments";

// --- date helpers ---------------------------------------------------------------

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `2026-09-30T23:59:59` (Linode timestamps are UTC without a zone) → epoch ms. */
export function parseLinodeTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Every UTC day from `fromDay` to `toDay` inclusive, as ISO dates. */
export function daysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  for (let t = start; t <= end && out.length < 1000; t += DAY_MS) out.push(isoDay(t));
  return out;
}

function inRange(day: string, range: CostFetchRange): boolean {
  return day >= range.fromDate && day <= range.toDate;
}

// --- row aggregation ---------------------------------------------------------------

interface RowKey {
  date: string;
  service: string;
  region: string;
  resourceId: string;
  chargeType: CostChargeType;
}

/**
 * Sums rows sharing a storage key. The host's table keeps one row per key
 * (the last written wins), so two invoice items for one resource on one day
 * must be added here, never written twice.
 */
export class RowBuilder {
  private readonly rows = new Map<string, CostRow & { usageAmount?: number }>();

  add(key: RowKey, amount: number, usage?: { amount: number; unit: string }): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    const k = `${key.date}|${key.service}|${key.region}|${key.resourceId}|${key.chargeType}`;
    const existing = this.rows.get(k);
    if (existing) {
      existing.amount += amount;
      if (usage && existing.usageUnit === usage.unit) {
        existing.usageAmount = (existing.usageAmount ?? 0) + usage.amount;
      }
      return;
    }
    this.rows.set(k, {
      date: key.date,
      service: key.service,
      ...(key.region ? { region: key.region } : {}),
      ...(key.resourceId ? { resourceId: key.resourceId } : {}),
      currency: CURRENCY,
      amount,
      ...(key.chargeType !== "usage" ? { chargeType: key.chargeType } : {}),
      ...(usage ? { usageAmount: usage.amount, usageUnit: usage.unit } : {}),
    });
  }

  build(): CostRow[] {
    return [...this.rows.values()]
      .map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }))
      .filter((r) => r.amount !== 0);
  }
}

// --- closed invoices -------------------------------------------------------------

function chargeTypeFor(item: LinodeInvoiceItem): CostChargeType {
  const amount = Number(item.amount ?? 0);
  const label = (item.label ?? "").toLowerCase();
  if (amount < 0) return /refund/.test(label) ? "refund" : "credit";
  if (/promo|credit/.test(label)) return "credit";
  return "usage";
}

/**
 * Spread each item over the UTC days its `from`..`to` span covers, clipped
 * to the fetch range. `fallbackMonth` (the invoice's billing month) is used
 * for misc items that carry no span.
 */
export function addInvoiceItems(
  builder: RowBuilder,
  items: LinodeInvoiceItem[],
  range: CostFetchRange,
  fallbackSpan: { from: number; to: number },
): void {
  for (const item of items) {
    const amount = Number(item.amount ?? 0);
    const tax = Number(item.tax ?? 0);
    if (amount === 0 && tax === 0) continue;
    const from = parseLinodeTime(item.from) ?? fallbackSpan.from;
    let to = parseLinodeTime(item.to) ?? fallbackSpan.to;
    if (to < from) to = from;
    const days = daysBetween(isoDay(from), isoDay(to));
    if (days.length === 0) continue;
    const parsed = parseInvoiceItemLabel(item.label);
    const region = item.region ?? "";
    const resourceId = parsed.resourceId ?? "";
    const chargeType = chargeTypeFor(item);
    const hours = item.type === "hourly" && item.quantity ? Number(item.quantity) : 0;
    for (const day of days) {
      if (!inRange(day, range)) continue;
      const share = 1 / days.length;
      builder.add(
        { date: day, service: parsed.service, region, resourceId, chargeType },
        amount * share,
        hours > 0 ? { amount: hours * share, unit: "Hours" } : undefined,
      );
      if (tax !== 0) {
        builder.add(
          { date: day, service: parsed.service, region, resourceId, chargeType: "tax" },
          tax * share,
        );
      }
    }
  }
}

/** The month an invoice bills: invoices are dated on or just after the 1st of the next month. */
export function invoiceFallbackSpan(invoiceDate: string | undefined): { from: number; to: number } {
  const ms = parseLinodeTime(invoiceDate) ?? Date.now();
  const d = new Date(ms);
  // An invoice dated in the first days of a month bills the previous month.
  const monthOffset = d.getUTCDate() <= 5 ? -1 : 0;
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthOffset, 1);
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthOffset + 1, 1) - 1000;
  return { from, to };
}

// --- the open period ---------------------------------------------------------------

export interface UninvoicedInventory {
  linodes: LinodeInstance[];
  volumes: LinodeVolume[];
  nodeBalancers: LinodeNodeBalancer[];
  lkeClusters: LinodeLkeCluster[];
  databases: LinodeDatabase[];
  buckets: LinodeBucket[];
  reservedIps: LinodeReservedIp[];
}

interface Accruing {
  service: string;
  region: string;
  resourceId: string;
  price: ResolvedPrice;
  /** Multiplier on the price (GB for volumes). */
  quantity: number;
  /** When the resource started billing (its creation), epoch ms. */
  since: number | null;
}

function accruingItems(inv: UninvoicedInventory, catalog: PriceCatalog): Accruing[] {
  const out: Accruing[] = [];
  for (const l of inv.linodes) {
    const t = findLinodeType(catalog, l.type ?? undefined);
    const region = l.region ?? "";
    const since = parseLinodeTime(l.created);
    out.push({
      service: SERVICE.linodes,
      region,
      resourceId: String(l.id),
      price: regionalPrice(t, region),
      quantity: 1,
      since,
    });
    if (l.backups?.enabled) {
      out.push({
        service: SERVICE.backups,
        region,
        resourceId: String(l.id),
        price: backupsPrice(t, region),
        quantity: 1,
        since,
      });
    }
  }
  const volumeType = simpleType(catalog.volumeTypes, "volume");
  for (const v of inv.volumes) {
    const region = v.region ?? "";
    out.push({
      service: SERVICE.blockStorage,
      region,
      resourceId: String(v.id),
      price: regionalPrice(volumeType, region),
      quantity: v.size ?? 0,
      since: parseLinodeTime(v.created),
    });
  }
  for (const nb of inv.nodeBalancers) {
    const region = nb.region ?? "";
    const t =
      nb.type === "premium"
        ? catalog.nodeBalancerTypes.find((x) => /premium/i.test(x.label ?? x.id))
        : simpleType(catalog.nodeBalancerTypes, "nodebalancer");
    out.push({
      service: SERVICE.nodeBalancers,
      region,
      resourceId: String(nb.id),
      price: regionalPrice(t, region),
      quantity: 1,
      since: parseLinodeTime(nb.created),
    });
  }
  for (const c of inv.lkeClusters) {
    const region = c.region ?? "";
    const typeId =
      c.tier === "enterprise" ? "lke-e" : c.control_plane?.high_availability ? "lke-ha" : null;
    if (!typeId) continue; // the standard control plane is free
    out.push({
      service: SERVICE.kubernetes,
      region,
      resourceId: String(c.id),
      price: regionalPrice(simpleType(catalog.lkeTypes, typeId), region),
      quantity: 1,
      since: parseLinodeTime(c.created),
    });
  }
  for (const d of inv.databases) {
    out.push({
      service: SERVICE.databases,
      region: d.region ?? "",
      resourceId: String(d.id),
      price: databasePrice(catalog, d.type, d.engine, d.cluster_size ?? 1),
      quantity: 1,
      since: parseLinodeTime(d.created),
    });
  }
  if (inv.buckets.length > 0) {
    // One flat Object Storage subscription per account, whatever the bucket count.
    const earliest = Math.min(
      ...inv.buckets.map((b) => parseLinodeTime(b.created) ?? Number.POSITIVE_INFINITY),
    );
    out.push({
      service: SERVICE.objectStorage,
      region: "",
      resourceId: "",
      price: regionalPrice(simpleType(catalog.objectStorageTypes, "objectstorage"), undefined),
      quantity: 1,
      since: Number.isFinite(earliest) ? earliest : null,
    });
  }
  const reservedType = simpleType(catalog.reservedIpTypes, "reserved-ipv4");
  for (const ip of inv.reservedIps) {
    out.push({
      service: SERVICE.reservedIps,
      region: ip.region ?? "",
      resourceId: ip.address,
      price: regionalPrice(reservedType, ip.region),
      quantity: 1,
      since: null,
    });
  }
  return out;
}

/**
 * Price the open period from inventory and top it up (or down) to Linode's
 * own `balance_uninvoiced`. Pure: all inputs passed in.
 */
export function addUninvoicedPeriod(
  builder: RowBuilder,
  args: {
    inventory: UninvoicedInventory;
    catalog: PriceCatalog;
    balanceUninvoiced: number;
    periodStart: number;
    now: number;
    range: CostFetchRange;
  },
): void {
  const { inventory, catalog, balanceUninvoiced, periodStart, now, range } = args;
  if (now <= periodStart) return;
  const periodDays = daysBetween(isoDay(periodStart), isoDay(now));
  let estimated = 0;

  for (const item of accruingItems(inventory, catalog)) {
    const hourly = item.price.hourly;
    if (hourly == null) continue;
    const start = Math.max(periodStart, item.since ?? periodStart);
    if (start >= now) continue;
    // Cap per calendar month: hourly × hours until the monthly price.
    const capPerMonth =
      item.price.monthly != null ? item.price.monthly * item.quantity : Number.POSITIVE_INFINITY;
    const spentInMonth = new Map<string, number>();
    for (let t = dayStart(start); t < now; t += DAY_MS) {
      const segStart = Math.max(t, start);
      const segEnd = Math.min(t + DAY_MS, now);
      if (segEnd <= segStart) continue;
      const hours = (segEnd - segStart) / 3_600_000;
      const month = isoDay(t).slice(0, 7);
      const spent = spentInMonth.get(month) ?? 0;
      const cost = Math.min(hourly * item.quantity * hours, Math.max(0, capPerMonth - spent));
      spentInMonth.set(month, spent + cost);
      estimated += cost;
      const day = isoDay(t);
      if (inRange(day, range)) {
        builder.add(
          {
            date: day,
            service: item.service,
            region: item.region,
            resourceId: item.resourceId,
            chargeType: "usage",
          },
          cost,
        );
      }
    }
  }

  const residual = balanceUninvoiced - estimated;
  if (Math.abs(residual) < 0.01 || periodDays.length === 0) return;
  const perDay = residual / periodDays.length;
  for (const day of periodDays) {
    if (!inRange(day, range)) continue;
    builder.add(
      {
        date: day,
        service: residual > 0 ? OTHER_UNINVOICED : UNINVOICED_ADJUSTMENTS,
        region: "",
        resourceId: "",
        chargeType: residual > 0 ? "usage" : "adjustment",
      },
      perDay,
    );
  }
}

// --- orchestration -------------------------------------------------------------------

async function itemsOf(api: LinodeApi, invoiceId: number): Promise<LinodeInvoiceItem[]> {
  return api.all<LinodeInvoiceItem>(`/account/invoices/${invoiceId}/items`);
}

/** Day after the last day the newest invoice covers: where the open period starts. */
export function openPeriodStart(
  newestItems: LinodeInvoiceItem[],
  newestInvoice: LinodeInvoice | undefined,
  now: number,
): number {
  const firstOfMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  let lastCovered: number | null = null;
  for (const it of newestItems) {
    const to = parseLinodeTime(it.to);
    if (to != null && (lastCovered == null || to > lastCovered)) lastCovered = to;
  }
  if (lastCovered == null && newestInvoice)
    lastCovered = invoiceFallbackSpan(newestInvoice.date).to;
  if (lastCovered == null) return firstOfMonth;
  const next = dayStart(lastCovered) + DAY_MS;
  // Never reach back more than one month: an account whose newest invoice is
  // old (a paused account) has nothing accruing that far back that inventory
  // could price.
  const floor = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1);
  return Math.min(Math.max(next, floor), now);
}

async function loadInventory(api: LinodeApi): Promise<UninvoicedInventory> {
  const safe = <T>(p: Promise<T[]>) => p.catch(() => [] as T[]);
  const [linodes, volumes, nodeBalancers, lkeClusters, databases, buckets, reservedIps] =
    await Promise.all([
      api.all<LinodeInstance>("/linode/instances"),
      safe(api.all<LinodeVolume>("/volumes")),
      safe(api.all<LinodeNodeBalancer>("/nodebalancers")),
      safe(api.all<LinodeLkeCluster>("/lke/clusters")),
      safe(api.all<LinodeDatabase>("/databases/instances")),
      safe(api.all<LinodeBucket>("/object-storage/buckets")),
      safe(api.all<LinodeReservedIp>("/networking/reserved/ips")),
    ]);
  return { linodes, volumes, nodeBalancers, lkeClusters, databases, buckets, reservedIps };
}

export interface LinodeCostDeps {
  api: LinodeApi;
  catalog: () => Promise<PriceCatalog>;
  now?: () => number;
}

export async function fetchLinodeCostData(
  deps: LinodeCostDeps,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const { api } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const builder = new RowBuilder();

  // Invoices that can cover the range: dated from the range start to ~40
  // days after its end (a month's invoice is dated after the month).
  const toMs = Date.parse(`${range.toDate}T00:00:00Z`) + 40 * DAY_MS;
  const invoices = await api.all<LinodeInvoice>("/account/invoices", {
    filter: {
      "+and": [
        { date: { "+gte": `${range.fromDate}T00:00:00` } },
        { date: { "+lte": new Date(toMs).toISOString().slice(0, 19) } },
      ],
    },
  });
  const itemsById = new Map<number, LinodeInvoiceItem[]>();
  for (const inv of invoices) {
    const items = await itemsOf(api, inv.id);
    itemsById.set(inv.id, items);
    addInvoiceItems(builder, items, range, invoiceFallbackSpan(inv.date));
  }

  // The open period, only when the range reaches it.
  const newestPage = await api.get<Page<LinodeInvoice>>("/account/invoices", {
    filter: { "+order_by": "date", "+order": "desc" },
    query: { page: 1, page_size: 25 },
  });
  const newest = newestPage.data?.[0];
  const newestItems = newest ? (itemsById.get(newest.id) ?? (await itemsOf(api, newest.id))) : [];
  const periodStart = openPeriodStart(newestItems, newest, now);
  if (range.toDate >= isoDay(periodStart) && range.fromDate <= isoDay(now)) {
    const [account, inventory, catalog] = await Promise.all([
      api.get<LinodeAccount>("/account"),
      loadInventory(api),
      deps.catalog(),
    ]);
    addUninvoicedPeriod(builder, {
      inventory,
      catalog,
      balanceUninvoiced: Number(account.balance_uninvoiced ?? 0),
      periodStart,
      now,
      range,
    });
  }

  return builder.build();
}
