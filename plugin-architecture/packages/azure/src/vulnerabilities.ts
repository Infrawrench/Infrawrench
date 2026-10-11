/**
 * Container image vulnerability findings from Microsoft Defender for Cloud.
 *
 * **Which data model.** Defender used to publish registry image findings as
 * *sub-assessments* under the grouped recommendation
 * `c0b7cfc6-3172-465a-b378-53c7ff2cc0d5` ("Azure registry container images
 * should have vulnerabilities resolved"). That model was retired on
 * 2026-07-31 and the data is no longer served through the API:
 * https://learn.microsoft.com/en-us/azure/defender-for-cloud/transition-grouped-individual-recommendations
 * Findings now live as *individual recommendations*: one
 * `microsoft.security/assessments` record per (image, vulnerable package),
 * in recommendation category `SoftwareUpdate`, with
 * `resourceDetails.ResourceType == ".containerimage"`. The query below is the
 * one Microsoft publishes for "individual container image vulnerability
 * recommendations in Azure container registries" (release notes, 2026-03-04):
 * https://learn.microsoft.com/en-us/azure/defender-for-cloud/release-notes
 *
 * **Transport.** Azure Resource Graph
 * (`POST /providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01`,
 * `$top` 1000, `$skipToken` paging):
 * https://learn.microsoft.com/en-us/rest/api/azureresourcegraph/resourcegraph/resources/resources
 * It is the only documented read for individual recommendations at scale, and
 * it needs nothing beyond the ARM token the plugin already has. Resource Graph
 * filters rows by RBAC rather than refusing, so a principal without read on
 * `Microsoft.Security/assessments` sees an empty table, not a 403; the plan
 * check below is what turns "nothing configured" into an explanation.
 *
 * **Record shape** (`properties` of each assessment):
 * - `status.code`: `Healthy` / `Unhealthy` / `NotApplicable`; only
 *   `Unhealthy` is an open finding.
 * - `metadata.severity`, `displayName`, `links.azurePortalUri`,
 *   `status.firstEvaluationDate`.
 * - `additionalData.CvesDetails`: the CVEs fixed by this package update, as a
 *   JSON array (Resource Graph serves it as a string; Microsoft's own sample
 *   wraps it in `parse_json(tostring(...))`), each with `CveId` and, where the
 *   scanner inlines them, `Severity`, `Cvss[]`, `FixStatus`, `FixedVersion`,
 *   `ExploitabilityDetails`.
 * - `additionalData.SoftwareName`, `DetectedSoftwareVersions` (may hold several
 *   values), `FixedVersion` (empty when no fix exists).
 * - `resourceAdditionalData` (also JSON-in-a-string): the image, as
 *   `Digest` and `RepositoryDetails.RepositoryName`.
 * - `resourceDetails.Id`: the image's id under its registry
 *   (`.../Microsoft.ContainerRegistry/registries/<name>/...`), which is how the
 *   registry and so its login server are found.
 *
 * Since 2026-08-21 the detailed per-CVE properties (CVSS, exploitability) are
 * served from the tenant-level `microsoft.security/cvedetails` table instead
 * of inline (https://learn.microsoft.com/en-us/azure/defender-for-cloud/remediate-vulnerability-findings-vm),
 * so they are read inline when present and otherwise looked up there, best
 * effort: a principal that cannot see the tenant table still gets every
 * finding, just without a CVSS score.
 *
 * Every field read here is the scanner's. Nothing is inferred: a missing
 * `FixStatus` with no fixed version leaves `fixAvailable` unset.
 */

import {
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
  VulnerabilityAccessError,
  type VulnerabilityFinding,
} from "@infrawrench/plugin-base";
import type { AzureResponse } from "./http.js";

const ARM = "https://management.azure.com";

export const RESOURCE_GRAPH_URL = `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01`;

/** Resource Graph's maximum page size. */
export const RESOURCE_GRAPH_PAGE_SIZE = 1000;

/**
 * Pages of assessments read per collection. 20 x 1000 (image, package) records
 * is far beyond a typical subscription; past it the walk stops and the
 * declaration's `partial` flag tells the host the list may be a subset.
 */
export const MAX_ASSESSMENT_PAGES = 20;

/** CVE ids per `cvedetails` enrichment query, and how many such queries at most. */
const CVE_DETAILS_BATCH = 300;
const MAX_CVE_DETAILS_BATCHES = 10;

const PRICINGS_API_VERSION = "2024-01-01";

