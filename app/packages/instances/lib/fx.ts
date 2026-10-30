import { ECB_SOURCE_NAME, parseEcbXml } from "@infrawrench/server-core/cost/fx-feed";

/**
 * Exchange rates for showing prices in other currencies: the ECB euro
 * reference rates, the same source the cost features use (see "Automatic
 * exchange rates" in KNOWLEDGE.md), rebased to USD because AWS prices are in
 * USD. One publication is enough here: prices are converted at the latest
 * rate, and the page says which day's.
 */
const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export interface FxRates {
  /** The ECB publication date, `YYYY-MM-DD`. */
  date: string;
  source: string;
  /** Units of each currency per 1 USD, including USD itself. */
  perUsd: Record<string, number>;
}

/** Converts a publication's per-EUR rates to per-USD ones. */
export function rebaseToUsd(perEur: Record<string, string>): Record<string, number> | null {
  const usd = Number(perEur.USD);
  if (!(usd > 0)) return null;
  const out: Record<string, number> = { USD: 1, EUR: 1 / usd };
  for (const [code, rate] of Object.entries(perEur)) {
    if (code !== "USD") out[code] = Number(rate) / usd;
  }
  return out;
}

/** The latest rates, or `null` if the ECB cannot be reached; prices then show in USD only. */
export async function loadFxRates(): Promise<FxRates | null> {
  try {
    // The ECB publishes once a working day, around 16:00 CET.
    const res = await fetch(ECB_DAILY_URL, { cf: { cacheTtl: 6 * 3600, cacheEverything: true } });
    if (!res.ok) return null;
    const latest = parseEcbXml(await res.text()).at(-1)!;
    const perUsd = rebaseToUsd(latest.rates);
    return perUsd ? { date: latest.date, source: ECB_SOURCE_NAME, perUsd } : null;
  } catch {
    return null;
  }
}
