/**
 * Vulnerability findings from Amazon Inspector (v2).
 *
 * Inspector is regional: it is enabled per region and keeps each region's
 * findings in that region, so the read fans out across the account's enabled
 * regions exactly as quotas and commitments do.
 *
 * **Wire shapes verified against the live API reference, October 2026:**
 * - `ListFindings`:
 *   https://docs.aws.amazon.com/inspector/v2/APIReference/API_ListFindings.html
 *   REST-JSON, `POST /findings/list` on `inspector2.<region>.amazonaws.com`,
 *   SigV4 service `inspector2`. Body `filterCriteria` (StringFilter
 *   `{comparison: EQUALS|PREFIX|NOT_EQUALS, value}`), `maxResults` 1-100,
 *   `nextToken`, `sortCriteria {field, sortOrder}`. Response `findings[]`,
 *   `nextToken`. Timestamps are epoch seconds (REST-JSON).
 * - `Finding`: https://docs.aws.amazon.com/inspector/v2/APIReference/API_Finding.html
 *   `fixAvailable` YES|NO|PARTIAL, `exploitAvailable` YES|NO, `severity`
 *   INFORMATIONAL|LOW|MEDIUM|HIGH|CRITICAL|UNTRIAGED, `type`
 *   NETWORK_REACHABILITY|PACKAGE_VULNERABILITY|CODE_VULNERABILITY.
 * - `Resource`: https://docs.aws.amazon.com/inspector/v2/APIReference/API_Resource.html
 * - `VulnerablePackage`:
 *   https://docs.aws.amazon.com/inspector/v2/APIReference/API_VulnerablePackage.html
 *
 * Only `PACKAGE_VULNERABILITY` findings are read. `NETWORK_REACHABILITY` is an
 * open-port finding, not an advisory; `CODE_VULNERABILITY` (Lambda code
 * scanning) is a CWE-class static-analysis result with no package, no
 * installed version and no advisory id, so it has nothing to put in the
 * contract's advisory/package slots without inventing one.
 */

import {
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
  VulnerabilityAccessError,
  type VulnerabilityArtifact,
  type VulnerabilityFinding,
} from "@infrawrench/plugin-base";

export const INSPECTOR_CONSOLE_URL = "https://console.aws.amazon.com/inspector/v2/home";

const INSPECTOR_HELP = {
  label: "Amazon Inspector permissions",
  url: "https://docs.aws.amazon.com/inspector/latest/user/security-iam.html",
};

const INSPECTOR_ENABLE_HELP = {
  label: "Getting started with Amazon Inspector",
  url: "https://docs.aws.amazon.com/inspector/latest/user/getting_started_tutorial.html",
};

/**
 * Pages read per region before stopping. With `maxResults: 100` this is
 * thousands of findings per region; the walk is sorted by severity so a bound
 * that bites drops the least severe first. It can bite, which is why the
 * manifest declares `partial: true`.
 */
export const MAX_PAGES_PER_REGION = 200;

/** Regions read in parallel: the same bound quotas.ts uses. */
const REGION_CONCURRENCY = 8;

interface InspectorCvss {
  baseScore?: number;
  scoringVector?: string;
  source?: string;
  version?: string;
}

interface InspectorVulnerablePackage {
  name?: string;
  version?: string;
  epoch?: number;
  release?: string;
  arch?: string;
  fixedInVersion?: string;
  packageManager?: string;
  filePath?: string;
}

interface InspectorResource {
  id?: string;
  type?: string;
  region?: string;
  partition?: string;
  details?: {
    awsEcrContainerImage?: {
      registry?: string;
      repositoryName?: string;
      imageHash?: string;
      imageTags?: string[];
    };
    awsLambdaFunction?: { functionName?: string };
    awsEc2Instance?: Record<string, unknown>;
  };
}

