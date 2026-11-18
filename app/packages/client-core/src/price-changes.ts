/**
 * Provider price-change watch: the shared contract and the pure half.
 *
 * A *price change* is a provider's list price for one instance type, in one
 * region and variant, moving from one value to another at an instant. The
 * history comes from the instance pricing warehouse (one row per period a
 * price held, see `pricing-warehouse.ts`), so a change is two adjacent
 * periods of one product there. The org's side of a change is which of its
 * running resources pay that price (plugins say so through
 * `Plugin.instancePricingUsage`) and what the change does to its monthly
 * bill at list price.
 *
 * Every surface reads this module: the Price catalog tab's Changes view on
 * web and desktop, the settings section, the poller's detector and alert,
 * the weekly digest, the `infrawrench price-changes` CLI and the mobile push
 * route. Rows in, figures out: no clock of its own (callers pass `now`), no
 * network calls except the thin `fetch*` wrappers at the bottom.
 */
import type { CloudFetch } from "./fetch";

/** Hours a list price per hour is multiplied by to state a month: the catalog's own 730. */
export const PRICE_CHANGE_HOURS_PER_MONTH = 730;

/** Days back the daily scan looks for changes. */
export const PRICE_CHANGE_LOOKBACK_DAYS = 35;

/**
 * A change found later than this after it took effect is recorded but not
 * alerted: the first scan after the feature ships (or after a resource of that
 * type appears) should not page about a month of old news.
 */
export const PRICE_CHANGE_ALERT_WINDOW_DAYS = 7;

/** Days a registered "expected" suppression covers from the day the price takes effect. */
export const PRICE_CHANGE_EXPECTED_DAYS = 7;

/** The shipped defaults for an org with no settings row. */
export const PRICE_CHANGE_DEFAULTS = {
  enabled: true,
  /** $10 a month. */
  minMonthlyImpactCents: 1000,
  minPercent: 1,
  registerExpected: true,
} as const;

/** Bounds the API enforces on the org's settings; shared by form, server and Terraform docs. */
export const PRICE_CHANGE_LIMITS = {
  /** Up to $1,000,000 a month. */
  minMonthlyImpactCents: { min: 0, max: 100_000_000 },
  minPercent: { min: 0, max: 100 },
  /** Catalog-wide list: how far back, in days. */
  catalogDays: { min: 1, max: 365, default: 90 },
  /** Org list: how far back, in days. */
  listDays: { min: 1, max: 730, default: 180 },
} as const;

export interface PriceChangeSettings {
  /** Whether the daily scan (and so its alerts) runs at all. */
  enabled: boolean;
  /** Changes moving the org's monthly cost by less than this, in cents of USD, are not alerted. */
  minMonthlyImpactCents: number;
  /** Changes under this percentage of the old price are not alerted. */
  minPercent: number;
  /** Register an alerted increase as expected, so anomaly detection does not fire on the step. */
  registerExpected: boolean;
  /** When the last daily scan completed (ISO); owned by the poller. */
  lastNotifiedAt: string | null;
}

export type PriceChangeSettingsPatch = Partial<
  Pick<
    PriceChangeSettings,
    "enabled" | "minMonthlyImpactCents" | "minPercent" | "registerExpected"
  >
>;

/** A settings patch's first problem, or null. The server and the form both run it. */
export function priceChangeSettingsError(patch: PriceChangeSettingsPatch): string | null {
  const { minMonthlyImpactCents: cents, minPercent: pct } = PRICE_CHANGE_LIMITS;
  if (patch.minMonthlyImpactCents !== undefined) {
    const v = patch.minMonthlyImpactCents;
    if (!Number.isInteger(v) || v < cents.min || v > cents.max) {
      return `minMonthlyImpactCents must be a whole number from ${cents.min} to ${cents.max}`;
    }
  }
  if (patch.minPercent !== undefined) {
    const v = patch.minPercent;
    if (!Number.isFinite(v) || v < pct.min || v > pct.max) {
      return `minPercent must be from ${pct.min} to ${pct.max}`;
    }
  }
  return null;
}

/** One of the org's resources a change hits. */
export interface PriceChangeResource {
  resourceId: string;
  displayName: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string;
  /** Instances, nodes or GPUs of the type it runs. */
  units: number;
  /** True when `units` is a lower bound (a cluster whose node count is not synced). */
  approximate: boolean;
}

/** A list-price change for an instance type the org runs, as the API returns it. */
export interface PriceChange {
  id: string;
  pluginId: string;
  /** The warehouse's platform: `ec2`, `rds`, `azure`, `gcp`, `alibaba`, `runpod`... */
  platform: string;
  instanceType: string;
  region: string;
  /** The variant matched (operating system, engine...), keyed like the warehouse's columns. */
  selection: Record<string, string>;
  oldHourlyUsd: number;
  newHourlyUsd: number;
  /** (new / old - 1) x 100. */
  percent: number;
  /** When the new price takes (or took) effect, ISO. */
  effectiveAt: string;
  /** True while `effectiveAt` is in the future. */
  upcoming: boolean;
  units: number;
  approximate: boolean;
  /** What the change does to the org's monthly bill at list price, USD; negative for a cut. */
  monthlyImpactUsd: number;
  resources: PriceChangeResource[];
  /** True when it falls under the org's thresholds (recorded, not alerted). */
  belowThreshold: boolean;
  alertedAt: string | null;
  /** Anomaly suppressions registered for it. */
  suppressionIds: string[];
  /** The scenario model made from it, when it still exists. */
  scenarioModelId: string | null;
  detectedAt: string;
  /** The instance's page on instances.infrawrench.com, with its price history. */
  pageUrl: string;
}

