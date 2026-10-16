/**
 * Metric-based idle findings for Azure (`manifest.idleFindings`), read from
 * Azure Monitor (`Microsoft.Insights/metrics`) at a one-day interval and
 * priced from the Azure Retail Prices API.
 *
 * Metric names and aggregations are from the supported-metrics references
 * (verified 2026-10):
 * - Load balancer: https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-loadbalancers-metrics
 *   (`ByteCount` Total, `VipAvailability` Average; Standard SKU only).
 * - NAT gateway: https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-natgateways-metrics
 *   (`ByteCount`, `TotalConnectionCount` Total, `DatapathAvailability` Average).
 * - Application gateway: https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-applicationgateways-metrics
 *   (`TotalRequests` Total, `HealthyHostCount` Average, `CapacityUnits` Average).
 *
 * Billing facts the rules lean on: a Standard load balancer with no rules
 * bills nothing, so only balancers with rules are judged; a NAT gateway bills
 * by the hour whether or not a subnet uses it, so one attached to no subnet is
 * idle without reading a metric; a stopped application gateway bills nothing
 * and is skipped.
 */
import {
  IdleFindingAccessError,
  type IdleFindingRecord,
  type IdleFindingsCapabilityDeclaration,
  type IdleMetricEvidence,
  type IdleScanRequest,
  type IdleScanResource,
} from "@infrawrench/plugin-base";

import type { HttpHostServices } from "@infrawrench/plugin-base";
import { fetchRetailPrices, type RetailPriceItem } from "./pricing.js";

const DAY_MS = 86_400_000;
const MB = 1_000_000;
const HOURS_PER_MONTH = 730;
const ARM = "https://management.azure.com";

export const AZURE_IDLE_FINDINGS: IdleFindingsCapabilityDeclaration = {
  rules: [
    {
      id: "load-balancer",
      label: "Idle load balancer",
      description:
        "A Standard load balancer with rules that moved next to no bytes over the lookback window. Rules bill by the hour whether or not traffic flows.",
      resourceTypeIds: ["azure-load-balancer"],
      action: "remove",
      thresholds: [
        {
          key: "maxBytes",
          label: "Bytes transmitted",
          description: "Total ByteCount over the window at or under which it is idle.",
          unit: "bytes",
          default: 1 * MB,
          min: 0,
          max: 10_000 * MB,
        },
      ],
    },
    {
      id: "nat-gateway",
      label: "Idle NAT gateway",
      description:
        "A NAT gateway attached to no subnet, or one that moved next to no bytes over the lookback window. It bills by the hour either way.",
      resourceTypeIds: ["azure-nat-gateway"],
      action: "remove",
      thresholds: [
        {
          key: "maxBytes",
          label: "Bytes transmitted",
          unit: "bytes",
          default: 1 * MB,
          min: 0,
          max: 10_000 * MB,
        },
      ],
    },
    {
      id: "app-gateway",
      label: "Idle application gateway",
      description:
        "A running application gateway that served next to no requests over the lookback window, or had no healthy backend the whole time.",
      resourceTypeIds: ["azure-app-gateway"],
      action: "remove",
      thresholds: [
        {
          key: "maxRequests",
          label: "Requests",
          description: "Total TotalRequests over the window at or under which it is idle.",
          unit: "count",
          default: 100,
          min: 0,
          max: 1_000_000,
        },
      ],
    },
  ],
};

/** One metric read: daily values of one aggregation, oldest first. */
export type MetricReader = (
  resourceId: string,
  metric: string,
  aggregation: "Total" | "Average" | "Maximum",
  window: { start: Date; end: Date },
) => Promise<number[]>;

interface MetricsResponse {
  value?: Array<{
    timeseries?: Array<{ data?: Array<Record<string, unknown>> }>;
  }>;
}

/**
 * The real reader: `GET {resourceId}/providers/Microsoft.Insights/metrics`
 * with `interval=P1D`. Days with no value for the aggregation are omitted,
 * which is how coverage is counted.
 */