const HELP = {
  label: "Enable Defender for Containers",
  url: "https://learn.microsoft.com/en-us/azure/defender-for-cloud/defender-for-containers-enable-plan",
};

const PERMISSION_HELP = {
  label: "Defender for Cloud permissions",
  url: "https://learn.microsoft.com/en-us/azure/defender-for-cloud/permissions",
};

export const ASSESSMENTS_QUERY = [
  "securityresources",
  '| where type == "microsoft.security/assessments"',
  '| where properties.metadata.recommendationCategory == "SoftwareUpdate"',
  '| where properties.resourceDetails.ResourceType =~ ".containerimage"',
  '| where properties.resourceDetails.Source =~ "Azure"',
  '| where properties.status.code =~ "Unhealthy"',
  "| project id, name, properties",
].join("\n");

export const REGISTRIES_QUERY = [
  "resources",
  '| where type =~ "microsoft.containerregistry/registries"',
  "| project id, name, loginServer = tostring(properties.loginServer)",
].join("\n");

/** Everything collection needs from the client, and nothing more. */
export interface AzureVulnerabilityContext {
  subscriptionId: string;
  /** AAD-authenticated ARM request, routed through host HTTP when available. */
  request(method: "GET" | "POST", url: string, body?: unknown): Promise<AzureResponse>;
}

type Bag = Record<string, unknown>;

interface GraphPage {
  data?: Bag[];
  $skipToken?: string;
}

function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resource Graph hands several nested values back as JSON strings. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function bagOf(value: unknown): Bag | undefined {
  const parsed = parseMaybeJson(value);
  return isBag(parsed) ? parsed : undefined;
}

function arrayOf(value: unknown): unknown[] {
  const parsed = parseMaybeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

/** First non-empty string among the candidates. */
function str(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
  }
  return undefined;
}

async function errorText(res: AzureResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** One Resource Graph query, every page up to `maxPages`. */
async function queryResourceGraph(
  ctx: AzureVulnerabilityContext,
  query: string,
  scope: "subscription" | "tenant",
  maxPages: number,
): Promise<Bag[]> {
  const rows: Bag[] = [];
  let skipToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = {
      query,
      ...(scope === "subscription" ? { subscriptions: [ctx.subscriptionId] } : {}),
      options: {
        $top: RESOURCE_GRAPH_PAGE_SIZE,
        resultFormat: "objectArray",
        ...(skipToken ? { $skipToken: skipToken } : {}),
      },
    };
    const res = await ctx.request("POST", RESOURCE_GRAPH_URL, body);
    if (res.status === 401 || res.status === 403) {
      throw new VulnerabilityAccessError(
        `Azure Resource Graph refused the query (${res.status}). The service principal needs Reader (or Security Reader) on the subscription.`,
        PERMISSION_HELP,
      );
    }
    if (!res.ok) {
      throw new Error(`Azure Resource Graph ${res.status}: ${await errorText(res)}`);
    }
    const json = await res.json<GraphPage>();
    rows.push(...(json.data ?? []));
    skipToken = json.$skipToken || undefined;
    if (!skipToken) break;
  }
  return rows;
}

interface PlanState {
  enabled: boolean;
  registryScanning: boolean | undefined;
}

/**
 * One Defender plan's state on the subscription
 * (https://learn.microsoft.com/en-us/rest/api/defenderforcloud/pricings/get).
 * A plan this API version does not know answers 404, which is "not enabled".
 */
