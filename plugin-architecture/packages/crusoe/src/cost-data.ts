import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { isStatus, type CrusoeApi } from "./api.js";
import { normalizeHeader, parseCsv } from "./csv.js";
import type { CrusoeEntity } from "./types.js";

/**
 * Billed spend for every organization the key can see, from two endpoints
 * (both verified in Crusoe's published spec and docs, 2026-10):
 *
 * - `GET /organizations/{id}/billing/export-productline?start_date&end_date`
 *   returns a CSV of the **on-demand and spot** costs of the organization's
 *   resources: what the console's Billing page shows and exports. Crusoe
 *   documents it as excluding reserved-instance purchases and tax, and as
 *   holding data from 2025-05-01 onward.
 * - `GET /organizations/{id}/billing/costs` returns daily spend for
 *   Intelligence Billing (Serverless Inference and Serverless Fine Tuning)
 *   as JSON. It takes no date range, so rows outside the requested range are
 *   dropped here.
 *
 * Crusoe does not document the CSV's column names, so the parser finds them
 * by header rather than by position (`COLUMN_ALIASES`) and fails loudly,
 * naming the headers it saw, when it cannot find a cost column. A silently
 * empty series would read as zero spend, which is the one wrong answer that
 * looks right.
 */

export const COST_HELP_URL = "https://console.crusoecloud.com/billing";

type Column =
  | "date"
  | "cost"
  | "product"
  | "region"
  | "resource"
  | "resourceName"
  | "project"
  | "quantity"
  | "unit"
  | "currency";

/** Normalised header spellings each column is recognised by, most specific first. */
const COLUMN_ALIASES: Record<Column, string[]> = {
  date: ["date", "usage_date", "billing_date", "day", "start_date", "period_start", "start_time"],
  cost: [
    "cost",
    "total_cost",
    "cost_usd",
    "amount",
    "amount_usd",
    "total",
    "charge",
    "charges",
    "billed_amount",
    "spend",
  ],
  product: ["product_line", "product", "resource_type", "product_name", "sku", "service", "type"],
  region: ["region", "location"],
  resource: ["resource_id", "vm_id", "instance_id", "disk_id", "resource_uuid"],
  resourceName: ["resource_name", "resource", "name", "vm_name", "instance_name"],
  project: ["project_id", "project", "project_name"],
  quantity: ["quantity", "usage", "usage_quantity", "usage_amount", "hours", "instance_hours"],
  unit: ["unit", "usage_unit", "billable_metric", "metric", "unit_of_measure"],
  currency: ["currency", "currency_code"],
};

export type ColumnMap = Partial<Record<Column, number>>;

export function detectColumns(headers: string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const map: ColumnMap = {};
  const taken = new Set<number>();
  for (const column of Object.keys(COLUMN_ALIASES) as Column[]) {
    for (const alias of COLUMN_ALIASES[column]) {
      const idx = normalized.findIndex((h, i) => h === alias && !taken.has(i));
      if (idx >= 0) {
        map[column] = idx;
        taken.add(idx);
        break;
      }
    }
  }
  return map;
}

/** `2025-05-01`, `2025-05-01T00:00:00Z`, `05/01/2025` → `2025-05-01`; else null. */
export function parseCsvDate(value: string): string | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  return null;
}

/** `$1,234.56`, `1234.56`, `(12.00)` → number; else NaN. */
export function parseMoney(value: string): number {
  let v = value.trim();
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  v = v.replace(/[$,\s]/g, "").replace(/^USD/i, "");
  if (v === "") return Number.NaN;
  const n = Number(v);
  return negative ? -n : n;
}

export interface CsvCostContext {
  organizationId: string;
  organizationName: string;
  /** Applied when the CSV has no date column (one request per day). */
  fallbackDate?: string;
  projectNames: Map<string, string>;
  multipleOrgs: boolean;
}

export class CsvShapeError extends Error {
  constructor(headers: string[]) {
    super(
      `Crusoe's billing export has no column this plugin recognises as a cost (headers: ${headers.join(", ") || "none"}).`,
    );
    this.name = "CsvShapeError";
  }
}

/**
 * Parse one billing-export CSV into cost rows. Throws `CsvShapeError` when
 * there are data rows but no recognisable cost column; returns `null` for
 * the date when the CSV has no date column and no fallback was given, so the
 * caller can switch to per-day requests.
 */
export function parseBillingCsv(
  text: string,
  ctx: CsvCostContext,
): { rows: CostRow[]; hasDateColumn: boolean } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], hasDateColumn: true };
  const [headers, ...data] = table as [string[], ...string[][]];
  const cols = detectColumns(headers);
  if (data.length === 0) return { rows: [], hasDateColumn: cols.date !== undefined };
  if (cols.cost === undefined) throw new CsvShapeError(headers);
  if (cols.date === undefined && !ctx.fallbackDate) return { rows: [], hasDateColumn: false };

  const cell = (row: string[], c: Column): string => {
    const idx = cols[c];
    return idx === undefined ? "" : (row[idx] ?? "").trim();
  };

  const rows: CostRow[] = [];
  for (const row of data) {
    const amount = parseMoney(cell(row, "cost"));
    if (!Number.isFinite(amount)) continue;
    const date =
      cols.date !== undefined ? parseCsvDate(cell(row, "date")) : (ctx.fallbackDate ?? null);
    if (!date) continue;
    const project = cell(row, "project");
    const tags: Record<string, string> = {};
    if (project) tags["project"] = ctx.projectNames.get(project) ?? project;
    if (ctx.multipleOrgs) tags["organization"] = ctx.organizationName || ctx.organizationId;
    const resourceName = cell(row, "resourceName");
    if (resourceName) tags["resource_name"] = resourceName;
    const quantity = Number(cell(row, "quantity"));
    const unit = cell(row, "unit");
    // Resources are stored as `<projectId>/<id>`; scope the billing id the
    // same way when the project column is a known project id, so per-resource
    // spend lines up with inventory (orphan cost annotation matches on it).
    const rawResourceId = cell(row, "resource");
    const resourceId =
      rawResourceId && project && ctx.projectNames.has(project)
        ? `${project}/${rawResourceId}`
        : rawResourceId;
    const service = cell(row, "product");
    const region = cell(row, "region");
    rows.push({
      date,
      ...(service ? { service } : {}),
      ...(region ? { region } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      currency: (cell(row, "currency") || "USD").toUpperCase(),
      amount,
      ...(Number.isFinite(quantity) && cell(row, "quantity") !== ""
        ? { usageAmount: quantity }
        : {}),
      ...(unit ? { usageUnit: unit } : {}),
    });
  }
  return { rows, hasDateColumn: cols.date !== undefined };
}

