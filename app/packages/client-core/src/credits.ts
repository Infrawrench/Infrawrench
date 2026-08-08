/**
 * Cloud-credit burndown — the platform-neutral client half.
 *
 * A provider that bills in arrears sends an invoice you can argue with. A
 * prepaid pot that empties simply stops answering: running out of inference
 * credit is an outage, not a bill. And a balance on its own is not actionable —
 * "you have $42" tells you nothing, while "$42, six days left at your current
 * burn" is a decision.
 *
 * Server contract: `/api/org/:orgId/credits` (web `api/routes/credits.ts`),
 * gated on `costs:read`.
 */
import type { CloudFetch } from "./fetch";

/** How alarming a runway is. `unknown` is never rounded down to `ok`. */
export type RunwayUrgency = "critical" | "warning" | "ok" | "unknown";

export interface CreditPot {
  accountId: string;
  accountName: string;
  pluginId: string;
  /** The provider's own word for this pot ("Credits", "Balance"). */
  capabilityLabel: string;
  topUpUrl: string | null;
  potKey: string;
  label: string;
  remaining: number;
  currency: string;
  /** What was granted, when the provider reports it. */
  granted: number | null;
  /** Hard expiry on the credit itself, independent of burn. */
  creditExpiresAt: string | null;
  observedAt: string;
  /**
   * Spend per day over the observed span. **Null means "not enough history to
   * say"** — never 0, which would read as "nothing is being spent".
   */
  burnPerDay: number | null;
  burnSpanDays: number;
  observations: number;
  /** Increases seen between readings. A top-up is never netted off the burn. */
  topUps: number;
  runwayDays: number | null;
  exhaustedAt: string | null;
  /** Nothing has been spent over the observed span. */
  neverEmpties: boolean;
  /** The credit's own expiry, not the burn, is the deadline. */
  limitedByExpiry: boolean;
  urgency: RunwayUrgency;
}

export interface CreditPollFailure {
  accountId: string;
  accountName: string;
  pluginId: string;
  error: string;
  /** Set when the plugin said this is a permission gap, not an outage. */
  helpLabel: string | null;
  helpUrl: string | null;
  failureCount: number;
}

export interface CreditBurndown {
  pots: CreditPot[];
  failures: CreditPollFailure[];
  /** Credit-capable accounts never yet collected — named rather than omitted. */
  pendingAccountIds: string[];
  burnWindowDays: number;
}

export async function fetchCreditBurndown(
  api: CloudFetch,
  orgId: string,
): Promise<CreditBurndown | null> {
  return api.org<CreditBurndown>(orgId, "/credits");
}

/**
 * "6 days" / "3 weeks" / "4 months" — the runway cell.
 *
 * Coarsens as the number grows, because the precision is not there: a runway
 * of "213 days" implies a burn rate measured to a precision a 30-day window
 * cannot support, and "7 months" is the honest rendering of the same estimate.
 */
export function formatRunway(pot: Pick<CreditPot, "runwayDays" | "neverEmpties">): string {
  if (pot.neverEmpties) return "no spend observed";
  if (pot.runwayDays === null) return "not enough history";
  const days = pot.runwayDays;
  if (days <= 0) return "exhausted";
  if (days < 1) return "less than a day";
  if (days < 14) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return "over 2 years";
}

/** "$12.40/day" — the burn cell; honest about not knowing. */
export function formatBurn(pot: Pick<CreditPot, "burnPerDay" | "currency">): string {
  if (pot.burnPerDay === null) return "—";
  return `${formatCreditAmount(pot.burnPerDay, pot.currency)}/day`;
}

/**
 * Money in the pot's own currency.
 *
 * Never sums across currencies anywhere in this feature: "$40 and ¥300" is not
 * a number, and a provider that splits credit by currency gets a row each.
 */
export function formatCreditAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(amount) < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    // An unknown or non-ISO currency code (a provider inventing "credits").
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The one-line headline: the most urgent pot, or a clean bill. */
export function summarizeCreditBurndown(feed: CreditBurndown): string {
  const worst = feed.pots.find((p) => p.urgency === "critical" || p.urgency === "warning");
  if (worst) {
    return `${worst.accountName}: ${formatCreditAmount(worst.remaining, worst.currency)} left, ${formatRunway(worst)}`;
  }
  if (feed.pots.length === 0) return "No prepaid credit balances tracked.";
  return `${feed.pots.length} balance${feed.pots.length === 1 ? "" : "s"} tracked, none running low.`;
}
