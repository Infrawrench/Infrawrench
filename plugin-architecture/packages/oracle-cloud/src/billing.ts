import {
  CreditAccessError,
  QuotaAccessError,
  type CreditBalance,
  type QuotaUsage,
} from "@infrawrench/plugin-base";
import { isAuthorizationGap, OciApiError, type OciApi } from "./api.js";
import { mapLimit } from "./inventory.js";

/**
 * Subscription commitments, OCI's own carbon report, and service limits.
 */

// ---------------------------------------------------------------------------
// Universal Credits / subscription commitments → credit burndown

interface SubscribedService {
  id?: string;
  product?: { name?: string; partNumber?: string };
  availableAmount?: string | number | null;
  usedAmount?: string | number | null;
  totalValue?: string | number | null;
  fundedAllocationValue?: string | number | null;
  pricingModel?: string;
  timeStart?: string;
  timeEnd?: string;
  status?: string;
}

interface SubscriptionSummary {
  status?: string;
  serviceName?: string;
  timeEnd?: string;
  currency?: { isoCode?: string } | string;
  subscribedServices?: SubscribedService[];
}

function money(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Remaining commitment per subscribed service, from OneSubscription
 * (`GET identity.{home}/20190111/subscriptions?isCommitInfoRequired=true`).
 * Only lines that carry an `availableAmount` are commitments (Universal
 * Credits annual or monthly flex, funded allocations); pay-as-you-go lines
 * carry none and are skipped. Tenancies on Oracle's older "classic"
 * subscription system return no subscriptions here at all, which reads as no
 * balance, not as zero.
 */
export async function fetchCommitmentBalances(
  api: OciApi,
  homeRegion: string,
): Promise<CreditBalance[]> {
  let subs: SubscriptionSummary[];
  try {
    subs = await api.listAll<SubscriptionSummary>({
      service: "identity",
      region: homeRegion,
      path: "/20190111/subscriptions",
      query: { compartmentId: api.tenancyOcid, isCommitInfoRequired: true, limit: 50 },
    });
  } catch (err) {
    if (isAuthorizationGap(err)) {
      throw new CreditAccessError(
        "This API key's user cannot read the tenancy's subscription details. A tenancy administrator can grant subscription read access to the user's group.",
        {
          label: "OCI subscription policies",
          url: "https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/subscriptionoverview.htm",
        },
      );
    }
    throw err;
  }
  const out: CreditBalance[] = [];
  for (const sub of subs) {
    const currency =
      (typeof sub.currency === "string" ? sub.currency : sub.currency?.isoCode) || "USD";
    for (const line of sub.subscribedServices ?? []) {
      const remaining = money(line.availableAmount);
      if (remaining === undefined) continue;
      const granted = money(line.fundedAllocationValue) ?? money(line.totalValue);
      const key = line.id ?? `${line.product?.partNumber ?? "commitment"}-${line.timeStart ?? ""}`;
      out.push({
        key,
        label: line.product?.name || sub.serviceName || "Universal Credits",
        remaining,
        currency,
        ...(granted !== undefined && granted > 0 ? { granted } : {}),
        ...(line.timeEnd || sub.timeEnd ? { expiresAt: (line.timeEnd ?? sub.timeEnd)! } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OCI carbon emissions (provider-reported)

export interface CarbonByService {
  service: string;
  tonnes: number;
}

/**
 * Month-to-date emissions as OCI itself reports them
 * (`POST /20200107/usageCarbonEmissions`), location-based, grouped by
 * service. Power-based where OCI supports it, spend-based otherwise; the
 * method used is returned so the detail view can say which it is.
 */
export async function fetchCarbonReport(
  api: OciApi,
  homeRegion: string,
  now = new Date(),
): Promise<{ method: string; rows: CarbonByService[] }> {
  const today = now.toISOString().slice(0, 10);
  const start = `${today.slice(0, 7)}-01T00:00:00Z`;
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString();
  for (const method of ["POWER_BASED", "SPEND_BASED"]) {
    try {
      const items = await api.listAll<{ service?: string; computedCarbonEmission?: number }>({
        service: "usageapi",
        region: homeRegion,
        method: "POST",
        path: "/20200107/usageCarbonEmissions",
        query: { limit: 1000 },
        body: {
          tenantId: api.tenancyOcid,
          timeUsageStarted: start,
          timeUsageEnded: end.slice(0, 10) + "T00:00:00Z",
          emissionCalculationMethod: method,
          emissionType: "LOCATION_BASED",
          granularity: "MONTHLY",
          isAggregateByTime: true,
          groupBy: ["service"],
        },
      });
      const rows = items
        .filter((i) => Number.isFinite(i.computedCarbonEmission))
        .map((i) => ({ service: i.service || "Other", tonnes: i.computedCarbonEmission! }))
        .sort((a, b) => b.tonnes - a.tonnes);
      return { method, rows };
    } catch (err) {
      if (method === "POWER_BASED" && err instanceof OciApiError && err.status === 400) continue;
      throw err;
    }
  }
  return { method: "SPEND_BASED", rows: [] };
}

// ---------------------------------------------------------------------------
// Service limits → quota radar

/** Limits services worth watching, intersected with what the tenancy offers. */
const WATCHED_SERVICES = [
  "vcn",
  "load-balancer",
  "block-storage",
  "database",
  "container-engine",
  "object-storage",
];
const MAX_AVAILABILITY_CALLS = 40;

interface LimitDefinition {
  name: string;
  serviceName: string;
  description?: string;
  scopeType: string;
  isResourceAvailabilitySupported?: boolean;
  isDeprecated?: boolean;
  isEligibleForLimitIncrease?: boolean;
}

/**
 * Regional limits in the home region for a bounded set of services, both
 * halves from the Limits API: the limit from `limitValues`, usage from
 * `resourceAvailability`. Limits whose value is zero (not enabled for the
 * tenancy) are skipped; any failed availability read fails the pass, because
 * a silently short list reads as limits having disappeared.
 */
export async function fetchServiceLimits(api: OciApi, homeRegion: string): Promise<QuotaUsage[]> {
  const tenancy = api.tenancyOcid;
  const base = { service: "limits" as const, region: homeRegion };
  let services: Array<{ name: string }>;
  try {
    services = await api.listAll<{ name: string }>({
      ...base,
      path: "/20190729/services",
      query: { compartmentId: tenancy, limit: 1000 },
    });
  } catch (err) {
    if (isAuthorizationGap(err)) {
      throw new QuotaAccessError(
        "This API key's user cannot read service limits. Add an IAM policy such as `Allow group <your-group> to inspect resource-availability in tenancy`.",
        {
          label: "OCI limits policies",
          url: "https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm",
        },
      );
    }
    throw err;
  }
  const available = new Set(services.map((s) => s.name));
  const wanted = WATCHED_SERVICES.filter((s) => available.has(s));
  const candidates: Array<{ def: LimitDefinition; limit: number }> = [];
  for (const serviceName of wanted) {
    const [defs, values] = await Promise.all([
      api.listAll<LimitDefinition>({
        ...base,
        path: "/20190729/limitDefinitions",
        query: { compartmentId: tenancy, serviceName, limit: 1000 },
      }),
      api.listAll<{ name: string; scopeType: string; value: number }>({
        ...base,
        path: "/20190729/limitValues",
        query: { compartmentId: tenancy, serviceName, scopeType: "REGION", limit: 1000 },
      }),
    ]);
    const valueByName = new Map(values.map((v) => [v.name, v.value]));
    for (const def of defs) {
      if (def.isDeprecated || !def.isResourceAvailabilitySupported || def.scopeType !== "REGION") {
        continue;
      }
      const limit = valueByName.get(def.name);
      if (limit === undefined || !(limit > 0)) continue;
      candidates.push({ def, limit });
    }
  }
  const bounded = candidates.slice(0, MAX_AVAILABILITY_CALLS);
  const readings = await mapLimit(bounded, 5, async ({ def, limit }) => {
    const availability = await api.get<{ used?: number }>(
      "limits",
      homeRegion,
      `/20190729/services/${encodeURIComponent(def.serviceName)}/limits/${encodeURIComponent(def.name)}/resourceAvailability`,
      { compartmentId: tenancy },
    );
    const reading: QuotaUsage = {
      id: `${homeRegion}/${def.serviceName}/${def.name}`,
      service: def.serviceName,
      name: def.description || def.name,
      region: homeRegion,
      limit,
      used: availability.used ?? 0,
      adjustable: def.isEligibleForLimitIncrease !== false,
      docsUrl: "https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm",
    };
    return reading;
  });
  return readings;
}