interface BillingCostsResponse {
  data?: Array<{
    date?: string;
    cost?: number;
    quantity?: number;
    billable_metric?: string;
    project_id?: string;
    region?: string;
    resource_type?: string;
    unit_price?: number;
  }>;
}

export function mapIntelligenceCosts(
  res: BillingCostsResponse | undefined,
  range: CostFetchRange,
  ctx: CsvCostContext,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const d of res?.data ?? []) {
    const date = d.date ? parseCsvDate(d.date) : null;
    if (!date || date < range.fromDate || date > range.toDate) continue;
    if (typeof d.cost !== "number" || !Number.isFinite(d.cost)) continue;
    const tags: Record<string, string> = {};
    if (d.project_id) tags["project"] = ctx.projectNames.get(d.project_id) ?? d.project_id;
    if (d.resource_type) tags["model"] = d.resource_type;
    if (ctx.multipleOrgs) tags["organization"] = ctx.organizationName || ctx.organizationId;
    rows.push({
      date,
      service: "Serverless Inference",
      ...(d.region ? { region: d.region } : {}),
      tags,
      currency: "USD",
      amount: d.cost,
      ...(typeof d.quantity === "number" ? { usageAmount: d.quantity } : {}),
      ...(d.billable_metric ? { usageUnit: d.billable_metric } : {}),
    });
  }
  return rows;
}

/**
 * Two rows that land on the same host key would collapse in `cost_daily`
 * (ReplacingMergeTree keeps the last), so sum them first.
 */
export function aggregateRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const r of rows) {
    const tags = r.tags
      ? Object.entries(r.tags)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join("&")
      : "";
    const key = [
      r.date,
      r.service ?? "",
      r.region ?? "",
      r.resourceId ?? "",
      tags,
      r.currency,
      r.usageUnit ?? "",
    ].join("|");
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    prev.amount += r.amount;
    if (r.usageAmount !== undefined) prev.usageAmount = (prev.usageAmount ?? 0) + r.usageAmount;
  }
  return [...byKey.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
}

function eachDay(range: CostFetchRange): string[] {
  const out: string[] = [];
  const d = new Date(`${range.fromDate}T00:00:00Z`);
  const end = new Date(`${range.toDate}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export async function fetchCrusoeCostData(
  api: CrusoeApi,
  orgs: CrusoeEntity[],
  projectNames: Map<string, string>,
  range: CostFetchRange,
): Promise<CostRow[]> {
  if (orgs.length === 0) {
    throw new CostSetupError(
      "This Crusoe access key belongs to no active organization, so there is no billing data to read.",
      { label: "Open Crusoe Cloud billing", url: COST_HELP_URL },
    );
  }
  const rows: CostRow[] = [];
  const denied: string[] = [];
  for (const org of orgs) {
    const ctx: CsvCostContext = {
      organizationId: org.id,
      organizationName: org.name ?? "",
      projectNames,
      multipleOrgs: orgs.length > 1,
    };
    const exportPath = `/organizations/${org.id}/billing/export-productline`;
    try {
      const text = await api.requestText(exportPath, {
        query: { start_date: range.fromDate, end_date: range.toDate },
      });
      const parsed = parseBillingCsv(text, ctx);
      if (parsed.hasDateColumn) {
        rows.push(...parsed.rows);
      } else {
        // No per-day column: ask for one day at a time so each row can be dated.
        for (const day of eachDay(range)) {
          const dayText = await api.requestText(exportPath, {
            query: { start_date: day, end_date: day },
          });
          rows.push(...parseBillingCsv(dayText, { ...ctx, fallbackDate: day }).rows);
        }
      }
    } catch (e) {
      if (e instanceof CsvShapeError) {
        throw new CostSetupError(`${e.message} Please report this so the parser can be updated.`, {
          label: "Open Crusoe Cloud billing",
          url: COST_HELP_URL,
        });
      }
      if (isStatus(e, 401, 403)) {
        denied.push(org.name || org.id);
        continue;
      }
      throw e;
    }
    try {
      const res = await api.request<BillingCostsResponse>(`/organizations/${org.id}/billing/costs`);
      rows.push(...mapIntelligenceCosts(res, range, ctx));
    } catch (e) {
      // Organizations without Intelligence Billing may be refused here; the
      // infrastructure costs above are still complete.
      if (!isStatus(e, 401, 403, 404)) throw e;
    }
  }
  if (denied.length === orgs.length) {
    throw new CostSetupError(
      `Crusoe refused billing access for ${denied.join(", ")}. Billing data needs an access key created by a user with the organization's admin or billing role.`,
      { label: "Open Crusoe Cloud billing", url: COST_HELP_URL },
    );
  }
  return aggregateRows(rows);
}