export interface PriceChangeListResponse {
  changes: PriceChange[];
  /** False when the server has no pricing warehouse to read history from. */
  available: boolean;
  /** When the last daily scan completed; null before the first. */
  lastScannedAt: string | null;
  /** The thresholds `belowThreshold` was judged against. */
  minMonthlyImpactCents: number;
  minPercent: number;
}

/** A list-price change anywhere in the catalog (not tied to the org's resources). */
export interface CatalogPriceChange {
  platform: string;
  instanceType: string;
  region: string;
  /** The variant, in words (`PostgreSQL, Multi-AZ`); empty for a plain Linux instance. */
  variant: string;
  oldHourlyUsd: number;
  newHourlyUsd: number;
  percent: number;
  effectiveAt: string;
  vcpu: number | null;
  memoryGib: number | null;
  pageUrl: string;
}

export interface CatalogPriceChangeResponse {
  available: boolean;
  /** Every platform the warehouse prices, for the provider picker. */
  platforms: string[];
  platform: string;
  days: number;
  changes: CatalogPriceChange[];
  /** More changes matched than were returned. */
  truncated: boolean;
}

/** The warehouse's platform names, in words; a platform missing here shows its code. */
export const PRICE_CHANGE_PLATFORM_LABELS: Readonly<Record<string, string>> = {
  ec2: "Amazon EC2",
  rds: "Amazon RDS",
  elasticache: "Amazon ElastiCache",
  opensearch: "Amazon OpenSearch",
  redshift: "Amazon Redshift",
  docdb: "Amazon DocumentDB",
  neptune: "Amazon Neptune",
  memorydb: "Amazon MemoryDB",
  dax: "Amazon DynamoDB Accelerator",
  sagemaker: "Amazon SageMaker",
  emr: "Amazon EMR",
  gamelift: "Amazon GameLift",
  azure: "Azure Virtual Machines",
  gcp: "Google Compute Engine",
  alibaba: "Alibaba Cloud ECS",
  oracle: "Oracle Cloud",
  ibm: "IBM Cloud",
  hetzner: "Hetzner Cloud",
  hetznerauction: "Hetzner Server Auction",
  ovh: "OVHcloud",
  ovheco: "OVHcloud Eco",
  runpod: "RunPod",
};

export function priceChangePlatformLabel(platform: string): string {
  return PRICE_CHANGE_PLATFORM_LABELS[platform] ?? platform;
}

/**
 * A change's identity within an org: the product and the instant the new
 * price took effect. Selection keys are sorted so the same variant always
 * keys the same way.
 */
export function priceChangeKey(change: {
  platform: string;
  instanceType: string;
  region: string;
  selection: Readonly<Record<string, string>>;
  effectiveAt: string | Date;
}): string {
  const at =
    change.effectiveAt instanceof Date ? change.effectiveAt.toISOString() : change.effectiveAt;
  const selection = Object.keys(change.selection)
    .sort()
    .map((k) => `${k}=${change.selection[k]}`)
    .join(",");
  return [change.platform, change.instanceType, change.region, selection, at].join("|");
}

/** (new / old - 1) x 100, or 0 when the old price is not positive. */
export function priceChangePercent(oldHourly: number, newHourly: number): number {
  if (!(oldHourly > 0)) return 0;
  return (newHourly / oldHourly - 1) * 100;
}

/** What a change does to a month at list price for `units` of the type, USD. */
export function priceChangeMonthlyImpact(
  oldHourly: number,
  newHourly: number,
  units: number,
): number {
  return (newHourly - oldHourly) * PRICE_CHANGE_HOURS_PER_MONTH * units;
}

/** Whether a change clears both of the org's thresholds (either direction). */
export function priceChangeCrossesThreshold(
  change: Pick<PriceChange, "monthlyImpactUsd" | "percent">,
  settings: Pick<PriceChangeSettings, "minMonthlyImpactCents" | "minPercent">,
): boolean {
  const cents = Math.round(Math.abs(change.monthlyImpactUsd) * 100);
  return cents >= settings.minMonthlyImpactCents && Math.abs(change.percent) >= settings.minPercent;
}

/** USD with cents, signed when asked: `+$12.40`, `-$3.00`. */
export function formatPriceChangeUsd(amount: number, opts: { signed?: boolean } = {}): string {
  const abs = Math.abs(amount);
  const text = `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!opts.signed) return amount < 0 ? `-${text}` : text;
  return `${amount < 0 ? "-" : "+"}${text}`;
}

/** An hourly list price with as many decimals as it needs: `$0.096/hr`, `$12.50/hr`. */
export function formatPriceChangeHourly(amount: number): string {
  const digits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6;
  const text = amount.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}/hr`;
}