async function planState(
  ctx: AzureVulnerabilityContext,
  plan: "Containers" | "CloudPosture",
): Promise<PlanState> {
  const res = await ctx.request(
    "GET",
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Security/pricings/${plan}?api-version=${PRICINGS_API_VERSION}`,
  );
  if (res.status === 401 || res.status === 403) {
    throw new VulnerabilityAccessError(
      `Reading the Defender for Cloud plan status was refused (${res.status}). The service principal needs Reader (or Security Reader) on the subscription.`,
      PERMISSION_HELP,
    );
  }
  if (res.status === 404) return { enabled: false, registryScanning: undefined };
  if (!res.ok) {
    throw new Error(`Defender for Cloud pricings ${res.status}: ${await errorText(res)}`);
  }
  const json = await res.json<Bag>();
  const props = bagOf(json["properties"]);
  const enabled = str(props?.["pricingTier"])?.toLowerCase() === "standard";
  const ext = arrayOf(props?.["extensions"])
    .filter(isBag)
    .find((e) => str(e["name"]) === "ContainerRegistriesVulnerabilityAssessments");
  return { enabled, registryScanning: ext ? bool(ext["isEnabled"]) : undefined };
}

/**
 * Registry vulnerability assessment runs under Defender for Containers or
 * Defender CSPM, with the plan's "Registry access" extension on. Neither on
 * means the scanner never ran, and an empty list would read as "clean".
 */
async function assertScanningEnabled(ctx: AzureVulnerabilityContext): Promise<void> {
  const plans = await Promise.all([planState(ctx, "Containers"), planState(ctx, "CloudPosture")]);
  const scanning = plans.some((p) => p.enabled && p.registryScanning !== false);
  if (scanning) return;
  const anyEnabled = plans.some((p) => p.enabled);
  throw new VulnerabilityAccessError(
    anyEnabled
      ? "Defender for Cloud is enabled on this subscription but its registry access (container registry vulnerability assessment) extension is off."
      : "Container image vulnerability assessment needs the Defender for Containers or Defender CSPM plan on this subscription; both are on the free tier.",
    HELP,
  );
}

/** `.../providers/Microsoft.ContainerRegistry/registries/<name>` from any id under it. */
function registryNameFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const match = /\/providers\/microsoft\.containerregistry\/registries\/([^/]+)/i.exec(id);
  return match?.[1]?.toLowerCase();
}

interface CveDetail {
  severity?: string;
  cvssScore?: number;
  cvssVector?: string;
  exploitAvailable?: boolean;
}

/**
 * Exploit signal from MDVM's exploitability block. True when any signal says
 * an exploit exists; false only when the block is there and every signal it
 * carries says no; otherwise unknown.
 */
function exploitFrom(block: Bag | undefined): boolean | undefined {
  if (!block) return undefined;
  const signals = [
    block["IsInExploitKit"],
    block["ExploitStepsVerified"],
    block["IsVerified"],
    block["ExploitStepsPublished"],
  ]
    .map(bool)
    .filter((v): v is boolean => v !== undefined);
  if (signals.length === 0) return undefined;
  return signals.some(Boolean);
}

/** Inline `Cvss` array: the highest version that carries a base score. */
function inlineCvss(value: unknown): { score?: number; vector?: string } {
  const entries = arrayOf(value).filter(isBag);
  let best: { version: number; score: number; vector?: string } | undefined;
  for (const entry of entries) {
    const inner = bagOf(entry["Value"]) ?? entry;
    const score = num(inner["Base"] ?? inner["base"]);
    if (score === undefined) continue;
    const version = num(entry["Version"] ?? entry["version"]) ?? 0;
    if (!best || version > best.version) {
      const vector = str(inner["Vector"], inner["vector"], entry["Vector"]);
      best = { version, score, ...(vector ? { vector } : {}) };
    }
  }
  return best ? { score: best.score, ...(best.vector ? { vector: best.vector } : {}) } : {};
}

/** `cvss` keyed by version (`"4.0"`, `"3.0"`, `"2.0"`): the highest present. */
function versionedCvss(value: unknown): { score?: number; vector?: string } {
  const cvss = bagOf(value);
  if (!cvss) return {};
  const versions = Object.keys(cvss).sort((a, b) => Number(b) - Number(a));
  for (const v of versions) {
    const entry = bagOf(cvss[v]);
    const score = num(entry?.["base"] ?? entry?.["Base"]);
    if (score !== undefined) {
      const vector = str(entry?.["vector"], entry?.["Vector"]);
      return { score, ...(vector ? { vector } : {}) };
    }
  }
  return {};
}

const CVE_ID = /^CVE-\d{4}-\d{4,}$/;

/**
 * Best-effort lookup in the tenant-level `microsoft.security/cvedetails`
 * table. Any failure (no tenant visibility, throttling) returns what was read
 * so far: this only adds scores to findings that are already complete.
 */
async function fetchCveDetails(
  ctx: AzureVulnerabilityContext,
  cveIds: string[],
): Promise<Map<string, CveDetail>> {
  const out = new Map<string, CveDetail>();
  const ids = [...new Set(cveIds.map((id) => id.toUpperCase()))].filter((id) => CVE_ID.test(id));
  for (
    let i = 0, batch = 0;
    i < ids.length && batch < MAX_CVE_DETAILS_BATCHES;
    i += CVE_DETAILS_BATCH, batch++
  ) {
    const slice = ids.slice(i, i + CVE_DETAILS_BATCH);
    const query = [
      "securityresources",
      '| where type =~ "microsoft.security/cvedetails"',
      "| extend cveIdJoin = toupper(coalesce(tostring(properties.cveId), tostring(name)))",
      `| where cveIdJoin in (${slice.map((id) => `"${id}"`).join(", ")})`,
      "| project id, cveIdJoin, properties",
    ].join("\n");
    let rows: Bag[];
    try {
      rows = await queryResourceGraph(ctx, query, "tenant", 2);
    } catch {
      break;
    }
    for (const row of rows) {
      const id = str(row["cveIdJoin"]);
      const props = bagOf(row["properties"]);
      if (!id || !props) continue;
      const cvss = versionedCvss(props["cvss"]);
      const severity = str(props["severity"]);
      const exploitAvailable = exploitFrom(bagOf(props["exploitabilityDetails"]));
      out.set(id.toUpperCase(), {
        ...(severity ? { severity } : {}),
        ...(cvss.score !== undefined ? { cvssScore: cvss.score } : {}),
        ...(cvss.vector ? { cvssVector: cvss.vector } : {}),
        ...(exploitAvailable !== undefined ? { exploitAvailable } : {}),
      });
    }
  }
  return out;
}

function portalUrl(links: Bag | undefined): string | undefined {
  const uri = str(links?.["azurePortalUri"], links?.["azurePortal"]);
  if (!uri) return undefined;
  if (/^https?:\/\//i.test(uri)) return uri;
  return `https://portal.azure.com/${uri.replace(/^\/+/, "")}`;
}

/** `FixStatus` words MDVM uses; anything else stays unknown. */
function fixFromStatus(status: string | undefined): boolean | undefined {
  if (!status) return undefined;
  const s = status.replace(/[\s_-]/g, "").toLowerCase();
  if (s === "fixavailable" || s === "fixed") return true;
  if (s === "nofixavailable" || s === "nofix" || s === "wontfix" || s === "willnotfix") {
    return false;
  }
  return undefined;
}

interface PendingFinding {
  finding: VulnerabilityFinding;
  /** Severity word for the recommendation as a whole; the last fallback. */
  recommendationSeverity?: string;
  inlineSeverity?: string;
}

/**
 * Open container image findings for the subscription: one finding per CVE per
 * (image, package) recommendation.
 */
export async function fetchAzureVulnerabilityFindings(
  ctx: AzureVulnerabilityContext,
): Promise<VulnerabilityFinding[]> {
  await assertScanningEnabled(ctx);

  const assessments = await queryResourceGraph(
    ctx,
    ASSESSMENTS_QUERY,
    "subscription",
    MAX_ASSESSMENT_PAGES,
  );
  if (assessments.length === 0) return [];

  const registries = await queryResourceGraph(ctx, REGISTRIES_QUERY, "subscription", 5);
  const loginServers = new Map<string, string>();
  for (const r of registries) {
    const name = str(r["name"])?.toLowerCase();
    const server = str(r["loginServer"])?.toLowerCase();
    if (name && server) loginServers.set(name, server);
  }

  const pending: PendingFinding[] = [];
  for (const row of assessments) {
    const assessmentId = str(row["id"]);
    const props = bagOf(row["properties"]);
    if (!assessmentId || !props) continue;

    const status = bagOf(props["status"]);
    if (str(status?.["code"])?.toLowerCase() !== "unhealthy") continue;

    const details = bagOf(props["resourceDetails"]);
    const image = bagOf(props["resourceAdditionalData"]);
    const repoDetails = bagOf(image?.["RepositoryDetails"]);
    const repository = str(repoDetails?.["RepositoryName"], image?.["RepositoryName"]);
    if (!repository) continue;

    const registryName = registryNameFromId(
      str(details?.["Id"], details?.["id"], details?.["ResourceId"]),
    );
    // The login server Resource Graph reports for the registry is exact. A
    // registry outside this subscription is not in that lookup; for it the
    // default `<name>.azurecr.io` login server is the best available
    // reference (registries created with a hashed DNS label differ), and with
    // no registry at all the bare repository still keys the inventory, it just
    // cannot join a running image.
    const host = str(
      registryName ? loginServers.get(registryName) : undefined,
      image?.["RegistryHost"],
      repoDetails?.["RegistryHost"],
      registryName ? `${registryName}.azurecr.io` : undefined,
    )?.toLowerCase();
    const imageName = host ? `${host}/${repository}` : repository;

    const digest = str(image?.["Digest"], image?.["ImageDigest"]);
    const tags = arrayOf(image?.["Tags"] ?? repoDetails?.["Tags"]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );

    const additional = bagOf(props["additionalData"]);
    const metadata = bagOf(props["metadata"]);
    const packageName = str(additional?.["SoftwareName"], additional?.["softwareName"]);
    const detected = parseMaybeJson(additional?.["DetectedSoftwareVersions"]);
    const installedVersion = Array.isArray(detected)
      ? detected.filter((v): v is string => typeof v === "string" && v.length > 0).join(", ") ||
        undefined
      : str(detected);
    const packageFixedVersion = str(additional?.["FixedVersion"]);
    const ecosystem = str(additional?.["PackageType"], additional?.["Language"]);
    const title = str(props["displayName"]);
    const url = portalUrl(bagOf(props["links"]));
    const firstSeenAt = str(status?.["firstEvaluationDate"]);
    const lastSeenAt = str(status?.["statusChangeDate"]);
    const recommendationSeverity = str(metadata?.["severity"]);

    for (const raw of arrayOf(additional?.["CvesDetails"])) {
      const cve = bagOf(raw);
      const cveId = str(cve?.["CveId"], cve?.["cveId"])?.toUpperCase();
      if (!cve || !cveId) continue;
      const cvss = inlineCvss(cve["Cvss"] ?? cve["cvss"]);
      const fixedVersion = str(cve["FixedVersion"], packageFixedVersion);
      const fixAvailable =
        fixFromStatus(str(cve["FixStatus"], additional?.["FixStatus"])) ??
        (fixedVersion ? true : undefined);
      const exploitAvailable = exploitFrom(bagOf(cve["ExploitabilityDetails"]));
      const inlineSeverity = str(cve["Severity"], cve["severity"]);

      pending.push({
        ...(recommendationSeverity ? { recommendationSeverity } : {}),
        ...(inlineSeverity ? { inlineSeverity } : {}),
        finding: {
          // The assessment id is the (image, package) recommendation; the
          // CVE makes it one advisory. Neither changes between rescans of an
          // unchanged image.
          id: `${assessmentId}#${cveId}`,
          advisoryId: cveId,
          ...(title ? { title } : {}),
          severity: "unknown",
          ...(cvss.score !== undefined ? { cvssScore: cvss.score } : {}),
          ...(cvss.vector ? { cvssVector: cvss.vector } : {}),
          ...(packageName ? { packageName } : {}),
          ...(ecosystem ? { packageEcosystem: ecosystem.toLowerCase() } : {}),
          ...(installedVersion ? { installedVersion } : {}),
          ...(fixedVersion ? { fixedVersion } : {}),
          ...(fixAvailable !== undefined ? { fixAvailable } : {}),
          ...(exploitAvailable !== undefined ? { exploitAvailable } : {}),
          artifact: {
            kind: "image",
            name: imageName,
            ...(digest ? { digest } : {}),
            ...(tags.length > 0 ? { tags } : {}),
          },
          ...(firstSeenAt ? { firstSeenAt } : {}),
          ...(lastSeenAt ? { lastSeenAt } : {}),
          ...(url ? { url } : {}),
        },
      });
    }
  }

  const needDetails = pending
    .filter(
      (p) =>
        p.finding.cvssScore === undefined ||
        !p.inlineSeverity ||
        p.finding.exploitAvailable === undefined,
    )
    .map((p) => p.finding.advisoryId);
  const cveDetails = needDetails.length > 0 ? await fetchCveDetails(ctx, needDetails) : new Map();

  const findings = pending.map(({ finding, inlineSeverity, recommendationSeverity }) => {
    const detail: CveDetail | undefined = cveDetails.get(finding.advisoryId);
    const cvssScore = finding.cvssScore ?? detail?.cvssScore;
    const cvssVector = finding.cvssVector ?? detail?.cvssVector;
    const exploitAvailable = finding.exploitAvailable ?? detail?.exploitAvailable;
    const cveSeverity = inlineSeverity ?? detail?.severity;
    let severity = normalizeVulnerabilitySeverity(cveSeverity, cvssScore);
    if (severity === "unknown") severity = normalizeVulnerabilitySeverity(recommendationSeverity);
    return {
      ...finding,
      severity,
      ...(cvssScore !== undefined ? { cvssScore } : {}),
      ...(cvssVector ? { cvssVector } : {}),
      ...(exploitAvailable !== undefined ? { exploitAvailable } : {}),
    };
  });

  return normalizeVulnerabilityFindings(findings);
}
