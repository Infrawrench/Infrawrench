import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { AtlasContext } from "./api.js";
import { atlasRequest, enc, isPermissionError } from "./api.js";

/**
 * Cost from Atlas invoices.
 *
 * Every org has one pending invoice for the month in progress
 * (`GET /orgs/{orgId}/invoices/pending`) and a closed invoice per finished
 * month (`GET /orgs/{orgId}/invoices`, then `GET …/invoices/{id}` for the
 * line items). A line item carries the SKU, the project (`groupId`,
 * `groupName`), the cluster, the usage window (`startDate`/`endDate`, one day
 * for metered usage), the quantity and unit, and `totalPriceCents`, which the
 * API documents as `unitPriceDollars × quantity × 100`, i.e. before any
 * `discountCents`. Rows are net of the discount.
 *
 * Why invoices and not the Cost Explorer API: Cost Explorer
 * (`POST /orgs/{orgId}/billing/costExplorer/usage`) is an asynchronous,
 * token-polled query that groups by month only; line items are daily, carry
 * the SKU, and need no polling. The FOCUS report endpoints are daily too but
 * hand back a presigned download URL on another host, which bastion egress
 * cannot route.
 *
 * Line items spanning several days (a monthly support charge, say) are spread
 * evenly over the days they cover, so a month still sums to the invoice.
 * Sales tax only exists on closed invoices and is dated to the invoice's last
 * day. Credits and support are flagged with their charge type.
 */

export interface InvoiceLineItem {
  sku?: string;
  clusterName?: string;
  groupId?: string;
  groupName?: string;
  startDate?: string;
  endDate?: string;
  quantity?: number;
  unit?: string;
  unitPriceDollars?: number;
  totalPriceCents?: number;
  discountCents?: number;
  cloudProvider?: string;
  stitchAppName?: string;
  tags?: Record<string, unknown>;
}

export interface Invoice {
  id?: string;
  statusName?: string;
  startDate?: string;
  endDate?: string;
  amountBilledCents?: number;
  subtotalCents?: number;
  creditsCents?: number;
  salesTaxCents?: number;
  lineItems?: InvoiceLineItem[];
}

/**
 * The Atlas billing category a SKU belongs to. Category names are the
 * `services` enum of the Cost Explorer request (the same names the Atlas
 * billing UI groups by). SKUs are opaque strings such as
 * `ATLAS_AWS_INSTANCE_M30` or `ATLAS_AWS_DATA_TRANSFER_DIFFERENT_REGION`, so
 * the category is read from the words in them; anything unrecognised is
 * "Atlas" rather than guessed.
 */
export function skuService(sku: string): string {
  const s = sku.toUpperCase();
  const has = (...words: string[]) => words.some((w) => s.includes(w));
  if (has("CREDIT")) return "Credits";
  if (has("SUPPORT")) return "Support";
  if (has("SERVERLESS")) return "Serverless Instances";
  if (has("STREAM")) return "Atlas Stream Processing";
  if (has("DATA_LAKE", "DATA_FEDERATION", "ONLINE_ARCHIVE", "NDS_ADL", "ADL_")) {
    return "Atlas Data Federation";
  }
  if (has("STITCH", "REALM", "APP_SERVICES", "DEVICE_SYNC")) return "App Services";
  if (has("CHARTS")) return "Charts";
  if (has("BI_CONNECTOR")) return "BI Connector";
  if (has("VOYAGE", "EMBEDDING", "RERANK", "AI_MODEL")) return "AI Model APIs";
  if (has("BACKUP", "SNAPSHOT", "PIT_RESTORE", "RESTORE", "OPLOG")) return "Backup";
  if (has("DATA_TRANSFER", "PRIVATE_ENDPOINT", "PRIVATELINK", "PEERING")) return "Data Transfer";
  if (has("ADVANCED_SECURITY", "AUDITING", "ENTERPRISE", "ENCRYPTION", "PREMIUM")) {
    return "Premium Features";
  }
  if (has("CLASSIC", "MMS", "CLOUD_MANAGER")) return "Cloud Manager";
  if (has("STORAGE", "IOPS", "DISK")) return "Storage";
  if (has("INSTANCE", "NVME", "FLEX", "FREE_TIER", "SHARED")) return "Clusters";
  return "Atlas";
}

function chargeTypeOf(sku: string, cents: number): CostChargeType {
  const s = sku.toUpperCase();
  if (s.includes("CREDIT")) return "credit";
  if (s.includes("SUPPORT")) return "support";
  if (cents < 0 && (s.includes("ADJUST") || s.includes("REFUND"))) return "adjustment";
  return "usage";
}

