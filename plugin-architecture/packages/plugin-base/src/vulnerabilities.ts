/**
 * The vulnerability contract: known CVEs (and GHSA / vendor advisories) the
 * provider's own scanner has found in an image, a package, a repository or a
 * host, normalised so the host can join them to what is actually running.
 *
 * This is deliberately not part of the posture contract. Posture rules are
 * declarations evaluated over already-synced fields and never call the
 * provider; a vulnerability finding is a *scan result* the provider computes
 * and we can only read, so it needs credentials, a pass of its own and storage.
 *
 * The differentiator is the join, not the list. Every scanner already shows its
 * own findings; what none of them can say is "this critical CVE is in an image
 * used by 3 running pods and 1 Lambda", because the scanner and the runtime
 * are different accounts on different providers. The plugin's half of that join
 * is {@link VulnerabilityArtifact}: say precisely *what* is affected (an image
 * repository and digest, a resource's provider-native id) and the host matches
 * it against every synced resource whose type declares
 * {@link RunningImageDeclaration}.
 *
 * **Every fact here is the scanner's own.** A plugin must never infer a
 * severity from a CVE id, invent a fixed version, or call an advisory "fixed"
 * because a newer package exists. Absent is a first-class answer
 * (`fixAvailable` undefined renders "unknown"), and an unknown that renders as
 * "no fix" is a lie in the direction that makes someone stop looking.
 */

/**
 * Normalised severity. `unknown` exists because several scanners report
 * `UNTRIAGED` / `NOT_AVAILABLE` / no rating at all, and folding those into
 * `low` would hide a CVE nobody has scored yet.
 */
export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "unknown";

/** Severities strongest first. The one list every surface derives its order from. */
export const VULNERABILITY_SEVERITIES: readonly VulnerabilitySeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];

/**
 * What kind of thing the finding is about.
 *
 * - `image`: a container image in a registry. `name` is the repository
 *   reference *without* tag or digest (`123.dkr.ecr.us-east-1.amazonaws.com/api`,
 *   `docker.io/library/nginx`); `digest` the manifest digest when known.
 * - `function`: a serverless function scanned as code (Lambda standard
 *   scanning). Join through `resourceExternalId`.
 * - `host`: a VM or node scanned by an agent (Inspector EC2, Defender for
 *   Servers). Join through `resourceExternalId`.
 * - `repository`: a source repository (Dependabot, GitLab). Never "running"
 *   by itself; it matters for the inventory, and for a later join to what
 *   that repository deploys.
 * - `package`: a package in an artifact store (JFrog) that is not an image.
 */
export type VulnerabilityArtifactKind = "image" | "function" | "host" | "repository" | "package";

/** Precisely what a finding affects: the plugin's half of the join to what is running. */
export interface VulnerabilityArtifact {
  kind: VulnerabilityArtifactKind;
  /**
   * Human and match identity. For `image`, the repository reference without
   * tag or digest; for `repository`, `owner/name` (or the provider's full path);
   * for `function`/`host`, the provider's display name.
   */
  name: string;
  /** Image manifest digest (`sha256:…`), for `image` artifacts. The strongest join key. */
  digest?: string;
  /** Tags the scanned image carries, when the scanner reports them. */
  tags?: string[];
  /**
   * The provider-native id of the affected resource (an ARN, a full GCP or
   * Azure resource id) when the scanner reports one. Matched against synced
   * resources' `externalId` and `id`, so an Inspector finding on a Lambda joins
   * the Lambda row even though no image reference is involved.
   */
  resourceExternalId?: string;
  /** Provider console link for the artifact. */
  url?: string;
}

/** One finding: one advisory in one package in one artifact. */
export interface VulnerabilityFinding {
  /**
   * Stable identity within the account across collections (the provider's own
   * finding id or ARN when it has one; otherwise advisory + artifact + package).
   * Must not embed anything that changes between scans of an unchanged
   * artifact, or every collection would look like a brand-new finding.
   */
  id: string;
  /** Primary advisory id: a CVE when the scanner has one, else the GHSA / vendor id. */
  advisoryId: string;
  /** Other ids for the same advisory (the CVE behind a GHSA, and so on). */
  aliases?: string[];
  /** The scanner's short description. */
  title?: string;
  severity: VulnerabilitySeverity;
  /** CVSS base score 0-10, as the scanner reports it. */
  cvssScore?: number;
  /** CVSS vector string, as the scanner reports it. */
  cvssVector?: string;
  /** Affected package name. */
  packageName?: string;
  /** Package ecosystem / manager (`npm`, `pypi`, `os`, `maven`, `deb`). */
  packageEcosystem?: string;
  /** Installed (vulnerable) version. */
  installedVersion?: string;
  /** Earliest version with the fix, as the scanner reports it. */
  fixedVersion?: string;
  /**
   * Whether the scanner says a fix exists. Absent means the scanner does not
   * say, which renders as unknown rather than as "no".
   */
  fixAvailable?: boolean;
  /** Scanner says a public exploit exists. Absent means unknown. */
  exploitAvailable?: boolean;
  artifact: VulnerabilityArtifact;
  /** When the scanner first observed this finding (ISO 8601). */
  firstSeenAt?: string;
  /** When the scanner last observed it (ISO 8601). */
  lastSeenAt?: string;
  /** Link to the finding (or the advisory) in the provider's console. */
  url?: string;
}