/** The subset of the `Finding` object this module decodes. */
export interface InspectorFinding {
  findingArn?: string;
  awsAccountId?: string;
  type?: string;
  status?: string;
  severity?: string;
  title?: string;
  description?: string;
  fixAvailable?: string;
  exploitAvailable?: string;
  inspectorScore?: number;
  inspectorScoreDetails?: {
    adjustedCvss?: { score?: number; scoringVector?: string };
  };
  firstObservedAt?: number | string;
  lastObservedAt?: number | string;
  packageVulnerabilityDetails?: {
    vulnerabilityId?: string;
    relatedVulnerabilities?: string[];
    cvss?: InspectorCvss[];
    sourceUrl?: string;
    referenceUrls?: string[];
    vulnerablePackages?: InspectorVulnerablePackage[];
  };
  resources?: InspectorResource[];
}

export interface InspectorListFindingsResponse {
  findings?: InspectorFinding[];
  nextToken?: string | null;
}

export interface AwsVulnerabilityContext {
  /** Regions to read. The caller resolves these from `DescribeRegions`. */
  regions: string[];
  /** One signed `POST /findings/list` in `region`. */
  listFindings(
    region: string,
    body: Record<string, unknown>,
  ): Promise<InspectorListFindingsResponse>;
}

/** The request body: active package findings, most severe first. */
export function listFindingsBody(nextToken?: string): Record<string, unknown> {
  return {
    filterCriteria: {
      findingStatus: [{ comparison: "EQUALS", value: "ACTIVE" }],
      findingType: [{ comparison: "EQUALS", value: "PACKAGE_VULNERABILITY" }],
    },
    maxResults: 100,
    sortCriteria: { field: "SEVERITY", sortOrder: "DESC" },
    ...(nextToken ? { nextToken } : {}),
  };
}

/** REST-JSON timestamps arrive as epoch seconds; tolerate ISO strings too. */
function toIso(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function yesNo(value: string | undefined): boolean | undefined {
  const v = (value ?? "").toUpperCase();
  if (v === "YES") return true;
  if (v === "NO") return false;
  return undefined;
}

/**
 * Inspector writes a placeholder rather than omitting the field when no fixed
 * version is known (seen in the wild as `NotAvailable`). That is the absence
 * of a version, not a version.
 */
function realFixedVersion(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || /^not\s*available$/i.test(v)) return undefined;
  return v;
}

function ecrHost(registry: string, region: string, partition: string | undefined): string {
  const suffix =
    partition === "aws-cn" || region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `${registry}.dkr.ecr.${region}.${suffix}`;
}

/** Lambda function name from a (possibly version-qualified) function ARN. */
function functionNameFromArn(arn: string): string | undefined {
  const m = /:function:([^:]+)/.exec(arn);
  return m?.[1];
}

/**
 * What the finding is about, keyed the way the AWS listers key their rows:
 * EC2 instances by instance id, Lambda functions by function name (both are
 * the listers' `externalId`), ECR images by pull reference + digest.
 * Returns null for resource types with nothing to join (an ECR repository
 * finding, a code repository, an Azure resource).
 */
