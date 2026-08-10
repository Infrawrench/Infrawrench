/**
 * Commitment inventory: EC2 Reserved Instances, RDS Reserved Instances, and
 * Savings Plans.
 *
 * Three provider APIs, three different shapes:
 *
 * - **EC2 RIs** — `DescribeReservedInstances` (EC2 Query API,
 *   `Version=2016-11-15`), regional and unpaginated. The response carries no
 *   ARN, so the bare reservation id is the record id — which is fine,
 *   because it is also what the billing data joins on. `fixedPrice` and
 *   `usagePrice` are **per instance**; every money figure here is multiplied
 *   by `instanceCount` before it is reported, because a record describes the
 *   whole holding.
 * - **RDS RIs** — `DescribeReservedDBInstances` (`Version=2014-10-31`),
 *   regional, `Marker`-paginated. Has an ARN (which matches the CUR's
 *   `reservation/ReservationARN`, so the ARN is the id) but **no end time**
 *   — the end is derived as start + provider-reported duration, which is
 *   exact arithmetic, not a guess.
 * - **Savings Plans** — `POST /DescribeSavingsPlans` on the **global**
 *   `savingsplans.amazonaws.com` endpoint, signed for us-east-1,
 *   `nextToken`-paginated. Fetched once, not per region. The request omits
 *   `states` deliberately so retired and queued plans come back — the host
 *   needs expired records to close out utilization history. A Compute plan
 *   gets **no region**: it applies across regions, and stamping one on it
 *   would wrongly narrow it. `recurringPaymentAmount` is deliberately not
 *   mapped: no AWS document states its period, and guessing between hourly
 *   and monthly is a 730× error.
 *
 * Failures propagate. The host replaces its stored inventory with what this
 * returns, so a partial list (one region down, the rest fine) must throw
 * rather than quietly read as commitments having ended.
 */

import type {
  CommitmentPaymentOption,
  CommitmentRecord,
  CommitmentState,
} from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { ec2Call, ec2QueryCall } from "./client-transport.js";
import { ensureArray } from "./xml.js";
import { fetchSigned } from "./signed-request.js";

/** Global Savings Plans endpoint — one service, one host, signed for us-east-1. */
const SAVINGS_PLANS_URL = "https://savingsplans.amazonaws.com/DescribeSavingsPlans";

/**
 * Same bound as the client's resource-listing fan-out: AWS accounts share one
 * API rate limit, so regions are described in batches of 8, and any region's
 * failure fails the whole fetch (see the module header).
 */
const REGION_FANOUT_CONCURRENCY = 8;

/**
 * Normalize an AWS commitment state string. The mapping errs toward
 * understatement: payment-failed / queued-deleted / retired / returned all
 * mean the discount is not being applied; pending-return means it still is;
 * anything unrecognised is treated as not-applying rather than inflating the
 * org's apparent holdings.
 */
export function normalizeAwsCommitmentState(raw: string): CommitmentState {
  switch (raw) {
    case "active":
    case "pending-return":
      return "active";
    case "payment-pending":
    case "queued":
      return "queued";
    default:
      // payment-failed, retired, queued-deleted, returned, and any state AWS
      // invents later.
      return "expired";
  }
}

/** "All Upfront" → all_upfront; legacy utilization offering types → undefined. */
function paymentOption(raw: string | undefined): CommitmentPaymentOption | undefined {
  switch (raw) {
    case "All Upfront":
      return "all_upfront";
    case "Partial Upfront":
      return "partial_upfront";
    case "No Upfront":
      return "no_upfront";
    default:
      return undefined;
  }
}

