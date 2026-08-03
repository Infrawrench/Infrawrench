/**
 * Live EC2 on-demand pricing via the AWS Price List Query API
 * (`pricing:GetProducts`) — the per-region replacement for the static
 * us-east-1 table in `cost-estimate.ts`, following the shape of
 * `azure/src/pricing.ts` / `gcp/src/pricing.ts` (fetch + parse + cache;
 * plugin owns the provider specifics, host reads generic monthly prices).
 *
 * The API is a SigV4-signed JSON-RPC service that lives in us-east-1
 * regardless of the account's home region; the *resource's* region goes into
 * the `regionCode` filter. One GetProducts call per instance type keeps each
 * response tiny and lets results cache per (region, type) for 6 hours.
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

/** (region, instanceType) → hourly USD, with expiry. */
const priceCache = new Map<string, { expiresAt: number; hourlyUsd: number | null }>();

/** Test hook — clears the module-level cache. */
export function clearEc2PriceCache(): void {
  priceCache.clear();
}

/**
 * Extract the cheapest positive on-demand USD hourly rate from a GetProducts
 * response. Exported for tests.
 */
export function parseOnDemandHourlyUsd(priceList: readonly string[]): number | null {
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
        if (dim.unit !== undefined && !/hrs?/i.test(dim.unit)) continue;
        const usd = Number(dim.pricePerUnit?.["USD"] ?? "");
        if (Number.isFinite(usd) && usd > 0 && (best === null || usd < best)) best = usd;
      }
    }
  }
  return best;
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

/**
 * Filters that pin one clean price per instance type: Linux, shared tenancy,
 * no pre-installed software, standard capacity — the row the EC2 console's
 * on-demand price is quoting.
 */
function filtersFor(regionCode: string, instanceType: string) {
  const f = (field: string, value: string) => ({ Type: "TERM_MATCH", Field: field, Value: value });
  return [
    f("instanceType", instanceType),
    f("regionCode", regionCode),
    f("operatingSystem", "Linux"),
    f("tenancy", "Shared"),
    f("preInstalledSw", "NA"),
    f("capacitystatus", "Used"),
  ];
}

async function fetchHourlyUsd(
  credentials: AwsCredentials,
  regionCode: string,
  instanceType: string,
): Promise<number | null> {
  const key = `${regionCode} ${instanceType}`;
  const cached = priceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.hourlyUsd;

  let hourly: number | null = null;
  try {
    const response = await getProducts(credentials, {
      ServiceCode: "AmazonEC2",
      Filters: filtersFor(regionCode, instanceType),
      FormatVersion: "aws_v1",
      MaxResults: 100,
    });
    hourly = parseOnDemandHourlyUsd(response.PriceList ?? []);
  } catch {
    // Missing pricing permission or a transient failure — quote nothing
    // rather than something wrong; don't cache so a retry can succeed.
    return null;
  }
  priceCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, hourlyUsd: hourly });
  return hourly;
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
