/**
 * GitLab vulnerability findings: the open entries of the vulnerability report
 * that came from dependency scanning and container scanning (the scanners
 * that report CVEs in packages and images), read through GraphQL.
 *
 * API choice (verified 2026-10 against `doc/api/` on gitlab-org/gitlab
 * master): the REST Vulnerabilities and Vulnerability Findings APIs are both
 * marked "in the process of being deprecated and considered unstable" and
 * point at GraphQL, so this reads `Group.vulnerabilities` (the group and its
 * subgroups in one connection) when the account is scoped to a group, and
 * `Project.vulnerabilities` per project otherwise
 * (https://docs.gitlab.com/api/graphql/reference/#groupvulnerabilities).
 * `Query.vulnerabilities` is not used: it reads the user's instance security
 * dashboard, a hand-picked project list, not "everything I can see".
 *
 * Tier and role: the vulnerability report is GitLab Ultimate, and reading it
 * needs the Developer role or above (or Security Manager) on the project or
 * group, plus the `read_api` or `api` token scope. GitLab does not refuse an
 * unlicensed read: the resolver answers an empty connection
 * (`return Vulnerability.none unless vulnerable&.feature_available?(:security_dashboard)`
 * in `ee/app/graphql/resolvers/vulnerabilities_resolver.rb`), which would
 * render as a clean bill of health. So the same query asks
 * `userPermissions.readSecurityResource` (GitLab 19.5+), the policy that
 * folds tier and role together. An instance too old to know that field gets
 * the query again without it, and an empty result there is checked against
 * the REST findings endpoint, which still answers 403 for the same policy.
 * Community Edition has no `vulnerabilities` field at all, which is reported
 * as the tier gap it is.
 *
 * Bounds: 50 pages of 100 for a group, 10 pages per project across the 100
 * most recently active projects otherwise. The capability is declared
 * `partial` because either bound can bite on a large estate.
 *
 * What the report does not say is left absent: GraphQL exposes no fixed
 * version (only free-text `solution`) and no package ecosystem.
 * `hasRemediations` is GitLab saying a fix exists; its absence is not GitLab
 * saying none does, so only `true` is passed on. Likewise `isKnownExploit`
 * (CISA KEV) is passed on only when true.
 */

import type { VulnerabilityArtifact, VulnerabilityFinding } from "@infrawrench/plugin-base";
import {
  VulnerabilityAccessError,
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
} from "@infrawrench/plugin-base";
import type { GitLabContext } from "./api.js";
import { glFetch, glGraphql, statusOf } from "./api.js";

/** Pages of 100 read for a group-scoped account. */
export const GROUP_MAX_PAGES = 50;
/** Pages of 100 read per project for an unscoped account. */
export const PROJECT_MAX_PAGES = 10;
/** Projects read at once for an unscoped account. */
const PROJECT_CONCURRENCY = 4;

/** The report types that carry package / image CVEs. */
const REPORT_TYPES = [
  "DEPENDENCY_SCANNING",
  "CONTAINER_SCANNING",
  "CONTAINER_SCANNING_FOR_REGISTRY",
];

const HELP = {
  label: "Vulnerability report access",
  url: "https://docs.gitlab.com/user/application_security/vulnerability_report/",
};

interface GlVulnIdentifier {
  externalType?: string | null;
  externalId?: string | null;
  name?: string | null;
  url?: string | null;
}

interface GlVulnDependency {
  version?: string | null;
  package?: { name?: string | null } | null;
}

/** One `Vulnerability` node, the fields {@link VULN_FIELDS} selects. */
export interface GlVulnerability {
  id?: string;
  title?: string | null;
  name?: string | null;
  state?: string | null;
  severity?: string | null;
  reportType?: string | null;
  detectedAt?: string | null;
  webUrl?: string | null;
  resolvedOnDefaultBranch?: boolean | null;
  hasRemediations?: boolean | null;
  identifiers?: GlVulnIdentifier[] | null;
  primaryIdentifier?: GlVulnIdentifier | null;
  cvss?: Array<{
    vector?: string | null;
    baseScore?: number | null;
    version?: number | null;
  }> | null;
  cveEnrichment?: { isKnownExploit?: boolean | null } | null;
  scanner?: { name?: string | null } | null;
  project?: { id?: string | null; fullPath?: string | null; webUrl?: string | null } | null;
  location?: {
    __typename?: string;
    file?: string | null;
    image?: string | null;
    operatingSystem?: string | null;
    dependency?: GlVulnDependency | null;
  } | null;
}