/** `+12.5%`, `-3%`. */
export function formatPriceChangePercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** `m5.large in us-east-1 (Amazon EC2)`. */
export function priceChangeSubject(
  change: Pick<PriceChange, "platform" | "instanceType" | "region">,
): string {
  const where = change.region && change.region !== "global" ? ` in ${change.region}` : "";
  return `${change.instanceType}${where} (${priceChangePlatformLabel(change.platform)})`;
}

/** Selection keys worth naming in a change's variant, in the order they read. */
const VARIANT_LABEL_KEYS = [
  "operating_system",
  "database_engine",
  "database_edition",
  "deployment_option",
  "cache_engine",
  "variant.cloudType",
] as const;

/** A change's variant in words (`Linux`, `PostgreSQL, Multi-AZ`); empty when nothing narrows it. */
export function priceChangeVariantLabel(selection: Readonly<Record<string, string>>): string {
  return VARIANT_LABEL_KEYS.map((k) => selection[k])
    .filter((v): v is string => !!v)
    .join(", ");
}

/** The day a change takes effect, YYYY-MM-DD (UTC). */
export function priceChangeDay(effectiveAt: string): string {
  return effectiveAt.slice(0, 10);
}

/**
 * The alert's one-line summary: "m5.large in us-east-1 (Amazon EC2) goes from
 * $0.096/hr to $0.105/hr on 2026-12-01, +$39.42/mo for your 6 instances".
 */
export function priceChangeSentence(
  change: Pick<
    PriceChange,
    | "platform"
    | "instanceType"
    | "region"
    | "oldHourlyUsd"
    | "newHourlyUsd"
    | "effectiveAt"
    | "upcoming"
    | "monthlyImpactUsd"
    | "units"
    | "approximate"
  >,
): string {
  const verb = change.upcoming ? "goes" : "went";
  const units = `${change.approximate ? "at least " : ""}${change.units} ${
    change.units === 1 ? "instance" : "instances"
  }`;
  return (
    `${priceChangeSubject(change)} ${verb} from ${formatPriceChangeHourly(change.oldHourlyUsd)} ` +
    `to ${formatPriceChangeHourly(change.newHourlyUsd)} on ${priceChangeDay(change.effectiveAt)}, ` +
    `${formatPriceChangeUsd(change.monthlyImpactUsd, { signed: true })}/mo for your ${units}`
  );
}

/** Biggest monthly impact first, then the most recent. */
export function sortPriceChanges<T extends Pick<PriceChange, "monthlyImpactUsd" | "effectiveAt">>(
  changes: readonly T[],
): T[] {
  return [...changes].sort(
    (a, b) =>
      Math.abs(b.monthlyImpactUsd) - Math.abs(a.monthlyImpactUsd) ||
      b.effectiveAt.localeCompare(a.effectiveAt),
  );
}

/** The net monthly impact of alertable changes, for the digest and summaries. */
export function summarizePriceChanges(changes: readonly PriceChange[]): {
  count: number;
  increases: number;
  decreases: number;
  netMonthlyUsd: number;
} {
  let increases = 0;
  let decreases = 0;
  let net = 0;
  for (const c of changes) {
    if (c.monthlyImpactUsd > 0) increases++;
    else if (c.monthlyImpactUsd < 0) decreases++;
    net += c.monthlyImpactUsd;
  }
  return { count: changes.length, increases, decreases, netMonthlyUsd: net };
}

export function emptyPriceChangeListResponse(): PriceChangeListResponse {
  return {
    changes: [],
    available: false,
    lastScannedAt: null,
    minMonthlyImpactCents: PRICE_CHANGE_DEFAULTS.minMonthlyImpactCents,
    minPercent: PRICE_CHANGE_DEFAULTS.minPercent,
  };
}

/** `GET /price-changes`. */
export async function fetchPriceChanges(
  api: CloudFetch,
  orgId: string,
  opts: { days?: number } = {},
): Promise<PriceChangeListResponse> {
  const query = opts.days !== undefined ? `?days=${encodeURIComponent(String(opts.days))}` : "";
  const res = await api.org<PriceChangeListResponse>(orgId, `/price-changes${query}`);
  return res ?? emptyPriceChangeListResponse();
}

/** `GET /price-changes/catalog`. */
export async function fetchCatalogPriceChanges(
  api: CloudFetch,
  orgId: string,
  opts: { platform?: string; days?: number } = {},
): Promise<CatalogPriceChangeResponse | null> {
  const params = new URLSearchParams();
  if (opts.platform) params.set("platform", opts.platform);
  if (opts.days !== undefined) params.set("days", String(opts.days));
  const query = params.toString();
  return api.org<CatalogPriceChangeResponse>(
    orgId,
    `/price-changes/catalog${query ? `?${query}` : ""}`,
  );
}
