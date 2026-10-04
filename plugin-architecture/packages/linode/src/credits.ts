/**
 * Prepaid credit: the promotions on `GET /account` (`active_promotions[]`,
 * each with `credit_remaining` and `expire_dt`), plus account credit when the
 * balance is negative (Linode reports money owed as positive). Both draw
 * down as usage accrues, and a promotion lapses on its expiry date whatever
 * is left, which is exactly what the burndown's expiry-bounded runway is for.
 */

import type { CreditBalance } from "@infrawrench/plugin-base";
import { CreditAccessError } from "@infrawrench/plugin-base";
import { type LinodeApi, statusOf } from "./api.js";
import type { LinodeAccount } from "./types.js";

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function creditsFromAccount(account: LinodeAccount): CreditBalance[] {
  const out: CreditBalance[] = [];
  const seen = new Set<string>();
  for (const p of account.active_promotions ?? []) {
    const remaining = Number(p.credit_remaining ?? NaN);
    if (!Number.isFinite(remaining)) continue;
    // Promotions carry no id; the summary plus expiry is stable for the
    // promotion's life and distinct between two grants of the same kind.
    let key = `promo:${slug(p.summary ?? p.service_type ?? "promotion")}:${(p.expire_dt ?? "").slice(0, 10)}`;
    while (seen.has(key)) key = `${key}+`;
    seen.add(key);
    out.push({
      key,
      label: p.summary || "Promotional credit",
      remaining,
      currency: "USD",
      ...(p.expire_dt
        ? { expiresAt: p.expire_dt.endsWith("Z") ? p.expire_dt : `${p.expire_dt}Z` }
        : {}),
    });
  }
  const balance = Number(account.balance ?? 0);
  if (Number.isFinite(balance) && balance < 0) {
    out.push({
      key: "account-credit",
      label: "Account credit",
      remaining: -balance,
      currency: "USD",
    });
  }
  return out;
}

export async function fetchCredits(api: LinodeApi): Promise<CreditBalance[]> {
  try {
    return creditsFromAccount(await api.get<LinodeAccount>("/account"));
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      throw new CreditAccessError(
        "The personal access token cannot read the account. Promotions and account credit need the Account scope (read-only is enough).",
        { label: "Manage access tokens", url: "https://cloud.linode.com/profile/tokens" },
      );
    }
    throw err;
  }
}