export function azureMonitorReader(get: <T>(url: string) => Promise<T>): MetricReader {
  return async (resourceId, metric, aggregation, window) => {
    const url =
      `${ARM}${resourceId}/providers/Microsoft.Insights/metrics?api-version=2018-01-01` +
      `&metricnames=${encodeURIComponent(metric)}` +
      `&timespan=${encodeURIComponent(`${window.start.toISOString()}/${window.end.toISOString()}`)}` +
      `&interval=P1D&aggregation=${aggregation}`;
    let response: MetricsResponse;
    try {
      response = await get<MetricsResponse>(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\b403\b|AuthorizationFailed/.test(message)) {
        throw new IdleFindingAccessError(
          "Azure Monitor denied the metrics read: grant Microsoft.Insights/metrics/read (the Monitoring Reader role).",
          {
            label: "Monitoring Reader role",
            url: "https://learn.microsoft.com/azure/azure-monitor/roles-permissions-security",
          },
        );
      }
      throw err;
    }
    const key = aggregation.toLowerCase();
    const points = (response.value?.[0]?.timeseries ?? []).flatMap((ts) => ts.data ?? []);
    // A metric split by no dimension has one timeseries; if Azure returns
    // several, days are summed (Total) or maxed (others) across them.
    const byDay = new Map<string, number>();
    for (const p of points) {
      const v = p[key];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const day = String(p["timeStamp"] ?? "").slice(0, 10);
      const prev = byDay.get(day);
      byDay.set(
        day,
        prev === undefined ? v : aggregation === "Total" ? prev + v : Math.max(prev, v),
      );
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  };
}

/** The ARM id of a stored row: the resolved output when the lister kept it, else built. */
export function armResourceId(
  subscriptionId: string,
  provider: string,
  resource: Pick<IdleScanResource, "fields" | "externalId" | "resolvedOutputs">,
): string {
  const output = resource.resolvedOutputs["resourceId"] ?? "";
  if (output.startsWith("/subscriptions/")) return output;
  const rg = String(resource.fields["resourceGroup"] ?? "");
  const name = String(resource.fields["name"] ?? "");
  if (!rg || !name || !subscriptionId) return "";
  return `/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(rg)}/providers/${provider}/${encodeURIComponent(name)}`;
}

const sum = (v: number[]): number | null => (v.length === 0 ? null : v.reduce((a, b) => a + b, 0));
const max = (v: number[]): number | null => (v.length === 0 ? null : Math.max(...v));

export function requiredCoverage(lookbackDays: number): number {
  return Math.max(1, lookbackDays - 2);
}

function ev(
  metric: string,
  label: string,
  statistic: IdleMetricEvidence["statistic"],
  value: number | null,
  unit: IdleMetricEvidence["unit"],
  threshold?: number,
): IdleMetricEvidence {
  return {
    metric,
    label,
    statistic,
    value,
    unit,
    ...(threshold !== undefined ? { threshold, comparison: "atMost" as const } : {}),
  };
}

function fmtBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < MB) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / MB).toFixed(1)} MB`;
}

interface Verdict {
  reason: string;
  evidence: IdleMetricEvidence[];
}

type Judge = (
  resource: IdleScanResource,
  thresholds: Record<string, number>,
  lookbackDays: number,
  window: { start: Date; end: Date },
  read: MetricReader,
  subscriptionId: string,
) => Promise<Verdict | null>;

export const judgeLoadBalancer: Judge = async (
  resource,
  thresholds,
  lookbackDays,
  window,
  read,
  sub,
) => {
  const f = resource.fields;
  if (String(f["sku"] ?? "").toLowerCase() !== "standard") return null; // Basic: free, retired
  if (!(Number(f["ruleCount"] ?? 0) > 0)) return null; // no rules: no hourly charge
  const id = armResourceId(sub, "Microsoft.Network/loadBalancers", resource);
  if (!id) return null;
  const [availability, bytes] = await Promise.all([
    read(id, "VipAvailability", "Average", window),
    read(id, "ByteCount", "Total", window),
  ]);
  // Data path availability is reported continuously for a Standard balancer
  // with a rule; without it, the read is not one to judge on.
  if (availability.length < requiredCoverage(lookbackDays)) return null;
  const total = sum(bytes) ?? 0;
  const maxBytes = thresholds["maxBytes"] ?? 1 * MB;
  if (total > maxBytes) return null;
  return {
    reason: `Moved ${fmtBytes(total)} over ${lookbackDays} days across ${Number(f["ruleCount"])} rule(s)`,
    evidence: [
      ev("ByteCount", "Bytes transmitted", "sum", total, "bytes", maxBytes),
      ev(
        "VipAvailability",
        "Data path availability",
        "average",
        Number(((sum(availability) ?? 0) / availability.length).toFixed(1)),
        "percent",
      ),
    ],
  };
};

export const judgeNatGateway: Judge = async (
  resource,
  thresholds,
  lookbackDays,
  window,
  read,
  sub,
) => {
  const f = resource.fields;
  if (Number(f["subnetCount"] ?? 1) === 0) {
    return {
      reason: "Attached to no subnet, so nothing can route through it",
      evidence: [
        {
          metric: "subnets",
          label: "Subnets attached",
          statistic: "count",
          value: 0,
          unit: "count",
          threshold: 0,
          comparison: "atMost",
        },
      ],
    };
  }
  const id = armResourceId(sub, "Microsoft.Network/natGateways", resource);
  if (!id) return null;
  const [availability, bytes, connections] = await Promise.all([
    read(id, "DatapathAvailability", "Average", window),
    read(id, "ByteCount", "Total", window),
    read(id, "TotalConnectionCount", "Total", window),
  ]);
  if (availability.length < requiredCoverage(lookbackDays)) return null;
  const total = sum(bytes) ?? 0;
  const maxBytes = thresholds["maxBytes"] ?? 1 * MB;
  if (total > maxBytes) return null;
  return {
    reason: `Moved ${fmtBytes(total)} over ${lookbackDays} days`,
    evidence: [
      ev("ByteCount", "Bytes transmitted", "sum", total, "bytes", maxBytes),
      ev("TotalConnectionCount", "Connections", "sum", sum(connections) ?? 0, "count"),
    ],
  };
};

export const judgeAppGateway: Judge = async (
  resource,
  thresholds,
  lookbackDays,
  window,
  read,
  sub,
) => {
  const f = resource.fields;
  if (String(f["operationalState"] ?? "Running") !== "Running") return null; // stopped: not billed
  const id = armResourceId(sub, "Microsoft.Network/applicationGateways", resource);
  if (!id) return null;
  const [capacity, requests, healthy] = await Promise.all([
    read(id, "CapacityUnits", "Average", window),
    read(id, "TotalRequests", "Total", window),
    read(id, "HealthyHostCount", "Average", window),
  ]);
  // Capacity units are reported for every running v2 gateway.
  if (capacity.length < requiredCoverage(lookbackDays)) return null;
  const total = sum(requests) ?? 0;
  const healthyPeak = max(healthy);
  const noHealthy = healthy.length >= requiredCoverage(lookbackDays) && healthyPeak === 0;
  const maxRequests = thresholds["maxRequests"] ?? 100;
  if (total > maxRequests && !noHealthy) return null;
  return {
    reason: noHealthy
      ? `No healthy backend in ${lookbackDays} days (${Math.round(total).toLocaleString("en-US")} requests)`
      : `${Math.round(total).toLocaleString("en-US")} requests over ${lookbackDays} days`,
    evidence: [
      ev("TotalRequests", "Requests", "sum", total, "count", maxRequests),
      ev("HealthyHostCount", "Peak healthy backends", "max", healthyPeak, "count"),
    ],
  };
};

/* --------------------------------------------------------------------------
 * Pricing (Azure Retail Prices; verified 2026-10)
 * ------------------------------------------------------------------------ */

/** Seam for tests: the retail price rows for one OData filter. */
export type PriceReader = (filter: string) => Promise<RetailPriceItem[]>;

function hourly(
  items: RetailPriceItem[],
  predicate: (i: RetailPriceItem) => boolean,
): number | null {
  const rates = items
    .filter((i) => i.type === "Consumption" && /hour/i.test(i.unitOfMeasure) && predicate(i))
    .map((i) => i.retailPrice)
    .filter((p) => Number.isFinite(p) && p > 0);
  return rates.length === 0 ? null : Math.min(...rates);
}

/**
 * Standard load balancer: the first five rules are one hourly meter
 * ("Standard Included LB Rules and Outbound Rules", priced Global), each rule
 * beyond five another ("Standard Overage LB Rules and Outbound Rules").
 */
export async function loadBalancerMonthly(
  ruleCount: number,
  prices: PriceReader,
): Promise<number | null> {
  const items = await prices(
    `serviceName eq 'Load Balancer' and armRegionName eq 'Global' and skuName eq 'Standard'`,
  );
  const included = hourly(
    items,
    (i) => i.meterName === "Standard Included LB Rules and Outbound Rules",
  );
  if (included === null) return null;
  const overage =
    hourly(items, (i) => i.meterName === "Standard Overage LB Rules and Outbound Rules") ?? 0;
  return (included + Math.max(0, ruleCount - 5) * overage) * HOURS_PER_MONTH;
}

/** NAT gateway: the hourly gateway meter of its SKU ("Standard Gateway"), priced Global. */
export async function natGatewayMonthly(sku: string, prices: PriceReader): Promise<number | null> {
  const skuName = sku || "Standard";
  const items = await prices(
    `productName eq 'NAT Gateway' and skuName eq '${skuName.replace(/'/g, "")}'`,
  );
  const rate = hourly(items, (i) => i.meterName === `${skuName} Gateway`);
  return rate === null ? null : rate * HOURS_PER_MONTH;
}

