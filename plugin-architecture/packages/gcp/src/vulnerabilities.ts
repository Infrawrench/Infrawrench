/**
 * Vulnerability findings from Artifact Analysis (the Container Analysis API,
 * `containeranalysis.googleapis.com` v1): the CVEs Google's own scanner has
 * found in the project's Artifact Registry images and packages.
 *
 * **Wire shape verified against the live discovery document, October 2026**
 * (https://containeranalysis.googleapis.com/$discovery/rest?version=v1) and
 * https://docs.cloud.google.com/artifact-analysis/docs/reference/rest/v1/projects.occurrences/list:
 *
 * - `GET /v1/projects/{project}/occurrences?filter=kind="VULNERABILITY"`,
 *   `pageSize` up to 1000, `nextPageToken` empty when done.
 * - `Occurrence`: `name` (`projects/P/occurrences/ID`), `resourceUri`
 *   (`https://us-docker.pkg.dev/p/repo/img@sha256:...`), `noteName`
 *   (`projects/goog-vulnz/notes/CVE-2024-1234`), `createTime`, `updateTime`,
 *   `vulnerability`.
 * - `VulnerabilityOccurrence`: `severity` / `effectiveSeverity`
 *   (`SEVERITY_UNSPECIFIED|MINIMAL|LOW|MEDIUM|HIGH|CRITICAL`), `cvssScore`,
 *   `shortDescription`, `fixAvailable`, `packageIssue[]`, `relatedUrls[]`,
 *   `risk.cisaKev`, `vexAssessment.state`.
 * - `PackageIssue`: `affectedPackage`, `affectedVersion` / `fixedVersion`
 *   (`Version`: `kind` NORMAL|MINIMUM|MAXIMUM, `fullName`, `name`,
 *   `revision`; a `fixedVersion` of kind MAXIMUM means "no fix yet"),
 *   `fixAvailable`, `packageType`, `effectiveSeverity`.
 *
 * The `CVSS` objects carry the metrics as enums but no vector string, so
 * `cvssVector` is left unset rather than reassembled: which CVSS 3.x minor
 * version the scanner used is not on the wire, and a rebuilt vector would be
 * a string the scanner never said.
 *
 * Needs `containeranalysis.occurrences.list`
 * (`roles/containeranalysis.occurrences.viewer`), and the Container Scanning
 * API (`containerscanning.googleapis.com`) enabled for findings to exist at
 * all; with it off, the list is simply empty, which is why an empty result is
 * checked against the service's state before being reported as clean.
 */

import {
  VulnerabilityAccessError,
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
  type VulnerabilityArtifact,
  type VulnerabilityFinding,
} from "@infrawrench/plugin-base";

export interface GcpVersion {
  epoch?: number;
  name?: string;
  revision?: string;
  inclusive?: boolean;
  kind?: string;
  fullName?: string;
}

export interface GcpPackageIssue {
  affectedCpeUri?: string;
  affectedPackage?: string;
  affectedVersion?: GcpVersion;
  fixedCpeUri?: string;
  fixedPackage?: string;
  fixedVersion?: GcpVersion;
  fixAvailable?: boolean;
  packageType?: string;
  effectiveSeverity?: string;
}

export interface GcpVulnerabilityOccurrence {
  type?: string;
  severity?: string;
  effectiveSeverity?: string;
  cvssScore?: number;
  cvssVersion?: string;
  shortDescription?: string;
  longDescription?: string;
  fixAvailable?: boolean;
  packageIssue?: GcpPackageIssue[];
  relatedUrls?: Array<{ url?: string; label?: string }>;
  risk?: { cisaKev?: { knownRansomwareCampaignUse?: string }; epss?: unknown };
  vexAssessment?: { state?: string; vulnerabilityId?: string };
}

export interface GcpOccurrence {
  name?: string;
  resourceUri?: string;
  noteName?: string;
  kind?: string;
  createTime?: string;
  updateTime?: string;
  vulnerability?: GcpVulnerabilityOccurrence;
}

export interface GcpOccurrenceList {
  occurrences?: GcpOccurrence[];
  nextPageToken?: string;
}

