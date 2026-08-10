/**
 * Live AWS on-demand pricing via the Price List Query API
 * (`pricing:GetProducts`) — the per-region rate source behind both the size
 * picker's prices and `cost-estimate.ts`, following the shape of
 * `azure/src/pricing.ts` / `gcp/src/pricing.ts` (fetch + parse + cache;
 * plugin owns the provider specifics, host reads generic monthly prices).
 *
 * The API is a SigV4-signed JSON-RPC service that lives in us-east-1
 * regardless of the account's home region; the *resource's* region goes into
 * the `regionCode` filter. One GetProducts call per priced thing keeps each
 * response tiny and lets results cache per (service, region, dimensions) for
 * 6 hours — which is what makes it safe for the create form to re-estimate on
 * every keystroke.
 *
 * Docs: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html
 */
import type { AwsCredentials } from "./auth.js";
import { fetchSigned } from "./signed-request.js";

const PRICING_HOST = "api.pricing.us-east-1.amazonaws.com";
const PRICING_REGION = "us-east-1";
export const HOURS_PER_MONTH = 730;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** `PriceList` entries arrive as JSON-encoded strings; this is their parsed shape. */
interface PriceListEntry {
  terms?: {
    OnDemand?: Record<
      string,
      {
        priceDimensions?: Record<string, { unit?: string; pricePerUnit?: Record<string, string> }>;
      }
    >;
  };
}

interface GetProductsResponse {
  PriceList?: string[];
  NextToken?: string;
}

/** Cache key (service + region + dimensions) → rate in its own unit, with expiry. */
const priceCache = new Map<string, { expiresAt: number; usd: number | null }>();

/** Test hook — clears the module-level cache. */
export function clearEc2PriceCache(): void {
  priceCache.clear();
}

/**
 * Extract the cheapest positive on-demand USD rate whose unit matches
 * `unitPattern` from a GetProducts response. A dimension with no unit at all
 * is accepted — some SKUs omit it — but a unit that is present and does not
 * match is skipped, which is what keeps an hourly query from picking up a
 * per-request or per-GB dimension off the same SKU.
 */
function parseOnDemandUsd(priceList: readonly string[], unitPattern: RegExp): number | null {
  let best: number | null = null;
  for (const raw of priceList) {
    let entry: PriceListEntry;
    try {
      entry = JSON.parse(raw) as PriceListEntry;
    } catch {
      continue;
    }
    for (const term of Object.values(entry.terms?.OnDemand ?? {})) {
      for (const dim of Object.values(term.priceDimensions ?? {})) {
        if (dim.unit !== undefined && !unitPattern.test(dim.unit)) continue;
        const usd = Number(dim.pricePerUnit?.["USD"] ?? "");
        if (Number.isFinite(usd) && usd > 0 && (best === null || usd < best)) best = usd;
      }
    }
  }
  return best;
}

/** Units the Price List API uses for time-priced products. */
const HOURLY_UNIT = /hrs?/i;
/** Units it uses for capacity-priced ones (EBS volumes, RDS allocated storage). */
const GB_MONTH_UNIT = /gb-mo/i;

/**
 * Extract the cheapest positive on-demand USD hourly rate from a GetProducts
 * response. Exported for tests.
 */
export function parseOnDemandHourlyUsd(priceList: readonly string[]): number | null {
  return parseOnDemandUsd(priceList, HOURLY_UNIT);
}

async function getProducts(
  credentials: AwsCredentials,
  body: Record<string, unknown>,
): Promise<GetProductsResponse> {
  const res = await fetchSigned({
    method: "POST",
    url: `https://${PRICING_HOST}/`,
    headers: {
      Host: PRICING_HOST,
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSPriceListService.GetProducts",
    },
    body: JSON.stringify(body),
    service: "pricing",
    credentials: { ...credentials, region: PRICING_REGION },
  });
  return (await res.json()) as GetProductsResponse;
}

const termMatch = (field: string, value: string) => ({
  Type: "TERM_MATCH",
  Field: field,
  Value: value,
});

type PriceFilter = ReturnType<typeof termMatch>;

/**
 * Filters that pin one clean price per instance type: Linux, shared tenancy,
 * no pre-installed software, standard capacity — the row the EC2 console's
 * on-demand price is quoting.
 */
function filtersFor(regionCode: string, instanceType: string): PriceFilter[] {
  return [
    termMatch("instanceType", instanceType),
    termMatch("regionCode", regionCode),
    termMatch("operatingSystem", "Linux"),
    termMatch("tenancy", "Shared"),
    termMatch("preInstalledSw", "NA"),
    termMatch("capacitystatus", "Used"),
  ];
}

/**
 * One cached GetProducts lookup. Every priced dimension in this module goes
 * through here, so the 6h cache, the "return null rather than guess" failure
 * mode, and the don't-cache-a-failure rule are all decided once.
 */
async function fetchRateUsd(
  credentials: AwsCredentials,
  cacheKey: string,
  serviceCode: string,
  filters: PriceFilter[],
  unitPattern: RegExp,
): Promise<number | null> {
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.usd;

  let usd: number | null = null;
  try {
    const response = await getProducts(credentials, {
      ServiceCode: serviceCode,
      Filters: filters,
      FormatVersion: "aws_v1",
      MaxResults: 100,
    });
    usd = parseOnDemandUsd(response.PriceList ?? [], unitPattern);
  } catch {
    // Missing pricing permission or a transient failure — quote nothing
    // rather than something wrong; don't cache so a retry can succeed.
    return null;
  }
  priceCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, usd });
  return usd;
}