function num(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Seconds → whole days. AWS terms are exact multiples of a day. */
function secondsToDays(raw: unknown): number | undefined {
  const seconds = num(raw);
  return seconds === undefined ? undefined : Math.round(seconds / 86_400);
}

// ─── EC2 Reserved Instances ─────────────────────────────────────────────────

interface Ec2RecurringCharge {
  frequency?: string;
  amount?: string;
}

interface Ec2ReservedInstance {
  reservedInstancesId?: string;
  instanceType?: string;
  availabilityZone?: string;
  start?: string;
  end?: string;
  duration?: string;
  fixedPrice?: string;
  usagePrice?: string;
  instanceCount?: string;
  productDescription?: string;
  state?: string;
  currencyCode?: string;
  offeringType?: string;
  scope?: string;
  recurringCharges?: { item?: Ec2RecurringCharge[] };
}

interface DescribeReservedInstancesResponse {
  reservedInstancesSet?: { item?: Ec2ReservedInstance[] };
}

/**
 * Hourly recurring charge per instance: modern RIs report it under
 * `recurringCharges`, pre-2016 offering types under `usagePrice`, never both
 * — so summing the two reads whichever one is populated.
 */
function hourlyPerInstance(
  usagePrice: string | undefined,
  charges: Ec2RecurringCharge[] | undefined,
): number {
  let total = num(usagePrice) ?? 0;
  for (const charge of charges ?? []) {
    if (charge.frequency === "Hourly") total += num(charge.amount) ?? 0;
  }
  return total;
}

export function mapEc2ReservedInstance(
  ri: Ec2ReservedInstance,
  region: string,
): CommitmentRecord | null {
  const id = ri.reservedInstancesId ?? "";
  if (!id) return null;
  const count = num(ri.instanceCount) ?? 1;
  const fixedPerInstance = num(ri.fixedPrice);
  const hourly = hourlyPerInstance(ri.usagePrice, ensureArray(ri.recurringCharges?.item));
  const option = paymentOption(ri.offeringType);
  const termDays = secondsToDays(ri.duration);
  const description = [
    `${count}×`,
    ri.instanceType ?? "EC2 instance",
    ri.productDescription ? `(${ri.productDescription})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id,
    kind: "reservation",
    description: `EC2 Reserved Instance — ${description}`,
    ...(ri.availabilityZone ? { scope: ri.availabilityZone } : {}),
    region,
    startDate: ri.start ?? "",
    ...(ri.end ? { endDate: ri.end } : {}),
    ...(termDays !== undefined ? { termDays } : {}),
    ...(option ? { paymentOption: option } : {}),
    currency: ri.currencyCode ?? "USD",
    // Per-instance prices scaled to the whole holding.
    ...(fixedPerInstance !== undefined ? { upfrontAmount: fixedPerInstance * count } : {}),
    recurringAmount: hourly * count,
    recurringPeriod: "hour",
    state: normalizeAwsCommitmentState(ri.state ?? ""),
  };
}

async function fetchEc2ReservedInstances(
  creds: AwsCredentials,
  region: string,
): Promise<CommitmentRecord[]> {
  const data = await ec2Call<DescribeReservedInstancesResponse>(
    { ...creds, region },
    "DescribeReservedInstances",
  );
  return ensureArray(data.reservedInstancesSet?.item)
    .map((ri) => mapEc2ReservedInstance(ri, region))
    .filter((r): r is CommitmentRecord => r !== null);
}

// ─── RDS Reserved DB Instances ──────────────────────────────────────────────

interface RdsRecurringCharge {
  RecurringChargeAmount?: string;
  RecurringChargeFrequency?: string;
}

interface RdsReservedDbInstance {
  ReservedDBInstanceId?: string;
  ReservedDBInstanceArn?: string;
  DBInstanceClass?: string;
  StartTime?: string;
  Duration?: string;
  FixedPrice?: string;
  UsagePrice?: string;
  CurrencyCode?: string;
  DBInstanceCount?: string;
  ProductDescription?: string;
  OfferingType?: string;
  MultiAZ?: string;
  State?: string;
  RecurringCharges?: { RecurringCharge?: RdsRecurringCharge | RdsRecurringCharge[] };
}

interface DescribeReservedDbInstancesResponse {
  DescribeReservedDBInstancesResult?: {
    ReservedDBInstances?: { ReservedDBInstance?: RdsReservedDbInstance | RdsReservedDbInstance[] };
    Marker?: string;
  };
}

export function mapRdsReservedInstance(
  ri: RdsReservedDbInstance,
  region: string,
): CommitmentRecord | null {
  // The ARN is what the CUR's reservation/ReservationARN carries, so it is
  // the id billing rows join on; the bare id is only a fallback.
  const id = ri.ReservedDBInstanceArn ?? ri.ReservedDBInstanceId ?? "";
  if (!id) return null;
  const count = num(ri.DBInstanceCount) ?? 1;
  const fixedPerInstance = num(ri.FixedPrice);
  let hourly = num(ri.UsagePrice) ?? 0;
  for (const charge of ensureArray(ri.RecurringCharges?.RecurringCharge)) {
    if (charge.RecurringChargeFrequency === "Hourly") {
      hourly += num(charge.RecurringChargeAmount) ?? 0;
    }
  }
  const option = paymentOption(ri.OfferingType);
  const termDays = secondsToDays(ri.Duration);
  const start = ri.StartTime ?? "";
  const durationSeconds = num(ri.Duration);
  // RDS reports no end time; start + duration is the exact end.
  const endDate =
    start && durationSeconds !== undefined
      ? new Date(new Date(start).valueOf() + durationSeconds * 1000).toISOString()
      : undefined;
  const description = [
    `${count}×`,
    ri.DBInstanceClass ?? "DB instance",
    ri.ProductDescription
      ? `(${ri.ProductDescription}${ri.MultiAZ === "true" ? ", Multi-AZ" : ""})`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id,
    kind: "reservation",
    description: `RDS Reserved Instance — ${description}`,
    region,
    startDate: start,
    ...(endDate ? { endDate } : {}),
    ...(termDays !== undefined ? { termDays } : {}),
    ...(option ? { paymentOption: option } : {}),
    currency: ri.CurrencyCode ?? "USD",
    ...(fixedPerInstance !== undefined ? { upfrontAmount: fixedPerInstance * count } : {}),
    recurringAmount: hourly * count,
    recurringPeriod: "hour",
    state: normalizeAwsCommitmentState(ri.State ?? ""),
  };
}

async function fetchRdsReservedInstances(
  creds: AwsCredentials,
  region: string,
): Promise<CommitmentRecord[]> {
  const records: CommitmentRecord[] = [];
  let marker: string | undefined;
  do {
    const data = await ec2QueryCall<DescribeReservedDbInstancesResponse>(
      { ...creds, region },
      "rds",
      "DescribeReservedDBInstances",
      "2014-10-31",
      marker ? { Marker: marker } : {},
    );
    const result = data.DescribeReservedDBInstancesResult;
    for (const ri of ensureArray(result?.ReservedDBInstances?.ReservedDBInstance)) {
      const record = mapRdsReservedInstance(ri, region);
      if (record) records.push(record);
    }
    marker = result?.Marker;
  } while (marker);
  return records;
}

// ─── Savings Plans ──────────────────────────────────────────────────────────

interface SavingsPlan {
  savingsPlanId?: string;
  savingsPlanArn?: string;
  savingsPlanType?: string;
  description?: string;
  ec2InstanceFamily?: string;
  region?: string;
  start?: string;
  end?: string;
  termDurationInSeconds?: number;
  paymentOption?: string;
  currency?: string;
  commitment?: string;
  upfrontPaymentAmount?: string;
  state?: string;
}

interface DescribeSavingsPlansResponse {
  savingsPlans?: SavingsPlan[];
  nextToken?: string;
}

export function mapSavingsPlan(plan: SavingsPlan): CommitmentRecord | null {
  const id = plan.savingsPlanArn ?? plan.savingsPlanId ?? "";
  if (!id) return null;
  const option = paymentOption(plan.paymentOption);
  const termDays = secondsToDays(plan.termDurationInSeconds);
  const commitment = num(plan.commitment);
  const upfront = num(plan.upfrontPaymentAmount);
  const type = plan.savingsPlanType ?? "";
  // A Compute plan applies across regions — absent region is that state, not
  // missing data. Only instance-scoped plan types keep the region AWS stamps.
  const region = type !== "Compute" && plan.region ? plan.region : undefined;
  const label =
    type === "Compute"
      ? "Compute Savings Plan"
      : type === "EC2Instance"
        ? "EC2 Instance Savings Plan"
        : type === "SageMaker"
          ? "SageMaker Savings Plan"
          : type
            ? `${type} Savings Plan`
            : "Savings Plan";
  return {
    id,
    kind: "savings_plan",
    description: plan.description ? `${label} — ${plan.description}` : label,
    ...(plan.ec2InstanceFamily ? { scope: plan.ec2InstanceFamily } : {}),
    ...(region ? { region } : {}),
    startDate: plan.start ?? "",
    ...(plan.end ? { endDate: plan.end } : {}),
    ...(termDays !== undefined ? { termDays } : {}),
    ...(option ? { paymentOption: option } : {}),
    ...(plan.currency ? { currency: plan.currency } : {}),
    ...(upfront !== undefined ? { upfrontAmount: upfront } : {}),
    // recurringPaymentAmount is deliberately unmapped: its period is
    // documented nowhere, and hourly-vs-monthly is a 730× error.
    ...(commitment !== undefined ? { hourlyCommitmentAmount: commitment } : {}),
    state: normalizeAwsCommitmentState(plan.state ?? ""),
  };
}

async function fetchSavingsPlans(creds: AwsCredentials): Promise<CommitmentRecord[]> {
  const records: CommitmentRecord[] = [];
  let nextToken: string | undefined;
  do {
    // No `states` filter — retired and queued plans must come back too.
    const body = JSON.stringify({ maxResults: 100, ...(nextToken ? { nextToken } : {}) });
    const res = await fetchSigned({
      method: "POST",
      url: SAVINGS_PLANS_URL,
      headers: { "content-type": "application/json" },
      body,
      service: "savingsplans",
      // Global endpoint, signed for us-east-1 regardless of home region.
      credentials: { ...creds, region: "us-east-1" },
    });
    const data = (await res.json()) as DescribeSavingsPlansResponse;
    for (const plan of data.savingsPlans ?? []) {
      const record = mapSavingsPlan(plan);
      if (record) records.push(record);
    }
    nextToken = data.nextToken;
  } while (nextToken);
  return records;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Every commitment this account holds: EC2 RIs and RDS RIs fanned out across
 * `regions` (bounded concurrency, any failure propagates), Savings Plans
 * fetched once from the global endpoint.
 */
export async function fetchAwsCommitments(
  creds: AwsCredentials,
  regions: string[],
): Promise<CommitmentRecord[]> {
  const records: CommitmentRecord[] = [];

  for (let i = 0; i < regions.length; i += REGION_FANOUT_CONCURRENCY) {
    const batch = regions.slice(i, i + REGION_FANOUT_CONCURRENCY);
    // Promise.all, not allSettled: a region that fails must fail the fetch —
    // the host would otherwise read its reservations as having ended.
    const perRegion = await Promise.all(
      batch.map(async (region) => {
        const [ec2, rds] = await Promise.all([
          fetchEc2ReservedInstances(creds, region),
          fetchRdsReservedInstances(creds, region),
        ]);
        return [...ec2, ...rds];
      }),
    );
    for (const list of perRegion) records.push(...list);
  }

  records.push(...(await fetchSavingsPlans(creds)));
  return records;
}