interface VulnConnection {
  nodes?: Array<GlVulnerability | null> | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

interface Scoped {
  id?: string;
  fullPath?: string;
  userPermissions?: { readSecurityResource?: boolean | null } | null;
  vulnerabilities?: VulnConnection | null;
}

const VULN_FIELDS = `
  nodes {
    id title name state severity reportType detectedAt webUrl
    resolvedOnDefaultBranch hasRemediations
    identifiers { externalType externalId name url }
    primaryIdentifier { externalType externalId name url }
    cvss { vector baseScore version }
    cveEnrichment { isKnownExploit }
    scanner { name }
    project { id fullPath webUrl }
    location {
      __typename
      ... on VulnerabilityLocationDependencyScanning {
        file
        dependency { version package { name } }
      }
      ... on VulnerabilityLocationContainerScanning {
        image
        operatingSystem
        dependency { version package { name } }
      }
    }
  }
  pageInfo { hasNextPage endCursor }`;

function scopedQuery(kind: "group" | "project", withPermission: boolean): string {
  return `query($fullPath: ID!, $after: String, $reportType: [VulnerabilityReportType!]) {
  scope: ${kind}(fullPath: $fullPath) {
    id fullPath
    ${withPermission ? "userPermissions { readSecurityResource }" : ""}
    vulnerabilities(state: [DETECTED, CONFIRMED], reportType: $reportType, first: 100, after: $after) {${VULN_FIELDS}
    }
  }
}`;
}

/** The numeric id at the end of a GitLab global id (`gid://gitlab/Project/42` -> `42`). */
function numericId(gid: string | null | undefined): string | undefined {
  const m = /\/(\d+)$/.exec(gid ?? "");
  return m ? m[1] : undefined;
}

/**
 * An image reference as a runtime would pull it, split into repository and
 * digest: `registry.gitlab.com/g/p/app:1.2@sha256:ab` gives
 * `registry.gitlab.com/g/p/app` and `sha256:ab`. A Docker Hub short name is
 * expanded the way the Docker daemon does (`python:3.12` ->
 * `docker.io/library/python`), so the host can match it against what runs.
 */
export function parseImageRef(
  raw: string,
): { name: string; digest?: string; tag?: string } | undefined {
  let ref = raw.trim();
  if (!ref || /\s/.test(ref)) return undefined;
  let digest: string | undefined;
  const at = ref.indexOf("@");
  if (at >= 0) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
    if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) digest = undefined;
  }
  let tag: string | undefined;
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) {
    tag = ref.slice(colon + 1);
    ref = ref.slice(0, colon);
  }
  if (!ref) return undefined;
  const parts = ref.split("/");
  const first = parts[0]!;
  const hasRegistry =
    parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (!hasRegistry) {
    ref = parts.length === 1 ? `docker.io/library/${ref}` : `docker.io/${ref}`;
  }
  return {
    name: ref.toLowerCase(),
    ...(digest ? { digest } : {}),
    ...(tag ? { tag } : {}),
  };
}

function pickAdvisory(v: GlVulnerability): { advisoryId?: string; aliases: string[] } {
  const ids = [...(v.identifiers ?? []), ...(v.primaryIdentifier ? [v.primaryIdentifier] : [])];
  const valueOf = (i: GlVulnIdentifier) => (i.name || i.externalId || "").trim();
  const ofType = (t: string) =>
    ids.find((i) => (i.externalType ?? "").toLowerCase() === t && valueOf(i));
  const chosen = ofType("cve") ?? ofType("ghsa") ?? v.primaryIdentifier ?? ids[0];
  const advisoryId = chosen ? valueOf(chosen) : undefined;
  const aliases = [
    ...new Set(
      ids
        .filter((i) => ["cve", "ghsa"].includes((i.externalType ?? "").toLowerCase()))
        .map(valueOf),
    ),
  ].filter((a) => a && a !== advisoryId);
  return { ...(advisoryId ? { advisoryId } : {}), aliases };
}