const APP_GATEWAY_PRODUCT: Record<string, { product: string; meter: string }> = {
  standard_v2: { product: "Application Gateway Standard v2", meter: "Standard Fixed Cost" },
  waf_v2: { product: "Application Gateway WAF v2", meter: "Standard Fixed Cost" },
  basic: { product: "Application Gateway Basic v2", meter: "Basic Fixed Cost" },
};

/** Application gateway v2: the regional fixed hourly cost of its tier (capacity units extra). */
export async function appGatewayMonthly(
  tier: string,
  region: string,
  prices: PriceReader,
): Promise<number | null> {
  const spec = APP_GATEWAY_PRODUCT[tier.toLowerCase()];
  if (!spec || !region) return null;
  const items = await prices(
    `productName eq '${spec.product}' and armRegionName eq '${region.replace(/'/g, "")}'`,
  );
  const rate = hourly(items, (i) => i.meterName === spec.meter);
  return rate === null ? null : rate * HOURS_PER_MONTH;
}

export function retailPriceReader(http: HttpHostServices | undefined): PriceReader {
  return async (filter) => (await fetchRetailPrices(filter, http, 2)).items;
}

/* --------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------ */

export interface AzureIdleDeps {
  subscriptionId: string;
  read: MetricReader;
  prices: PriceReader;
}

