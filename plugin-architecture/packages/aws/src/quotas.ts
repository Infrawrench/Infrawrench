/**
 * AWS quota readings — Service Quotas for the limit, CloudWatch and the EC2
 * describe calls for the usage.
 *
 * AWS is the awkward one, and the reason is structural: **Service Quotas does
 * not report usage.** `ListServiceQuotas` returns the applied ceiling and, for
 * some quotas, a `UsageMetric` *pointer* into the CloudWatch `AWS/Usage`
 * namespace; the number itself has to be fetched from a different service. For
 * the quotas that carry no pointer at all — Elastic IPs and VPCs per region
 * are both in this group — the only source of truth is counting the resources.
 *
 * So every reading here is assembled from two calls, and both halves come from
 * the provider. Nothing is filled in from documentation: a limit we cannot
 * read is a quota this module does not return, because an account with an
 * approved increase reported at the published default would read as exhausted
 * while it has headroom.
 *
 * **Wire shapes verified against live AWS documentation, August 2026:**
 * - `ListServiceQuotas` / `GetAWSDefaultServiceQuota` —
 *   https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_ListServiceQuotas.html
 *   JSON 1.1 over `POST https://servicequotas.<region>.amazonaws.com/` with
 *   `X-Amz-Target: ServiceQuotasV20190624.<Op>`, SigV4 service `servicequotas`.
 *   Response `Quotas[]` carries PascalCase `QuotaCode`, `QuotaName`, `Value`,
 *   `Unit`, `Adjustable`, `GlobalQuota`, `UsageMetric`.
 * - `AWS/Usage` / `ResourceCount` —
 *   https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/viewing_metrics_with_cloudwatch.html
 *   Dimensions `Service=EC2`, `Type=Resource`, `Resource=vCPU`,
 *   `Class=Standard/OnDemand | G/OnDemand | …`; the documented statistic is
 *   `Maximum`.
 *
 * **The `ListServiceQuotas` caveat that shapes the fallback**: AWS documents
 * that "if the applied quota value is not available for a quota, the quota is
 * not retrieved" — an account that has never had an increase approved for a
 * given code simply gets an empty list back. That is not an error and not an
 * absent quota; it means the *default* is the applied value, which is what
 * `GetAWSDefaultServiceQuota` is for. Treating the empty list as "no such
 * quota" would silently drop the radar for exactly the accounts that have
 * never touched their limits.
 */

import { QuotaAccessError, type QuotaUsage } from "@infrawrench/plugin-base";

/** One quota we ask about, and how to find out how much of it is in use. */
interface QuotaTarget {
  serviceCode: string;
  quotaCode: string;
  /** Fallback label when neither the applied nor the default quota names it. */
  label: string;
  /** The provider's word for what is counted, for the UI. */
  unit: string;
  /**
   * Where the used figure comes from. `cloudwatch` reads the `AWS/Usage`
   * pointer; the `count-*` sources exist because Elastic IPs and VPCs publish
   * no usage metric at all and the only honest number is the resource count.
   */
  usage:
    | { kind: "cloudwatch"; usageClass: string }
    | { kind: "count-addresses" }
    | { kind: "count-vpcs" };
  docsUrl: string;
}

/**
 * The quotas this plugin reports, and only these.
 *
 * AWS publishes thousands of quotas across hundreds of services. Walking them
 * would be both unaffordable (a `ListServiceQuotas` page per service per
 * region) and useless — most are ceilings nobody is within an order of
 * magnitude of. This is the set that actually stops deploys, which is why the
 * manifest declares `partial: true`: the surface must not imply "you are
 * within all your limits" when what it knows is "you are within these five".
 *
 * `L-1216C47A` and `L-34B43A08` are the two vCPU families worth watching — the
 * standard on-demand pool that every workload draws from, and the GPU pool
 * that is small, contended, and the one people are most often refused on.
 * Both are measured in **vCPUs, not instances**, which is the single most
 * common misreading of the EC2 quota: a quota of 32 is eight `m5.xlarge`s, not
 * thirty-two of them.
 */