export function artifactFor(
  resource: InspectorResource | undefined,
  fallbackRegion: string,
): VulnerabilityArtifact | null {
  if (!resource) return null;
  const region = resource.region || fallbackRegion;
  switch (resource.type) {
    case "AWS_ECR_CONTAINER_IMAGE": {
      const img = resource.details?.awsEcrContainerImage;
      const registry = img?.registry;
      const repo = img?.repositoryName;
      if (!registry || !repo) return null;
      const name = `${ecrHost(registry, region, resource.partition)}/${repo}`;
      const tags = (img?.imageTags ?? []).filter(Boolean);
      return {
        kind: "image",
        name,
        ...(img?.imageHash ? { digest: img.imageHash } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        url: `https://${region}.console.aws.amazon.com/ecr/repositories/private/${registry}/${repo}?region=${region}`,
      };
    }
    case "AWS_LAMBDA_FUNCTION": {
      const name =
        resource.details?.awsLambdaFunction?.functionName ||
        (resource.id ? functionNameFromArn(resource.id) : undefined);
      if (!name) return null;
      return {
        kind: "function",
        name,
        resourceExternalId: name,
        url: `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${encodeURIComponent(name)}`,
      };
    }
    case "AWS_EC2_INSTANCE": {
      const id = resource.id;
      if (!id) return null;
      return {
        kind: "host",
        name: id,
        resourceExternalId: id,
        url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${id}`,
      };
    }
    default:
      return null;
  }
}

/** Map one Inspector finding to contract findings, one per vulnerable package. */
export function mapInspectorFinding(f: InspectorFinding, region: string): VulnerabilityFinding[] {
  if (f.type && f.type !== "PACKAGE_VULNERABILITY") return [];
  if (f.status && f.status !== "ACTIVE") return [];
  const details = f.packageVulnerabilityDetails;
  const advisoryId = details?.vulnerabilityId;
  if (!f.findingArn || !advisoryId) return [];
  const artifact = artifactFor(f.resources?.[0], region);
  if (!artifact) return [];

  const adjusted = f.inspectorScoreDetails?.adjustedCvss;
  const cvssScore =
    typeof adjusted?.score === "number"
      ? adjusted.score
      : typeof f.inspectorScore === "number"
        ? f.inspectorScore
        : details?.cvss?.find((c) => typeof c.baseScore === "number")?.baseScore;
  const cvssVector =
    adjusted?.scoringVector ?? details?.cvss?.find((c) => c.scoringVector)?.scoringVector;
  const findingFix = (f.fixAvailable ?? "").toUpperCase();
  const exploitAvailable = yesNo(f.exploitAvailable);
  const aliases = (details?.relatedVulnerabilities ?? []).filter(Boolean);
  const url = details?.sourceUrl ?? details?.referenceUrls?.[0];
  const firstSeenAt = toIso(f.firstObservedAt);
  const lastSeenAt = toIso(f.lastObservedAt);

  const base: Omit<VulnerabilityFinding, "id"> = {
    advisoryId,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(f.title ? { title: f.title } : {}),
    severity: normalizeVulnerabilitySeverity(f.severity, cvssScore),
    ...(typeof cvssScore === "number" ? { cvssScore } : {}),
    ...(cvssVector ? { cvssVector } : {}),
    ...(exploitAvailable === undefined ? {} : { exploitAvailable }),
    artifact,
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(url ? { url } : {}),
  };

  const packages = (details?.vulnerablePackages ?? []).filter((p) => p.name);
  if (packages.length === 0) {
    const fixAvailable = findingFix === "YES" ? true : findingFix === "NO" ? false : undefined;
    return [{ id: f.findingArn, ...base, ...(fixAvailable === undefined ? {} : { fixAvailable }) }];
  }

  return packages.map((pkg) => {
    const fixedVersion = realFixedVersion(pkg.fixedInVersion);
    // YES/NO apply to every package in the finding. PARTIAL means "some of
    // them"; the package's own fixed version is then the only per-package
    // fact, and its absence stays unknown rather than becoming "no".
    const fixAvailable =
      findingFix === "YES" ? true : findingFix === "NO" ? false : fixedVersion ? true : undefined;
    const installedVersion = [pkg.version, pkg.release].filter(Boolean).join("-") || undefined;
    return {
      // The finding ARN is Inspector's own stable id. A finding naming several
      // packages becomes one row per package, keyed by package identity.
      id:
        packages.length === 1
          ? f.findingArn!
          : `${f.findingArn}#${pkg.name}@${pkg.version ?? ""}${pkg.filePath ? `:${pkg.filePath}` : ""}`,
      ...base,
      packageName: pkg.name!,
      ...(pkg.packageManager ? { packageEcosystem: pkg.packageManager.toLowerCase() } : {}),
      ...(installedVersion ? { installedVersion } : {}),
      ...(fixedVersion ? { fixedVersion } : {}),
      ...(fixAvailable === undefined ? {} : { fixAvailable }),
    };
  });
}

type RegionOutcome =
  { kind: "ok"; findings: VulnerabilityFinding[] } | { kind: "skipped"; reason: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** An IAM identity policy that does not grant `inspector2:ListFindings`. */
function isIdentityDenied(message: string): boolean {
  return (
    /not authorized to perform/i.test(message) &&
    !/explicit deny in a service control policy/i.test(message)
  );
}

/**
 * A region this account cannot use Inspector in: an SCP that denies the
 * region, a region not opted in, Inspector not activated there, or an
 * endpoint that does not exist in that region. None of these is a transient
 * failure; the region has no findings we are allowed to see.
 */
function isRegionUnavailable(message: string): boolean {
  // A bad or expired credential is also a 403, and it is not about the region.
  if (/ExpiredToken|UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch/i.test(message)) {
    return false;
  }
  return (
    /\b403\b|AccessDenied|OptInRequired/i.test(message) ||
    /ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(message)
  );
}

async function readRegion(ctx: AwsVulnerabilityContext, region: string): Promise<RegionOutcome> {
  const out: VulnerabilityFinding[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_REGION; page++) {
    let res: InspectorListFindingsResponse;
    try {
      res = await ctx.listFindings(region, listFindingsBody(nextToken));
    } catch (e) {
      const message = errorText(e);
      if (isIdentityDenied(message)) {
        throw new VulnerabilityAccessError(
          "This AWS credential is not allowed to read Amazon Inspector findings. Add " +
            "`inspector2:ListFindings` to its IAM policy.",
          INSPECTOR_HELP,
        );
      }
      // Only the first page decides that a region is unavailable. A failure
      // after findings started arriving is a partial read, which must throw.
      if (page === 0 && isRegionUnavailable(message)) {
        return { kind: "skipped", reason: message };
      }
      throw e;
    }
    for (const f of res.findings ?? []) out.push(...mapInspectorFinding(f, region));
    nextToken = res.nextToken ?? undefined;
    if (!nextToken) break;
  }
  return { kind: "ok", findings: out };
}

/**
 * Read active package findings across every enabled region.
 *
 * A region that answers is authoritative for itself. A region that refuses
 * (an SCP region deny, Inspector never activated there) is skipped, because
 * it can hold no findings this credential may see; but when *every* region
 * refuses, that is "Inspector is off or blocked", and saying so beats an
 * empty list that reads as a clean bill of health. Any other failure fails
 * the whole read, per the contract's "throw rather than return a short list".
 */
export async function fetchAwsVulnerabilityFindings(
  ctx: AwsVulnerabilityContext,
): Promise<VulnerabilityFinding[]> {
  if (ctx.regions.length === 0) {
    throw new VulnerabilityAccessError(
      "No AWS regions could be resolved for this account, so Amazon Inspector findings cannot " +
        "be read. This usually means the credential is missing `ec2:DescribeRegions`.",
      INSPECTOR_HELP,
    );
  }

  const findings: VulnerabilityFinding[] = [];
  let answered = 0;
  for (let i = 0; i < ctx.regions.length; i += REGION_CONCURRENCY) {
    const batch = ctx.regions.slice(i, i + REGION_CONCURRENCY);
    const results = await Promise.all(batch.map((region) => readRegion(ctx, region)));
    for (const result of results) {
      if (result.kind === "ok") {
        answered++;
        findings.push(...result.findings);
      }
    }
  }
  if (answered === 0) {
    throw new VulnerabilityAccessError(
      "Amazon Inspector refused every region for this account. Activate Inspector (with ECR, " +
        "Lambda or EC2 scanning) in the regions you use, and make sure no SCP denies " +
        "`inspector2:ListFindings`.",
      INSPECTOR_ENABLE_HELP,
    );
  }
  return normalizeVulnerabilityFindings(findings);
}