const DAY_MS = 86_400_000;

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * The UTC days a line item covers. `endDate` is exclusive when it falls on
 * midnight (Atlas writes `2026-10-01T00:00:00Z` → `2026-10-02T00:00:00Z` for
 * one day of usage).
 */
export function daysCovered(startIso: string | undefined, endIso: string | undefined): string[] {
  const start = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(start)) return [];
  const end = endIso ? Date.parse(endIso) : NaN;
  const first = startOfUtcDay(start);
  if (!Number.isFinite(end) || end <= start) return [dayOf(first)];
  const lastExclusive = end === startOfUtcDay(end) ? end : startOfUtcDay(end) + DAY_MS;
  const days: string[] = [];
  for (let t = first; t < lastExclusive && days.length < 400; t += DAY_MS) days.push(dayOf(t));
  return days.length ? days : [dayOf(first)];
}

/** Line items → daily rows within `range`, aggregated by dimension. */
export function invoiceToRows(invoice: Invoice, range: CostFetchRange): CostRow[] {
  const rows = new Map<string, CostRow>();
  const add = (row: CostRow) => {
    const key = [
      row.date,
      row.service ?? "",
      row.resourceId ?? "",
      row.chargeType ?? "",
      row.usageUnit ?? "",
      JSON.stringify(row.tags ?? {}),
    ].join("|");
    const existing = rows.get(key);
    if (existing) {
      existing.amount += row.amount;
      if (row.usageAmount !== undefined) {
        existing.usageAmount = (existing.usageAmount ?? 0) + row.usageAmount;
      }
    } else {
      rows.set(key, { ...row });
    }
  };

  for (const item of invoice.lineItems ?? []) {
    const sku = item.sku ?? "";
    const cents = (item.totalPriceCents ?? 0) - (item.discountCents ?? 0);
    const days = daysCovered(item.startDate, item.endDate);
    if (days.length === 0 || (cents === 0 && !item.quantity)) continue;
    const share = 1 / days.length;
    const tags: Record<string, string> = { sku };
    if (item.groupName) tags["project"] = item.groupName;
    if (item.groupId) tags["projectId"] = item.groupId;
    if (item.clusterName) tags["cluster"] = item.clusterName;
    if (item.cloudProvider) tags["cloudProvider"] = item.cloudProvider;
    if (item.stitchAppName) tags["appServicesApp"] = item.stitchAppName;
    for (const [k, v] of Object.entries(item.tags ?? {})) {
      if (typeof v === "string" || typeof v === "number") tags[`tag:${k}`] = String(v);
      else if (Array.isArray(v) && v.length > 0) tags[`tag:${k}`] = v.map(String).join(",");
    }
    const resourceId =
      item.groupId && item.clusterName ? `${item.groupId}/${item.clusterName}` : item.groupId;
    const chargeType = chargeTypeOf(sku, cents);
    for (const date of days) {
      if (date < range.fromDate || date > range.toDate) continue;
      add({
        date,
        service: skuService(sku),
        ...(resourceId ? { resourceId } : {}),
        tags,
        currency: "USD",
        amount: (cents / 100) * share,
        ...(typeof item.quantity === "number"
          ? { usageAmount: item.quantity * share, ...(item.unit ? { usageUnit: item.unit } : {}) }
          : {}),
        ...(chargeType !== "usage" ? { chargeType } : {}),
      });
    }
  }

  // Tax lands on closed invoices only; date it to the period's last day.
  const tax = invoice.salesTaxCents ?? 0;
  if (tax !== 0 && invoice.statusName !== "PENDING" && invoice.endDate) {
    const end = Date.parse(invoice.endDate);
    if (Number.isFinite(end)) {
      const date = dayOf(end === startOfUtcDay(end) ? end - DAY_MS : end);
      if (date >= range.fromDate && date <= range.toDate) {
        add({
          date,
          service: "Tax",
          tags: {},
          currency: "USD",
          amount: tax / 100,
          chargeType: "tax",
        });
      }
    }
  }

  return [...rows.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
}

function overlaps(invoice: Invoice, range: CostFetchRange): boolean {
  const start = invoice.startDate?.slice(0, 10) ?? "";
  if (!start) return false;
  // `endDate` is the exclusive midnight after the period's last day.
  const endMs = invoice.endDate ? Date.parse(invoice.endDate) : NaN;
  const lastDay = Number.isFinite(endMs) ? dayOf(endMs - 1) : "";
  return start <= range.toDate && (!lastDay || lastDay >= range.fromDate);
}

/** Every invoice that overlaps `range`, pending first, with its line items. */
export async function fetchInvoices(
  ctx: AtlasContext,
  orgId: string,
  range: CostFetchRange,
): Promise<Invoice[]> {
  const base = `/api/atlas/v2/orgs/${enc(orgId)}/invoices`;
  const pending = await atlasRequest<{ results?: Invoice[] }>(ctx, "GET", `${base}/pending`);
  const out: Invoice[] = [];
  const seen = new Set<string>();
  for (const inv of pending?.results ?? []) {
    if (inv.id) seen.add(inv.id);
    if (overlaps(inv, range)) out.push(inv);
  }

  // Newest first; stop paging once invoices end before the range starts.
  const metadata: Invoice[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await atlasRequest<{ results?: Invoice[] }>(ctx, "GET", base, {
      query: { itemsPerPage: 100, pageNum: page, sortBy: "START_DATE", orderBy: "desc" },
    });
    const results = res?.results ?? [];
    metadata.push(...results);
    const oldest = results[results.length - 1]?.endDate?.slice(0, 10) ?? "";
    if (results.length < 100 || (oldest && oldest < range.fromDate)) break;
  }

  for (const meta of metadata) {
    if (!meta.id || seen.has(meta.id) || !overlaps(meta, range)) continue;
    seen.add(meta.id);
    const full = await atlasRequest<Invoice>(ctx, "GET", `${base}/${enc(meta.id)}`);
    out.push(full ?? meta);
  }
  return out;
}

export async function fetchAtlasCostData(
  ctx: AtlasContext,
  orgId: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  let invoices: Invoice[];
  try {
    invoices = await fetchInvoices(ctx, orgId, range);
  } catch (err) {
    if (isPermissionError(err)) {
      throw new CostSetupError(
        "MongoDB Atlas refused to show invoices for this organization. Give the service account or API key the Organization Billing Viewer role (or Organization Billing Admin or Owner).",
        {
          label: "Atlas organization access",
          url: "https://www.mongodb.com/docs/atlas/reference/user-roles/#organization-roles",
        },
      );
    }
    throw err;
  }
  return invoices.flatMap((inv) => invoiceToRows(inv, range));
}

export interface InvoiceSummary {
  month: string;
  totalCents: number;
  byService: Array<{ service: string; cents: number }>;
  byProject: Array<{ project: string; cents: number }>;
  byCluster: Array<{ cluster: string; project: string; cents: number }>;
}

/** Month-to-date breakdown of the pending invoice, for the organization view. */
export function summarizeInvoice(invoice: Invoice): InvoiceSummary {
  const byService = new Map<string, number>();
  const byProject = new Map<string, number>();
  const byCluster = new Map<string, { cluster: string; project: string; cents: number }>();
  let total = 0;
  for (const item of invoice.lineItems ?? []) {
    const cents = (item.totalPriceCents ?? 0) - (item.discountCents ?? 0);
    total += cents;
    const service = skuService(item.sku ?? "");
    byService.set(service, (byService.get(service) ?? 0) + cents);
    const project = item.groupName ?? item.groupId ?? "Organization";
    byProject.set(project, (byProject.get(project) ?? 0) + cents);
    if (item.clusterName) {
      const key = `${item.groupId ?? ""}/${item.clusterName}`;
      const row = byCluster.get(key) ?? { cluster: item.clusterName, project, cents: 0 };
      row.cents += cents;
      byCluster.set(key, row);
    }
  }
  const sorted = <T extends { cents: number }>(xs: T[]) => xs.sort((a, b) => b.cents - a.cents);
  return {
    month: invoice.startDate?.slice(0, 7) ?? "",
    totalCents: total,
    byService: sorted([...byService].map(([service, cents]) => ({ service, cents }))),
    byProject: sorted([...byProject].map(([project, cents]) => ({ project, cents }))),
    byCluster: sorted([...byCluster.values()]),
  };
}

/**
 * Hourly per-node rates for instance SKUs seen on recent invoices, keyed by
 * tier and region. Feeds the oversized-cluster finder: Atlas publishes no
 * price API, so the only prices that are both real and the org's own are the
 * ones it was billed.
 *
 * Line items name the SKU (`ATLAS_AWS_INSTANCE_M30`) and the cluster but not
 * the region; `clusterRegion` resolves the region from the inventory.
 */
export function instanceRates(
  invoices: Invoice[],
  clusterRegion: (groupId: string, clusterName: string) => string | undefined,
): Map<string, number> {
  const rates = new Map<string, number>();
  for (const inv of invoices) {
    for (const item of inv.lineItems ?? []) {
      const m = /_INSTANCE_((?:M|R)\d+(?:_NVME)?(?:_GEN_2)?)$/.exec(item.sku ?? "");
      if (!m || !item.unitPriceDollars || !item.groupId || !item.clusterName) continue;
      const region = clusterRegion(item.groupId, item.clusterName);
      if (!region) continue;
      const key = `${region}|${m[1]}`;
      if (!rates.has(key)) rates.set(key, item.unitPriceDollars);
    }
  }
  return rates;
}