const QUOTA_TARGETS: QuotaTarget[] = [
  {
    serviceCode: "ec2",
    quotaCode: "L-1216C47A",
    label: "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances",
    unit: "vCPUs",
    usage: { kind: "cloudwatch", usageClass: "Standard/OnDemand" },
    docsUrl: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-resource-limits.html",
  },
  {
    serviceCode: "ec2",
    quotaCode: "L-34B43A08",
    label: "Running On-Demand G and VT instances",
    unit: "vCPUs",
    usage: { kind: "cloudwatch", usageClass: "G/OnDemand" },
    docsUrl: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-resource-limits.html",
  },
  {
    // Lives under `ec2`, not `vpc`, despite the name. Getting the service code
    // wrong returns an empty list rather than an error, which reads as "you
    // have no Elastic IP quota" — so this is pinned by test.
    serviceCode: "ec2",
    quotaCode: "L-0263D0A3",
    label: "EC2-VPC Elastic IPs",
    unit: "addresses",
    usage: { kind: "count-addresses" },
    docsUrl:
      "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html#using-instance-addressing-limit",
  },
  {
    serviceCode: "vpc",
    quotaCode: "L-F678F1CE",
    label: "VPCs per Region",
    unit: "VPCs",
    usage: { kind: "count-vpcs" },
    docsUrl: "https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html",
  },
];

/** The subset of the `ServiceQuota` object this module decodes. */
export interface AwsServiceQuota {
  QuotaCode?: string;
  QuotaName?: string;
  ServiceCode?: string;
  ServiceName?: string;
  Value?: number;
  Unit?: string;
  Adjustable?: boolean;
  GlobalQuota?: boolean;
}

export interface AwsListServiceQuotasResponse {
  Quotas?: AwsServiceQuota[];
  NextToken?: string;
}

export interface AwsGetDefaultServiceQuotaResponse {
  Quota?: AwsServiceQuota;
}

/**
 * Everything this module needs from the network, injected so the assembly is
 * testable against recorded fixtures without a signing stack. Same shape as
 * `DoCostFetchContext`.
 */
export interface AwsQuotaContext {
  /** Regions to read. The caller resolves these from `DescribeRegions`. */
  regions: string[];
  /** `ListServiceQuotas`, already filtered to one `QuotaCode`. */
  listServiceQuotas(
    region: string,
    serviceCode: string,
    quotaCode: string,
  ): Promise<AwsListServiceQuotasResponse>;
  /** `GetAWSDefaultServiceQuota`, called only when the applied list is empty. */
  getDefaultServiceQuota(
    region: string,
    serviceCode: string,
    quotaCode: string,
  ): Promise<AwsGetDefaultServiceQuotaResponse>;
  /** Max of `AWS/Usage`/`ResourceCount` for one vCPU class, or null. */
  usageMetric(region: string, usageClass: string): Promise<number | null>;
  /** `DescribeAddresses` count for the region. */
  countAddresses(region: string): Promise<number>;
  /** `DescribeVpcs` count for the region. */
  countVpcs(region: string): Promise<number>;
}

/** Regions read in parallel — the fan-out bound the resource listers use. */
const REGION_CONCURRENCY = 8;

/**
 * Resolve one quota's applied limit.
 *
 * `ListServiceQuotas` first, `GetAWSDefaultServiceQuota` second, and the order
 * matters: the applied value is the one AWS enforces, and it differs from the
 * default precisely for the accounts that have already asked for more. Falling
 * back to the default when the applied value *is* available would report a
 * 1,920-vCPU account as having 32.
 *
 * Returns null when neither call names a usable ceiling. Null is dropped, not
 * defaulted — see the module header.
 */
export async function resolveQuotaLimit(
  ctx: AwsQuotaContext,
  region: string,
  target: QuotaTarget,
): Promise<AwsServiceQuota | null> {
  const applied = await ctx.listServiceQuotas(region, target.serviceCode, target.quotaCode);
  const match = (applied.Quotas ?? []).find((q) => q.QuotaCode === target.quotaCode);
  if (match && typeof match.Value === "number") return match;

  const fallback = await ctx.getDefaultServiceQuota(region, target.serviceCode, target.quotaCode);
  const quota = fallback.Quota;
  if (quota && typeof quota.Value === "number") return quota;
  return null;
}

