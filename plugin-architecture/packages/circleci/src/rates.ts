/**
 * Credits to money. CircleCI bills in credits and its API reports credits,
 * never money, so every amount is credits times a price the user can edit.
 *
 * Published price (https://circleci.com/pricing/, checked 2026-10): extra
 * credits are $15 per 25,000, i.e. $0.0006 a credit. The Free plan includes
 * 30,000 credits a month; paid plans bill every credit.
 */

export const DEFAULT_PRICE_PER_CREDIT = 0.0006;

export const RATE_KEYS = {
  pricePerCredit: "pricePerCredit",
  includedCredits: "includedCreditsPerMonth",
} as const;

export interface CircleRates {
  /** USD per credit. */
  pricePerCredit: number;
  /** Credits each calendar month that cost nothing (the Free plan's 30,000). */
  includedCredits: number;
}

function nonNegative(raw: string | undefined, label: string): number | undefined {
  const value = (raw ?? "").trim().replace(/[$,\s]/g, "");
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`CircleCI plugin: "${label}" must be a non-negative number, got "${raw}"`);
  }
  return n;
}

export function parseRates(credentials: Record<string, string>): CircleRates {
  return {
    pricePerCredit:
      nonNegative(credentials[RATE_KEYS.pricePerCredit], "Price per Credit") ??
      DEFAULT_PRICE_PER_CREDIT,
    includedCredits:
      nonNegative(credentials[RATE_KEYS.includedCredits], "Credits Included per Month") ?? 0,
  };
}