/** What this module needs from the network, injected for tests. */
export interface GcpVulnerabilityContext {
  project: string;
  /** `projects.occurrences.list` with `filter=kind="VULNERABILITY"`, paginated. */
  listOccurrences(pageToken?: string): Promise<GcpOccurrenceList>;
  /**
   * Service Usage `services.get` state (`ENABLED` / `DISABLED`) for a service,
   * or undefined when it cannot be read (the key lacks
   * `serviceusage.services.get`). Only consulted when the list comes back empty.
   */
  getServiceState(service: string): Promise<string | undefined>;
}

/**
 * Pages of 1000 occurrences. 20 pages is 20,000 (image, CVE) pairs, which is
 * past what a project carries unless it keeps years of unpulled images; when
 * the bound bites the declaration's `partial: true` already says so.
 */
export const MAX_OCCURRENCE_PAGES = 20;
export const OCCURRENCE_PAGE_SIZE = 1000;

const SCANNING_SERVICE = "containerscanning.googleapis.com";
const ANALYSIS_SERVICE = "containeranalysis.googleapis.com";

/** A VEX assessment in one of these states means the advisory does not apply. */
const CLOSED_VEX_STATES = new Set(["NOT_AFFECTED", "FIXED"]);

/** `Version` to a display string; undefined for the MIN/MAX sentinels. */
export function versionString(v: GcpVersion | undefined): string | undefined {
  if (!v || (v.kind && v.kind !== "NORMAL")) return undefined;
  if (v.fullName) return v.fullName;
  if (!v.name) return undefined;
  const base = v.epoch ? `${v.epoch}:${v.name}` : v.name;
  return v.revision ? `${base}-${v.revision}` : base;
}

/**
 * `https://us-docker.pkg.dev/p/repo/img@sha256:abc` → image artifact
 * `{ name: "us-docker.pkg.dev/p/repo/img", digest: "sha256:abc" }`: the
 * reference a runtime pulls, without the scheme. A URI with no digest is a
 * non-image package (Artifact Registry language-package scanning).
 */