/**
 * Declared by a plugin whose client implements `listVulnerabilityFindings`.
 *
 * Its presence is what makes the host schedule a vulnerability pass for the
 * plugin's accounts and what the inventory uses to answer "which of my
 * providers can tell me this?". Its absence means the surface shows nothing
 * for those accounts, never "0 vulnerabilities".
 */
export interface VulnerabilityCapabilityDeclaration {
  /** The provider's own name for the scanner ("Amazon Inspector", "Dependabot"). */
  label: string;
  /** Where the user turns scanning on or reviews findings in the provider's console. */
  consoleUrl?: string;
  /**
   * True when reading findings needs a permission (or a paid tier) beyond
   * what the account's normal credential carries; the host explains an empty
   * or refused read as a permission gap rather than as a clean bill of health.
   */
  requiresElevatedCredential?: boolean;
  /**
   * True when the plugin reports a bounded subset (e.g. only the most recent
   * images, only critical+high) rather than every finding the scanner has.
   */
  partial?: boolean;
}

/**
 * Thrown by `listVulnerabilityFindings` when findings cannot be read until the
 * user does something: enabling the scanner, attaching a policy, granting a
 * token scope. Distinct from a transient failure for the reason
 * `QuotaAccessError` is.
 */
export class VulnerabilityAccessError extends Error {
  readonly helpLabel: string | undefined;
  readonly helpUrl: string | undefined;

  constructor(message: string, help?: { label: string; url: string }) {
    super(message);
    this.name = "VulnerabilityAccessError";
    this.helpLabel = help?.label;
    this.helpUrl = help?.url;
  }
}

/**
 * Declared on a resource type whose synced instances *run* container images:
 * Kubernetes workloads and pods, ECS tasks, Lambda container functions, Cloud
 * Run services, Container Apps. Names the already-synced fields holding image
 * references; the host parses them and matches findings by digest first, then
 * by repository + tag. Never an extra provider call.
 */
export interface RunningImageDeclaration {
  /**
   * Fields holding image references (`repo:tag`, `repo@sha256:…`). A field may
   * hold several, separated by commas, whitespace or newlines.
   */
  imageKeys: string[];
  /**
   * Fields holding resolved digests for the images above (Kubernetes
   * `status.containerStatuses[].imageID`, ECS `containers[].imageDigest`).
   * Either a bare `sha256:…` or a full `repo@sha256:…`; same separators.
   */
  digestKeys?: string[];
  /**
   * Field telling whether the instance is running now. Absent = every synced
   * instance counts as running (a Deployment, a Cloud Run service).
   */
  runningKey?: string;
  /** Values of `runningKey` (case-insensitive) that mean running. Required with `runningKey`. */
  runningValues?: string[];
}

const SEVERITY_WORDS: Record<string, VulnerabilitySeverity> = {
  critical: "critical",
  high: "high",
  important: "high",
  medium: "medium",
  moderate: "medium",
  low: "low",
  negligible: "low",
  minimal: "low",
  informational: "low",
  info: "low",
};

/**
 * Map a scanner's severity word to the normalised scale. Falls back to the
 * CVSS v3 bands only when the scanner gave no recognisable word at all, and to
 * `unknown` when it gave neither; never to `low`.
 */
export function normalizeVulnerabilitySeverity(
  raw: string | null | undefined,
  cvssScore?: number | null,
): VulnerabilitySeverity {
  const word = (raw ?? "").trim().toLowerCase();
  const mapped = SEVERITY_WORDS[word];
  if (mapped) return mapped;
  if (typeof cvssScore === "number" && Number.isFinite(cvssScore) && cvssScore > 0) {
    if (cvssScore >= 9) return "critical";
    if (cvssScore >= 7) return "high";
    if (cvssScore >= 4) return "medium";
    return "low";
  }
  return "unknown";
}

/**
 * Drop findings that cannot mean anything and tidy the ones that can. Shared
 * so every plugin gets the same handling:
 *
 * - no `id`, `advisoryId` or artifact name: dropped (it can be neither keyed
 *   nor joined);
 * - duplicate `id`: first wins, deterministically;
 * - CVSS outside 0-10 or non-finite: removed rather than clamped (a clamped
 *   score is a number the scanner never said);
 * - image digests lower-cased, advisory ids upper-cased (`cve-2024-1` and
 *   `CVE-2024-1` are one advisory).
 */
export function normalizeVulnerabilityFindings(
  findings: VulnerabilityFinding[],
): VulnerabilityFinding[] {
  const out: VulnerabilityFinding[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f.id || !f.advisoryId || !f.artifact?.name) continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const next: VulnerabilityFinding = {
      ...f,
      advisoryId: f.advisoryId.trim().toUpperCase(),
      artifact: {
        ...f.artifact,
        ...(f.artifact.digest ? { digest: f.artifact.digest.trim().toLowerCase() } : {}),
      },
    };
    if (
      next.cvssScore !== undefined &&
      (!Number.isFinite(next.cvssScore) || next.cvssScore < 0 || next.cvssScore > 10)
    ) {
      delete next.cvssScore;
    }
    if (next.aliases) {
      const aliases = [...new Set(next.aliases.map((a) => a.trim().toUpperCase()))].filter(
        (a) => a && a !== next.advisoryId,
      );
      if (aliases.length > 0) next.aliases = aliases;
      else delete next.aliases;
    }
    out.push(next);
  }
  return out;
}