const JUDGES: Record<string, { ruleId: string; judge: Judge }> = {
  "azure-load-balancer": { ruleId: "load-balancer", judge: judgeLoadBalancer },
  "azure-nat-gateway": { ruleId: "nat-gateway", judge: judgeNatGateway },
  "azure-app-gateway": { ruleId: "app-gateway", judge: judgeAppGateway },
};

async function estimateFor(
  ruleId: string,
  resource: IdleScanResource,
  prices: PriceReader,
): Promise<IdleFindingRecord["estimate"]> {
  const f = resource.fields;
  let amount: number | null = null;
  let note: string;
  if (ruleId === "load-balancer") {
    amount = await loadBalancerMonthly(Number(f["ruleCount"] ?? 0), prices);
    note = "Rule hours; data processed is near zero when idle.";
  } else if (ruleId === "nat-gateway") {
    amount = await natGatewayMonthly(String(f["sku"] ?? "Standard"), prices);
    note = "Gateway hours; its public IP addresses bill separately until they are deleted.";
  } else {
    amount = await appGatewayMonthly(String(f["tier"] ?? ""), String(f["location"] ?? ""), prices);
    note = "The fixed hourly cost; reserved capacity units bill on top.";
  }
  if (amount === null) return null;
  return {
    monthlyAmount: Math.round(amount * 100) / 100,
    currency: "USD",
    basis: "list-price",
    note,
  };
}

export async function fetchAzureIdleFindings(
  request: IdleScanRequest,
  deps: AzureIdleDeps,
): Promise<IdleFindingRecord[]> {
  const end = new Date(request.windowEnd);
  end.setUTCHours(0, 0, 0, 0);
  const window = { start: new Date(end.getTime() - request.lookbackDays * DAY_MS), end };
  const findings: IdleFindingRecord[] = [];
  for (const resource of request.resources) {
    const entry = JUDGES[resource.resourceTypeId];
    const rule = entry ? request.rules[entry.ruleId] : undefined;
    if (!entry || !rule) continue;
    const verdict = await entry.judge(
      resource,
      rule.thresholds,
      request.lookbackDays,
      window,
      deps.read,
      deps.subscriptionId,
    );
    if (!verdict) continue;
    findings.push({
      ruleId: entry.ruleId,
      subjectKey: resource.externalId ?? resource.id,
      resourceId: resource.id,
      resourceTypeId: resource.resourceTypeId,
      displayName: resource.displayName,
      reason: verdict.reason,
      evidence: verdict.evidence,
      estimate: await estimateFor(entry.ruleId, resource, deps.prices).catch(() => null),
    });
  }
  return findings;
}