export function artifactFromResourceUri(uri: string): VulnerabilityArtifact | null {
  const bare = uri.trim().replace(/^https?:\/\//, "");
  if (!bare) return null;
  const at = bare.indexOf("@sha256:");
  if (at > 0) {
    return { kind: "image", name: bare.slice(0, at), digest: bare.slice(at + 1) };
  }
  return { kind: "package", name: bare };
}

/** Last path segment of `projects/goog-vulnz/notes/CVE-2024-1234`. */
function advisoryFromNote(noteName: string | undefined): string {
  return (noteName ?? "").split("/").pop()?.trim() ?? "";
}

function cleanSeverity(raw: string | undefined): string | undefined {
  return raw && raw !== "SEVERITY_UNSPECIFIED" ? raw : undefined;
}

/** One occurrence → one finding per affected package. */
export function occurrenceToFindings(occ: GcpOccurrence): VulnerabilityFinding[] {
  const vuln = occ.vulnerability;
  if (!vuln || !occ.name || !occ.resourceUri) return [];
  if (vuln.vexAssessment?.state && CLOSED_VEX_STATES.has(vuln.vexAssessment.state)) return [];
  const artifact = artifactFromResourceUri(occ.resourceUri);
  const advisoryId = advisoryFromNote(occ.noteName);
  if (!artifact || !advisoryId) return [];

  const cvssScore =
    typeof vuln.cvssScore === "number" && vuln.cvssScore > 0 ? vuln.cvssScore : undefined;
  const url = vuln.relatedUrls?.find((u) => u.url)?.url;
  // On CISA's Known Exploited Vulnerabilities catalogue = exploited in the
  // wild. Its absence says nothing either way, so it never becomes `false`.
  const exploited = vuln.risk?.cisaKev ? true : undefined;

  const base = {
    advisoryId,
    ...(vuln.shortDescription ? { title: vuln.shortDescription } : {}),
    ...(cvssScore !== undefined ? { cvssScore } : {}),
    ...(exploited ? { exploitAvailable: true } : {}),
    artifact,
    ...(occ.createTime ? { firstSeenAt: occ.createTime } : {}),
    ...(occ.updateTime ? { lastSeenAt: occ.updateTime } : {}),
    ...(url ? { url } : {}),
  };

  const issues = vuln.packageIssue ?? [];
  if (issues.length === 0) {
    return [
      {
        id: occ.name,
        ...base,
        severity: normalizeVulnerabilitySeverity(
          cleanSeverity(vuln.effectiveSeverity) ?? cleanSeverity(vuln.severity),
          cvssScore,
        ),
        ...(typeof vuln.fixAvailable === "boolean" ? { fixAvailable: vuln.fixAvailable } : {}),
      },
    ];
  }

  return issues.map((issue) => {
    const installed = versionString(issue.affectedVersion);
    const fixed = versionString(issue.fixedVersion);
    const fixAvailable =
      typeof issue.fixAvailable === "boolean"
        ? issue.fixAvailable
        : issue.fixedVersion?.kind === "MAXIMUM"
          ? false
          : issues.length === 1 && typeof vuln.fixAvailable === "boolean"
            ? vuln.fixAvailable
            : undefined;
    const pkg = issue.affectedPackage;
    return {
      // The occurrence id is stable across rescans of an unchanged image; the
      // package and installed version separate the issues within it.
      id: issues.length === 1 ? occ.name! : `${occ.name}#${pkg ?? ""}@${installed ?? ""}`,
      ...base,
      severity: normalizeVulnerabilitySeverity(
        cleanSeverity(issue.effectiveSeverity) ??
          cleanSeverity(vuln.effectiveSeverity) ??
          cleanSeverity(vuln.severity),
        cvssScore,
      ),
      ...(pkg ? { packageName: pkg } : {}),
      ...(issue.packageType ? { packageEcosystem: issue.packageType.toLowerCase() } : {}),
      ...(installed ? { installedVersion: installed } : {}),
      ...(fixed ? { fixedVersion: fixed } : {}),
      ...(fixAvailable !== undefined ? { fixAvailable } : {}),
    } satisfies VulnerabilityFinding;
  });
}

function enableUrl(service: string, project: string): string {
  return `https://console.cloud.google.com/apis/library/${service}?project=${encodeURIComponent(project)}`;
}

/** Rewrite a 403 into the action that fixes it; anything else propagates. */
function toAccessError(err: unknown, project: string): unknown {
  const status = (err as { status?: number } | null)?.status;
  if (status !== 403) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(ANALYSIS_SERVICE) && message.includes("not enabled")) {
    return new VulnerabilityAccessError(
      `The Container Analysis API is not enabled for project "${project}". Enable ` +
        `${ANALYSIS_SERVICE} and ${SCANNING_SERVICE} to read Artifact Analysis findings.`,
      { label: "Enable the Container Analysis API", url: enableUrl(ANALYSIS_SERVICE, project) },
    );
  }
  return new VulnerabilityAccessError(
    `The service account cannot list Artifact Analysis occurrences in project "${project}". ` +
      `Grant it roles/containeranalysis.occurrences.viewer.`,
    {
      label: "Grant the Container Analysis Occurrences Viewer role",
      url: `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(project)}`,
    },
  );
}

/**
 * Every open vulnerability occurrence in the project, one finding per affected
 * package. A failed page propagates rather than returning what was read so far:
 * the host replaces its stored findings with this list.
 */
export async function fetchGcpVulnerabilityFindings(
  ctx: GcpVulnerabilityContext,
): Promise<VulnerabilityFinding[]> {
  const findings: VulnerabilityFinding[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_OCCURRENCE_PAGES; page++) {
    let response: GcpOccurrenceList;
    try {
      response = await ctx.listOccurrences(pageToken);
    } catch (err) {
      throw toAccessError(err, ctx.project);
    }
    for (const occ of response.occurrences ?? []) {
      if (occ.kind && occ.kind !== "VULNERABILITY") continue;
      findings.push(...occurrenceToFindings(occ));
    }
    pageToken = response.nextPageToken || undefined;
    if (!pageToken) break;
  }

  if (findings.length === 0) {
    // Scanning is off unless the Container Scanning API is enabled, and with
    // it off the list is empty: indistinguishable from a clean project unless
    // we ask. A key that cannot read service state gets the benefit of the doubt.
    const state = await ctx.getServiceState(SCANNING_SERVICE).catch(() => undefined);
    if (state === "DISABLED") {
      throw new VulnerabilityAccessError(
        `The Container Scanning API is not enabled for project "${ctx.project}", so ` +
          `Artifact Analysis is not scanning its images. Enable ${SCANNING_SERVICE}.`,
        {
          label: "Enable the Container Scanning API",
          url: enableUrl(SCANNING_SERVICE, ctx.project),
        },
      );
    }
  }

  return normalizeVulnerabilityFindings(findings);
}
