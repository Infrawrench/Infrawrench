import type { CostChargeType, CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { HerokuApi } from "./api.js";
import { enc } from "./kit.js";
import type { HkInvoice, HkTeam } from "./types.js";

/**
 * Billed spend from Heroku invoices, one invoice per month, dated to the
 * period start (`periodNative`).
 *
 * - Team invoices (`GET /teams/{team}/invoices`) are integer **cents**
 *   (schema type `integer`, examples like 25000) and split into
 *   `platform_total` (dynos and the platform), `addons_total` and
 *   `database_total`.
 * - Personal invoices (`GET /account/invoices`) are `number`s in dollars and
 *   carry only `charges_total` and `total`.
 *
 * Whatever the breakdown does not explain (credits, adjustments) becomes one
 * extra row so every invoice sums to its `total`. An open month has no
 * invoice yet, so the current month never appears until it closes.
 */

const DAY = /^\d{4}-\d{2}-\d{2}/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export function periodDay(raw: string): string {
  if (DAY.test(raw)) return raw.slice(0, 10);
  const m = US.exec(raw);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

function row(
  date: string,
  service: string,
  amount: number,
  tags: Record<string, string>,
  chargeType?: CostChargeType,
): CostRow {
  return {
    date,
    service,
    currency: "USD",
    amount: Math.round(amount * 100) / 100,
    tags,
    ...(chargeType ? { chargeType } : {}),
  };
}

export function invoiceRows(inv: HkInvoice, owner: { team?: string }): CostRow[] {
  const date = periodDay(inv.period_start);
  if (!date) return [];
  const tags = { billing: owner.team ? `team:${owner.team}` : "personal" };
  const out: CostRow[] = [];
  const scale = owner.team ? 1 / 100 : 1;
  const total = (inv.total ?? 0) * scale;
  let explained = 0;
  const parts: Array<[string, number | undefined]> = owner.team
    ? [
        ["Platform", inv.platform_total],
        ["Add-ons", inv.addons_total],
        ["Data", inv.database_total],
      ]
    : [["Heroku", inv.charges_total]];
  for (const [service, raw] of parts) {
    if (typeof raw !== "number" || raw === 0) continue;
    const amount = raw * scale;
    explained += amount;
    out.push(row(date, service, amount, tags, "usage"));
  }
  const rest = Math.round((total - explained) * 100) / 100;
  if (rest !== 0) {
    out.push(
      row(date, rest < 0 ? "Credits" : "Other charges", rest, tags, rest < 0 ? "credit" : "other"),
    );
  }
  return out;
}

export async function fetchHerokuCostData(
  api: HerokuApi,
  teams: HkTeam[],
  includePersonal: boolean,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const inRange = (inv: HkInvoice) => {
    const d = periodDay(inv.period_start);
    // A month counts when its first day falls in range, or the range starts inside it.
    const monthStart = `${range.fromDate.slice(0, 7)}-01`;
    return d >= monthStart && d <= range.toDate;
  };
  const out: CostRow[] = [];
  if (includePersonal) {
    const personal = await api.listAll<HkInvoice>("/account/invoices");
    for (const inv of personal.filter(inRange)) out.push(...invoiceRows(inv, {}));
  }
  for (const t of teams) {
    const invoices = await api.listAll<HkInvoice>(`/teams/${enc(t.id)}/invoices`);
    for (const inv of invoices.filter(inRange)) out.push(...invoiceRows(inv, { team: t.name }));
  }
  return out;
}
