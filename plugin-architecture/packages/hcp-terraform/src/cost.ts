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
import { ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";
import type { Doc, TfContext } from "./api.js";
import { VENDOR, enc, statusOf, tfRaw } from "./api.js";

/** 10,000 invoices: the document fixes the page at ten. */
const MAX_PAGES = 1000;

export async function fetchInvoiceCost(
  ctx: TfContext,
  org: string,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  const path = `/organizations/${enc(org)}/invoices`;
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let res: { data?: Doc[]; meta?: { continuation?: string | null } };
    try {
      res = JSON.parse(
        await tfRaw(ctx, path, {
          query: cursor ? { cursor } : {},
        }),
      ) as typeof res;
    } catch (err) {
      // No invoices is a 404 where the list starts. Later it would drop the pages already read.
      if (statusOf(err) === 404 && !cursor) return [];
      throw err;
    }
    let older = false;
    for (const inv of requireListPage(res.data, { vendor: VENDOR, path, key: "data" })) {
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
    if (!cursor || older) return rows;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: rows.length, maxPages: MAX_PAGES });
}
