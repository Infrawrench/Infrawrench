/**
 * Prices used to turn New Relic usage into money.
 *
 * New Relic's APIs meter usage (`NrConsumption`, `NrMTDConsumption`) but never
 * price it: the `estimatedCost` attribute those events once carried was
 * deprecated in May 2022, and no NerdGraph field exposes an organization's
 * contract rates or invoices. So every amount this plugin writes is usage
 * multiplied by a rate, and the rates are credential fields the user can
 * overwrite with their contract's numbers (Edit credentials) at any time.
 *
 * Defaults are New Relic's published list prices (https://newrelic.com/pricing,
 * checked 2026-10):
 * - Data ingest: $0.40/GB beyond the free 100 GB a month (Data Plus is
 *   $0.60/GB; the EU data centre adds $0.05/GB).
 * - Full platform users: $349/user/month on Pro with an annual commitment
 *   ($418.80 pay as you go; Standard is $99 per additional user).
 * - Core users: $49/user/month.
 * - Synthetic checks beyond the included allowance: $0.005/check.
 * - Compute (CCU): no published list price, so there is no default; compute
 *   rows are only written once a rate is entered.
 */

export interface NewRelicRates {
  dataPerGb: number;
  freeGbPerMonth: number;
  fullPlatformUser: number;
  coreUser: number;
  /** Undefined until the user enters one: CCU prices are not published. */
  coreCcu?: number;
  advancedCcu?: number;
  syntheticCheck: number;
}

export const DEFAULT_RATES = {
  dataPerGb: "0.40",
  freeGbPerMonth: "100",
  fullPlatformUser: "349",
  coreUser: "49",
  syntheticCheck: "0.005",
} as const;

/** Credential keys, so plugin.ts and the parser cannot drift. */
export const RATE_KEYS = {
  dataPerGb: "dataPricePerGb",
  freeGbPerMonth: "freeGbPerMonth",
  fullPlatformUser: "fullPlatformUserPrice",
  coreUser: "coreUserPrice",
  coreCcu: "coreCcuPrice",
  advancedCcu: "advancedCcuPrice",
  syntheticCheck: "syntheticCheckPrice",
} as const;

function parseRate(
  credentials: Record<string, string>,
  key: string,
  label: string,
  fallback: string | undefined,
): number | undefined {
  const raw = (credentials[key] ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  const value = raw === "" ? fallback : raw;
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`New Relic plugin: "${label}" must be a non-negative number, got "${raw}".`);
  }
  return n;
}

export function parseRates(credentials: Record<string, string>): NewRelicRates {
  const coreCcu = parseRate(
    credentials,
    RATE_KEYS.coreCcu,
    "Core compute price per CCU",
    undefined,
  );
  const advancedCcu = parseRate(
    credentials,
    RATE_KEYS.advancedCcu,
    "Advanced compute price per CCU",
    undefined,
  );
  return {
    dataPerGb: parseRate(
      credentials,
      RATE_KEYS.dataPerGb,
      "Data ingest price per GB",
      DEFAULT_RATES.dataPerGb,
    )!,
    freeGbPerMonth: parseRate(
      credentials,
      RATE_KEYS.freeGbPerMonth,
      "Free GB per month",
      DEFAULT_RATES.freeGbPerMonth,
    )!,
    fullPlatformUser: parseRate(
      credentials,
      RATE_KEYS.fullPlatformUser,
      "Full platform user price",
      DEFAULT_RATES.fullPlatformUser,
    )!,
    coreUser: parseRate(
      credentials,
      RATE_KEYS.coreUser,
      "Core user price",
      DEFAULT_RATES.coreUser,
    )!,
    ...(coreCcu !== undefined ? { coreCcu } : {}),
    ...(advancedCcu !== undefined ? { advancedCcu } : {}),
    syntheticCheck: parseRate(
      credentials,
      RATE_KEYS.syntheticCheck,
      "Synthetic check price",
      DEFAULT_RATES.syntheticCheck,
    )!,
  };
}

/** Product names written as the cost `service`; stable, since they key stored rows. */
export const PRODUCTS = {
  dataIngest: "Data ingest",
  fullPlatformUsers: "Full platform users",
  coreUsers: "Core users",
  coreCompute: "Core compute",
  advancedCompute: "Advanced compute",
  syntheticChecks: "Synthetic checks",
} as const;
