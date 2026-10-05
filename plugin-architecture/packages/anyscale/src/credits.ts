import type { CreditBalance } from "@infrawrench/plugin-base";
import { CreditAccessError } from "@infrawrench/plugin-base";
import type { AnyscaleContext } from "./api.js";
import { anyscaleFetch, isPermissionError } from "./api.js";
import type { AsCreditRecord, AsCredits } from "./types.js";

/**
 * Anyscale credit grants and prepaid commits
 * (`GET /api/v2/organization_billing/credits_v2`, the data behind
 * Organization settings > Billing > Credit history). One balance per grant
 * that is in use today, so a trial grant expiring next week and a contract
 * commit running to year end are tracked (and run out) separately.
 *
 * A pay-as-you-go organization with no grants returns no balances: there is
 * no pot to run out of, and reporting a zero would read as "exhausted".
 */

export async function fetchCredits(ctx: AnyscaleContext): Promise<AsCredits> {
  try {
    return await anyscaleFetch<AsCredits>(ctx, "/api/v2/organization_billing/credits_v2");
  } catch (err) {
    if (isPermissionError(err)) {
      throw new CreditAccessError(
        "Anyscale shows credit history only to organization owners. Use an API key belonging to an organization owner, or a service account with the Owner role.",
        {
          label: "Anyscale organization roles",
          url: "https://docs.anyscale.com/administration/organization/permissions",
        },
      );
    }
    throw err;
  }
}

function balanceOf(r: AsCreditRecord, kind: "credit" | "commit", i: number): CreditBalance {
  const name = r.credit_name || (kind === "commit" ? "Prepaid commit" : "Credit grant");
  const label = r.contract_name ? `${name} (${r.contract_name})` : name;
  return {
    key: `${kind}:${r.credit_name ?? i}:${r.effective_date_start ?? ""}`,
    label,
    remaining: Number(r.total_balance_usd ?? 0),
    currency: "USD",
    ...(typeof r.total_granted_usd === "number" ? { granted: r.total_granted_usd } : {}),
    ...(r.effective_date_end ? { expiresAt: `${r.effective_date_end}T23:59:59Z` } : {}),
  };
}

export function creditBalances(credits: AsCredits): CreditBalance[] {
  return [
    ...(credits.in_use_credits ?? []).map((r, i) => balanceOf(r, "credit", i)),
    ...(credits.in_use_commits ?? []).map((r, i) => balanceOf(r, "commit", i)),
  ];
}