/**
 * `Unit: "None"` is AWS's way of saying "a bare count", and it appears on
 * essentially every quota including the ones measured in vCPUs. Printing it
 * verbatim would put "1,920 None" on the screen, so the target's own word wins
 * over an uninformative provider unit — but a provider unit that says
 * something real (`Bytes`, `Requests per second`) is kept.
 */
export function pickQuotaUnit(providerUnit: string | undefined, fallback: string): string {
  if (!providerUnit || providerUnit === "None") return fallback;
  return providerUnit;
}

/**
 * Read every target in one region.
 *
 * Usage is fetched before the limit and a target whose usage is zero is
 * skipped entirely. That is a bounding rule with a justification, not a
 * shortcut: an account with 30 enabled regions genuinely uses two or three,
 * and a radar listing 120 quotas at 0% would bury the four that matter. A
 * quota at zero usage is also the one case where the ceiling cannot be a
 * problem, so nothing actionable is lost.
 *
 * A usage read that *fails* is not a usage of zero — it throws, and the whole
 * fetch fails with it, per the contract's "throw rather than return a short
 * list" rule.
 */
async function readRegion(ctx: AwsQuotaContext, region: string): Promise<QuotaUsage[]> {
  const out: QuotaUsage[] = [];
  for (const target of QUOTA_TARGETS) {
    let used: number | null;
    switch (target.usage.kind) {
      case "cloudwatch":
        used = await ctx.usageMetric(region, target.usage.usageClass);
        break;
      case "count-addresses":
        used = await ctx.countAddresses(region);
        break;
      case "count-vpcs":
        used = await ctx.countVpcs(region);
        break;
    }
    // Null means CloudWatch published no datapoint for that class — the
    // account has never run one. Distinct from zero only in that we did not
    // measure it; either way there is nothing to warn about.
    if (used === null || used <= 0) continue;

    const quota = await resolveQuotaLimit(ctx, region, target);
    if (!quota || typeof quota.Value !== "number") continue;

    out.push({
      // Region in the id, because the same quota code is a different ceiling
      // in every region and one series per code would average four regions
      // into a number describing none of them.
      id: `${target.serviceCode}/${target.quotaCode}/${region}`,
      service: quota.ServiceCode ?? target.serviceCode,
      name: quota.QuotaName ?? target.label,
      region,
      limit: quota.Value,
      used,
      unit: pickQuotaUnit(quota.Unit, target.unit),
      ...(quota.Adjustable === undefined ? {} : { adjustable: quota.Adjustable }),
      docsUrl: target.docsUrl,
    });
  }
  return out;
}

/**
 * Read the account's quotas across every enabled region.
 *
 * Any region's failure fails the whole fetch — the host replaces its stored
 * readings with what this returns, so a partial list would read as quotas
 * having disappeared, and a disappeared quota is one nobody is watching any
 * more. That is the same rule `fetchAwsCommitments` follows next door.
 */
export async function fetchAwsQuotas(ctx: AwsQuotaContext): Promise<QuotaUsage[]> {
  if (ctx.regions.length === 0) {
    throw new QuotaAccessError(
      "No AWS regions could be resolved for this account, so quotas cannot be read. This " +
        "usually means the credential is missing `ec2:DescribeRegions`.",
      {
        label: "AWS quota permissions",
        url: "https://docs.aws.amazon.com/servicequotas/latest/userguide/identity-access-management.html",
      },
    );
  }

  const readings: QuotaUsage[] = [];
  for (let i = 0; i < ctx.regions.length; i += REGION_CONCURRENCY) {
    const batch = ctx.regions.slice(i, i + REGION_CONCURRENCY);
    const results = await Promise.all(batch.map((region) => readRegion(ctx, region)));
    for (const result of results) readings.push(...result);
  }
  return readings;
}

/** Exported for the test that pins the quota codes and their service codes. */
export const AWS_QUOTA_TARGETS: readonly QuotaTarget[] = QUOTA_TARGETS;