async function fetchHourlyUsd(
  credentials: AwsCredentials,
  regionCode: string,
  instanceType: string,
): Promise<number | null> {
  return fetchRateUsd(
    credentials,
    `ec2 ${regionCode} ${instanceType}`,
    "AmazonEC2",
    filtersFor(regionCode, instanceType),
    HOURLY_UNIT,
  );
}

/**
 * Monthly on-demand USD prices for a set of instance types in one region.
 * Types without a resolvable price are omitted (never guessed).
 */
export async function fetchEc2MonthlyPrices(
  credentials: AwsCredentials,
  regionCode: string,
  instanceTypes: readonly string[],
): Promise<Record<string, number>> {
  const unique = [...new Set(instanceTypes)];
  const rates = await Promise.all(
    unique.map((type) => fetchHourlyUsd(credentials, regionCode, type)),
  );
  const out: Record<string, number> = {};
  unique.forEach((type, i) => {
    const hourly = rates[i];
    if (hourly != null) out[type] = Number((hourly * HOURS_PER_MONTH).toFixed(2));
  });
  return out;
}

/** Monthly on-demand USD price for one EC2 instance type, or null. */
export async function fetchEc2MonthlyPrice(
  credentials: AwsCredentials,
  regionCode: string,
  instanceType: string,
): Promise<number | null> {
  const hourly = await fetchHourlyUsd(credentials, regionCode, instanceType);
  return hourly == null ? null : Number((hourly * HOURS_PER_MONTH).toFixed(2));
}

/**
 * Per-GB-month USD price for an EBS volume type (`gp3`, `io2`, `st1`, …) in
 * one region. `volumeApiName` is the filter field that carries exactly the
 * identifiers the create form's volume-type select offers, so no mapping
 * table is needed between the two — which is precisely what went stale in the
 * static table this replaced.
 */
export async function fetchEbsGbMonthPrice(
  credentials: AwsCredentials,
  regionCode: string,
  volumeType: string,
): Promise<number | null> {
  return fetchRateUsd(
    credentials,
    `ebs ${regionCode} ${volumeType}`,
    "AmazonEC2",
    [
      termMatch("regionCode", regionCode),
      termMatch("productFamily", "Storage"),
      termMatch("volumeApiName", volumeType),
    ],
    GB_MONTH_UNIT,
  );
}

/**
 * The Price List API names database engines in prose ("PostgreSQL"), while
 * both the create form and the RDS API use the engine identifier
 * ("postgres"). Aurora engines are priced as their own `databaseEngine`
 * values. An engine absent from this map is one we cannot filter on, so the
 * caller quotes nothing rather than the wrong engine's price.
 *
 * The failure mode if AWS spells one of these differently than we do is the
 * safe one: the filter matches no SKU, `fetchRateUsd` returns null, and the
 * estimate drops that line and marks itself partial. It never falls through
 * to another engine's rate.
 */
const RDS_DATABASE_ENGINE: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  "aurora-postgresql": "Aurora PostgreSQL",
  "aurora-mysql": "Aurora MySQL",
};

/** Monthly on-demand USD price for one RDS instance class, or null. */
export async function fetchRdsMonthlyPrice(
  credentials: AwsCredentials,
  regionCode: string,
  instanceClass: string,
  engine: string,
  multiAz: boolean,
): Promise<number | null> {
  const databaseEngine = RDS_DATABASE_ENGINE[engine];
  if (!databaseEngine) return null;
  const deploymentOption = multiAz ? "Multi-AZ" : "Single-AZ";
  const hourly = await fetchRateUsd(
    credentials,
    `rds ${regionCode} ${instanceClass} ${databaseEngine} ${deploymentOption}`,
    "AmazonRDS",
    [
      termMatch("regionCode", regionCode),
      termMatch("instanceType", instanceClass),
      termMatch("databaseEngine", databaseEngine),
      termMatch("deploymentOption", deploymentOption),
    ],
    HOURLY_UNIT,
  );
  return hourly == null ? null : Number((hourly * HOURS_PER_MONTH).toFixed(2));
}

/**
 * Per-GB-month USD price for RDS allocated storage. `gp2` is what
 * `CreateDBInstance` provisions when the create form doesn't say otherwise,
 * and Multi-AZ storage is its own priced dimension rather than a doubling of
 * the single-AZ rate.
 */
export async function fetchRdsStorageGbMonthPrice(
  credentials: AwsCredentials,
  regionCode: string,
  multiAz: boolean,
  volumeName = "General Purpose",
): Promise<number | null> {
  const deploymentOption = multiAz ? "Multi-AZ" : "Single-AZ";
  return fetchRateUsd(
    credentials,
    `rds-storage ${regionCode} ${volumeName} ${deploymentOption}`,
    "AmazonRDS",
    [
      termMatch("regionCode", regionCode),
      termMatch("productFamily", "Database Storage"),
      termMatch("volumeName", volumeName),
      termMatch("deploymentOption", deploymentOption),
    ],
    GB_MONTH_UNIT,
  );
}
