/**
 * Billed cost from the invoices API (HCP Terraform only, credit-card-billed
 * organizations; Terraform Enterprise and contract-billed organizations
 * answer 404 and report nothing).
 *
 * `GET /organizations/:org/invoices` pages ten at a time with
 * `meta.continuation` (an invoice id passed back as `cursor`). Each invoice
 * is one row on its issue date (`created-at`) with `total` in cents, the way
 * OVH and Turso anchor on an issue date. The upcoming draft invoice is shown
 * on the organization, never written as cost: it is not a charge yet.
 */
import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { Doc, TfContext } from "./api.js";
import { enc, statusOf, tfRaw } from "./api.js";

const MAX_PAGES = 12;

export async function fetchInvoiceCost(
  ctx: TfContext,
  org: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let res: { data?: Doc[]; meta?: { continuation?: string | null } };
    try {
      res = JSON.parse(
        await tfRaw(ctx, `/organizations/${enc(org)}/invoices`, {
          query: cursor ? { cursor } : {},
        }),
      ) as typeof res;
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
    let older = false;
    for (const inv of res.data ?? []) {
      const a = inv.attributes as Record<string, unknown>;
      const date = String(a["created-at"] ?? "").slice(0, 10);
      if (!date) continue;
      if (date < range.fromDate) {
        older = true;
        continue;
      }
      if (date > range.toDate) continue;
      const status = String(a["status"] ?? "");
      if (status === "draft" || status === "void") continue;
      const total = Number(a["total"]);
      if (!Number.isFinite(total)) continue;
      rows.push({
        date,
        service: "HCP Terraform",
        resourceId: org,
        tags: { invoice: String(a["number"] ?? inv.id), status },
        currency: "USD",
        amount: total / 100,
      });
    }
    cursor = res.meta?.continuation ?? undefined;
    if (!cursor || older) break;
  }
  return rows;
}
