/**
 * Static Snowflake vocabulary: warehouse sizes, the service-type groups costs
 * are reported under, and the user-editable prices the estimate falls back to.
 */

/**
 * Warehouse sizes in order. `show` is how SHOW WAREHOUSES prints the size,
 * `sql` the keyword ALTER/CREATE WAREHOUSE takes (ALTER WAREHOUSE docs,
 * 2026-10), and `credits` the per-hour credit rate of a standard (Gen1)
 * warehouse from Snowflake's service consumption table.
 */
export const WAREHOUSE_SIZES = [
  { sql: "XSMALL", show: "X-Small", credits: 1 },
  { sql: "SMALL", show: "Small", credits: 2 },
  { sql: "MEDIUM", show: "Medium", credits: 4 },
  { sql: "LARGE", show: "Large", credits: 8 },
  { sql: "XLARGE", show: "X-Large", credits: 16 },
  { sql: "XXLARGE", show: "2X-Large", credits: 32 },
  { sql: "XXXLARGE", show: "3X-Large", credits: 64 },
  { sql: "X4LARGE", show: "4X-Large", credits: 128 },
  { sql: "X5LARGE", show: "5X-Large", credits: 256 },
  { sql: "X6LARGE", show: "6X-Large", credits: 512 },
] as const;

export type WarehouseSize = (typeof WAREHOUSE_SIZES)[number];

/** Finds a size by either spelling (`X-Small`, `XSMALL`, `x-small`). */
export function findSize(value: string | undefined): WarehouseSize | undefined {
  if (!value) return undefined;
  const v = value.trim().toUpperCase().replace(/[-\s]/g, "");
  return WAREHOUSE_SIZES.find(
    (s) => s.sql === v || s.show.toUpperCase().replace(/[-\s]/g, "") === v,
  );
}

export function sizeIndex(value: string | undefined): number {
  const size = findSize(value);
  return size ? WAREHOUSE_SIZES.indexOf(size) : -1;
}

/** Service groups costs are reported under (the `service` cost dimension). */
export const SERVICE = {
  warehouse: "Warehouse compute",
  cloudServices: "Cloud services",
  serverless: "Serverless features",
  storage: "Storage",
  dataTransfer: "Data transfer",
  ai: "AI services",
  support: "Support",
  other: "Other",
} as const;

/**
 * Snowflake `SERVICE_TYPE` (METERING_DAILY_HISTORY, USAGE_IN_CURRENCY_DAILY)
 * to the group above. Anything not listed that consumes compute is a
 * serverless feature: Snowflake adds new serverless service types regularly
 * and they are all billed the same way.
 */
export function serviceGroup(serviceType: string, ratingType?: string): string {
  const t = serviceType.toUpperCase();
  const r = (ratingType ?? "").toLowerCase();
  // Archive-storage *writes* and lifecycle-policy runs are metered in credits
  // (rating type compute), so only the rating type or the plain STORAGE type
  // count as storage.
  if (r === "storage" || t === "STORAGE") return SERVICE.storage;
  if (r === "data_transfer" || t.includes("DATA_TRANSFER")) return SERVICE.dataTransfer;
  if (t === "WAREHOUSE_METERING" || t === "WAREHOUSE_METERING_READER") return SERVICE.warehouse;
  if (t === "CLOUD_SERVICES") return SERVICE.cloudServices;
  if (t.startsWith("AI_") || t.startsWith("CORTEX")) return SERVICE.ai;
  if (t.includes("SUPPORT")) return SERVICE.support;
  if (!t) return SERVICE.other;
  return SERVICE.serverless;
}

/** `WAREHOUSE_METERING` to `Warehouse metering`, for tags and labels. */
export function humanServiceType(serviceType: string): string {
  const s = serviceType.toLowerCase().replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
}

/** Credential keys for the user-editable prices. */
export const RATE_KEYS = {
  creditPrice: "creditPrice",
  storagePerTb: "storagePricePerTb",
  transferPerTb: "dataTransferPricePerTb",
  currency: "priceCurrency",
} as const;

/**
 * List prices on AWS US East: $3 per credit on Enterprise ($2 Standard, $4
 * Business Critical) and $23 per TB-month of capacity storage (on-demand is
 * about $40). Snowflake publishes no single data-transfer price, so transfer
 * is only estimated once the user enters one.
 */
export const DEFAULT_RATES = {
  creditPrice: "3.00",
  storagePerTb: "23.00",
  currency: "USD",
} as const;

export interface SnowflakeRates {
  creditPrice: number;
  storagePerTbMonth: number;
  transferPerTb: number | undefined;
  currency: string;
}

function rate(raw: string | undefined, fallback: string | undefined): number | undefined {
  const value = (raw ?? "").trim() || fallback;
  if (value === undefined || value === "") return undefined;
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function parseRates(credentials: Record<string, string>): SnowflakeRates {
  const currency = (credentials[RATE_KEYS.currency] ?? "").trim().toUpperCase();
  return {
    creditPrice: rate(credentials[RATE_KEYS.creditPrice], DEFAULT_RATES.creditPrice) ?? 3,
    storagePerTbMonth: rate(credentials[RATE_KEYS.storagePerTb], DEFAULT_RATES.storagePerTb) ?? 23,
    transferPerTb: rate(credentials[RATE_KEYS.transferPerTb], undefined),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_RATES.currency,
  };
}