export function mapGitLabVulnerability(v: GlVulnerability): VulnerabilityFinding | undefined {
  if (!v.id) return undefined;
  if (v.state && !["DETECTED", "CONFIRMED"].includes(v.state)) return undefined;
  // GitLab's own word that the default branch no longer has it.
  if (v.resolvedOnDefaultBranch) return undefined;
  const { advisoryId, aliases } = pickAdvisory(v);
  if (!advisoryId) return undefined;
  const projectPath = v.project?.fullPath ?? undefined;
  const loc = v.location ?? undefined;
  const dep = loc?.dependency ?? undefined;

  const image = loc?.image ? parseImageRef(loc.image) : undefined;
  let artifact: VulnerabilityArtifact | undefined;
  if (image) {
    artifact = {
      kind: "image",
      name: image.name,
      ...(image.digest ? { digest: image.digest } : {}),
      ...(image.tag ? { tags: [image.tag] } : {}),
    };
  } else if (projectPath) {
    const projectId = numericId(v.project?.id);
    artifact = {
      kind: "repository",
      name: projectPath,
      // The project lister stores the numeric project id as `externalId`.
      ...(projectId ? { resourceExternalId: projectId } : {}),
      ...(v.project?.webUrl ? { url: v.project.webUrl } : {}),
    };
  }
  if (!artifact) return undefined;

  // Several CVSS entries (vendors and versions) may be reported; the newest
  // version wins, which is how the vulnerability page orders them.
  const cvss = [...(v.cvss ?? [])]
    .filter((c) => typeof c.baseScore === "number" && c.baseScore > 0)
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];

  return {
    id: v.id,
    advisoryId,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...((v.title ?? v.name) ? { title: (v.title ?? v.name)! } : {}),
    severity: normalizeVulnerabilitySeverity(v.severity, cvss?.baseScore),
    ...(cvss?.baseScore ? { cvssScore: cvss.baseScore } : {}),
    ...(cvss?.vector ? { cvssVector: cvss.vector } : {}),
    ...(dep?.package?.name ? { packageName: dep.package.name } : {}),
    ...(dep?.version ? { installedVersion: dep.version } : {}),
    ...(v.hasRemediations ? { fixAvailable: true } : {}),
    ...(v.cveEnrichment?.isKnownExploit ? { exploitAvailable: true } : {}),
    artifact,
    ...(v.detectedAt ? { firstSeenAt: v.detectedAt } : {}),
    ...(v.webUrl ? { url: v.webUrl } : {}),
  };
}

