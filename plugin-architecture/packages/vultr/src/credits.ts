/**
 * Prepaid credit: Vultr reports `balance` on `GET /v2/account`, negative when
 * the account holds credit (a prepayment or a promotional grant) and positive
 * when money is owed. Pending charges draw the credit down as they accrue,
 * so the host's burn rate follows from successive readings.
 */

import type { CreditBalance } from "@infrawrench/plugin-base";
import { CreditAccessError } from "@infrawrench/plugin-base";
import { type VultrApi, statusOf } from "./api.js";
import type { VultrAccount } from "./types.js";

export function creditsFromAccount(account: VultrAccount): CreditBalance[] {
  const balance = Number(account.balance ?? 0);
  if (!Number.isFinite(balance)) return [];
  // Credit already committed to this month's charges is not available.
  const pending = Math.max(0, Number(account.pending_charges ?? 0) || 0);
  const remaining = Math.max(0, -balance - pending);
  if (balance >= 0)
    return [{ key: "account-credit", label: "Account credit", remaining: 0, currency: "USD" }];
  return [{ key: "account-credit", label: "Account credit", remaining, currency: "USD" }];
}

export async function fetchCredits(api: VultrApi): Promise<CreditBalance[]> {
  try {
    const res = await api.get<{ account?: VultrAccount }>("/account");
    return creditsFromAccount(res.account ?? {});
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      throw new CreditAccessError(
        "This API key cannot read the account balance. Use the account owner's key or give the key's user the Billing permission.",
        { label: "Manage API access", url: "https://my.vultr.com/settings/#settingsapi" },
      );
    }
    throw err;
  }
}
