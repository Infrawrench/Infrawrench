/**
 * Cost-collection status contract, shared by every client that renders cost
 * data. Collection runs daily in the background and backs off on failure, so
 * a misconfigured provider otherwise reads as a permanently empty graph —
 * these types carry the reason (and the provider page that fixes it) out to
 * the web, desktop, mobile, and CLI surfaces.
 */

/** Why an account's last cost collection failed, as stored by the poller. */
export interface CostPollError {
  message: string;
  /** Provider page that fixes a setup problem, when the plugin knows one. */
  helpLink: { label: string; url: string } | null;
}

/** One account's cost capability + collection state (GET /costs/status). */
export interface CostAccountStatus {
  accountId: string;
  pluginId: string;
  displayName: string;
  supportsCosts: boolean;
  periodNative: boolean;
  dimensions: string[];
  costLastPolledAt: string | null;
  costBackfilledAt: string | null;
  costPollFailureCount: number;
  costPollError: CostPollError | null;
  coverage: { firstDay: string; lastDay: string } | null;
}

/** The accounts a failure notice should talk about, in display order. */
export function failingCostAccounts(statuses: CostAccountStatus[]): CostAccountStatus[] {
  return statuses.filter((s) => s.supportsCosts && s.costPollError);
}