const NO_FIELD = /doesn't exist on type|Field '[^']+' doesn't exist/i;

function messages(errors: Array<{ message?: string }> | undefined): string {
  return (errors ?? [])
    .map((e) => e.message)
    .filter(Boolean)
    .join("; ");
}

function tierError(where: string): VulnerabilityAccessError {
  return new VulnerabilityAccessError(
    `GitLab cannot show the vulnerability report for ${where}. It needs GitLab Ultimate, and the token's user needs the Developer role or above (or Security Manager) there; the token needs the read_api or api scope.`,
    HELP,
  );
}

type ScopeRead =
  | { status: "ok"; findings: VulnerabilityFinding[]; permissionKnown: boolean }
  | { status: "denied" };

/** Mutable per-call state: whether this instance knows `readSecurityResource`. */
interface Probe {
  permissionField: boolean;
}

async function readScope(
  ctx: GitLabContext,
  kind: "group" | "project",
  fullPath: string,
  maxPages: number,
  probe: Probe,
): Promise<ScopeRead> {
  const out: VulnerabilityFinding[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await glGraphql<{ scope?: Scoped | null }>(
      ctx,
      scopedQuery(kind, probe.permissionField),
      { fullPath, after: after ?? null, reportType: REPORT_TYPES },
    );
    const errText = messages(res.errors);
    const scope = res.data?.scope;
    if (!scope?.vulnerabilities) {
      if (probe.permissionField && /readSecurityResource/.test(errText) && NO_FIELD.test(errText)) {
        // Older than GitLab 19.5: ask again without the permission field.
        probe.permissionField = false;
        page--;
        continue;
      }
      if (/vulnerabilities/.test(errText) && NO_FIELD.test(errText)) {
        throw new VulnerabilityAccessError(
          "This GitLab instance has no vulnerability report (it is Community Edition or unlicensed). Vulnerability findings need GitLab Ultimate.",
          HELP,
        );
      }
      if (errText) throw new Error(`GitLab vulnerabilities for ${fullPath}: ${errText}`);
      // No error and no scope: the token cannot see it, which is a gap in
      // access rather than an empty report.
      return { status: "denied" };
    }
    if (page === 0 && scope.userPermissions?.readSecurityResource === false) {
      return { status: "denied" };
    }
    for (const node of scope.vulnerabilities.nodes ?? []) {
      const f = node ? mapGitLabVulnerability(node) : undefined;
      if (f) out.push(f);
    }
    const info = scope.vulnerabilities.pageInfo;
    if (!info?.hasNextPage || !info.endCursor || info.endCursor === after) break;
    after = info.endCursor;
  }
  return { status: "ok", findings: out, permissionKnown: probe.permissionField };
}

/** Projects the REST fallback probes at most. */
const REST_PROBE_LIMIT = 10;

/**
 * For instances without `readSecurityResource`: the (deprecated) REST
 * findings list is authorised by the same `read_security_resource` policy, so
 * a 403 there means "no Ultimate or no Developer role" for certain. True only
 * when every probed project answers 403; any other answer (including the
 * endpoint having been removed) proves nothing.
 */
async function restDenied(
  ctx: GitLabContext,
  projects: GitLabVulnScope["projects"],
): Promise<boolean> {
  const probed = projects.slice(0, REST_PROBE_LIMIT);
  if (probed.length === 0) return false;
  for (const p of probed) {
    try {
      await glFetch<unknown>(ctx, `/projects/${p.id}/vulnerability_findings`, {
        query: { per_page: 1 },
      });
      return false;
    } catch (err) {
      if (statusOf(err) !== 403) return false;
    }
  }
  return true;
}

export interface GitLabVulnScope {
  /** Group-scoped account: the root group's full path. */
  groupPath?: string;
  /** Projects to read (the unscoped account's fan-out, or the group's for the REST probe). */
  projects: Array<{ id: number; path_with_namespace: string }>;
}

/**
 * Every open dependency- and container-scanning finding the account can see.
 * Throws on any partial failure; throws {@link VulnerabilityAccessError} when
 * nothing at all is readable for tier or role reasons.
 */
export async function fetchGitLabVulnerabilities(
  ctx: GitLabContext,
  scope: GitLabVulnScope,
): Promise<VulnerabilityFinding[]> {
  const probe: Probe = { permissionField: true };

  if (scope.groupPath) {
    const read = await readScope(ctx, "group", scope.groupPath, GROUP_MAX_PAGES, probe);
    if (read.status === "denied") throw tierError(`the ${scope.groupPath} group`);
    if (read.findings.length === 0 && !read.permissionKnown) {
      if (await restDenied(ctx, scope.projects)) {
        throw tierError(`the ${scope.groupPath} group`);
      }
    }
    return normalizeVulnerabilityFindings(read.findings);
  }

  if (scope.projects.length === 0) return [];
  const results: ScopeRead[] = new Array(scope.projects.length);
  let next = 0;
  const worker = async () => {
    while (next < scope.projects.length) {
      const i = next++;
      results[i] = await readScope(
        ctx,
        "project",
        scope.projects[i]!.path_with_namespace,
        PROJECT_MAX_PAGES,
        probe,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROJECT_CONCURRENCY, scope.projects.length) }, worker),
  );

  const readable = results.filter(
    (r): r is Extract<ScopeRead, { status: "ok" }> => r.status === "ok",
  );
  // A project in a namespace without Ultimate (or where the user is below
  // Developer) has no report to read; that is not a failure as long as some
  // project's report was readable. None readable at all is the access gap.
  if (readable.length === 0) throw tierError("any of this account's projects");
  const findings = readable.flatMap((r) => r.findings);
  if (findings.length === 0 && !probe.permissionField) {
    if (await restDenied(ctx, scope.projects)) {
      throw tierError("any of this account's projects");
    }
  }
  return normalizeVulnerabilityFindings(findings);
}
