/**
 * Xray vulnerability findings: the CVEs Xray has found in the artifacts of the
 * repositories it indexes, read artifact by artifact.
 *
 * **Why the artifact summary and not the violations list.** `POST
 * /xray/api/v1/violations` only reports what a watch + policy pair flagged, so
 * an org with Xray indexing on but no security watch would read as clean. The
 * artifact summary is what Xray found, independent of any policy.
 *
 * **Wire shapes verified against the live JFrog docs, October 2026:**
 * - Artifact Summary v2, `POST /xray/api/v2/summary/artifact`:
 *   https://docs.jfrog.com/security/reference/artifact-summary_artifacts-v2-openapi
 *   Body `{ paths: ["default/<repo>/<path>/<name>"] }` (paths start with the
 *   binary manager id, `default` for Xray 3.x). Each `artifacts[].issues[]`
 *   carries `issue_id`, `issue_type`, `severity`, `summary`, `cves[]` with
 *   `cve`, `cvss_v3` and `cvss_v2` as `<score>/<vector>`, and (v2 only)
 *   `components[]` with `component_id`, `version`, `pkg_type`,
 *   `fixed_versions`. Needs Read on the repository.
 * - Artifact Summary v1, `POST /xray/api/v1/summary/artifact` (same body, no
 *   `components`), used when an older Xray answers 404 to v2:
 *   https://docs.jfrog.com/security/reference/artifact-summary
 * - Artifactory Query Language, `POST /artifactory/api/search/aql`
 *   (`text/plain`), to enumerate the artifacts; non-admin tokens must include
 *   `repo`, `path` and `name`:
 *   https://docs.jfrog.com/artifactory/docs/aql-query-execution
 *   https://docs.jfrog.com/artifactory/docs/aql-entities-fields-reference
 * - Docker images pull as `<platform host>/<repo key>/<image>:<tag>` (the
 *   repository path method, JFrog Cloud's default):
 *   https://docs.jfrog.com/artifactory/docs/docker-repositories
 *   A platform set up with the subdomain method pulls as
 *   `<repo>.<host>/<image>`, which this module does not produce.
 *
 * **Bounds.** Repositories with `xrayIndex` on, at most {@link MAX_REPOS}; per
 * repository the {@link MAX_ARTIFACTS_PER_REPO} most recently modified
 * scannable artifacts; at most {@link MAX_ARTIFACTS} overall. The manifest
 * declares `partial: true` because all three can bite.
 */

import {
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
  VulnerabilityAccessError,
  type VulnerabilityFinding,
} from "@infrawrench/plugin-base";
import { encodePath, jfrogFetch, statusOf, type JfrogContext } from "./api.js";

export const MAX_REPOS = 25;
export const MAX_ARTIFACTS_PER_REPO = 50;
export const MAX_ARTIFACTS = 500;
/** Paths per summary request; small so one slow artifact does not time the batch out. */
const SUMMARY_BATCH = 10;

const XRAY_HELP = {
  label: "Index Xray resources",
  url: "https://docs.jfrog.com/security/docs/index-xray-resources",
};

/** A repository as the client knows it, reduced to what the walk needs. */
export interface XrayRepo {
  key: string;
  /** `local`, `remote`, `virtual` or `federated`. */
  rclass: string;
  packageType: string;
  xrayIndex: boolean;
}

/**
 * Which files Xray scans per package type: the AQL name patterns that pick the
 * package files out of the metadata around them (`.pom`, checksums,
 * `maven-metadata.xml`). Types not listed are skipped rather than walked file
 * by file.
 */
const SCANNABLE: Record<string, string[]> = {
  docker: ["manifest.json"],
  oci: ["manifest.json"],
  maven: ["*.jar", "*.war", "*.ear"],
  gradle: ["*.jar", "*.war", "*.ear"],
  ivy: ["*.jar", "*.war", "*.ear"],
  sbt: ["*.jar", "*.war", "*.ear"],
  npm: ["*.tgz"],
  pypi: ["*.whl", "*.tar.gz", "*.zip"],
  nuget: ["*.nupkg"],
  go: ["*.zip"],
  rpm: ["*.rpm"],
  debian: ["*.deb"],
  alpine: ["*.apk"],
  gems: ["*.gem"],
  composer: ["*.zip"],
  cargo: ["*.crate"],
  conda: ["*.conda", "*.tar.bz2"],
  helm: ["*.tgz"],
};

interface AqlItem {
  repo?: string;
  path?: string;
  name?: string;
  sha256?: string;
  modified?: string;
}

interface SummaryIssue {
  issue_id?: string;
  summary?: string;
  issue_type?: string;
  severity?: string;
  cves?: Array<{ cve?: string; cvss_v2?: string; cvss_v3?: string }>;
  components?: Array<{
    component_id?: string;
    version?: string;
    pkg_type?: string;
    fixed_versions?: string[];
  }>;
  extended_information?: { short_description?: string };
}

export interface SummaryResponse {
  artifacts?: Array<{
    general?: {
      component_id?: string;
      name?: string;
      path?: string;
      pkg_type?: string;
      sha256?: string;
    };
    issues?: SummaryIssue[];
  }>;
  errors?: Array<{ identifier?: string; error?: string }>;
}

/** One artifact to ask Xray about, and how to describe it. */
interface Target {
  /** `default/<storage repo>/<path>/<name>`: what the summary is keyed by. */
  xrayPath: string;
  /** The file's own SHA-256, lower-cased, a fallback key into the summary. */
  sha256?: string;
  artifact: VulnerabilityFinding["artifact"];
}

/** `"7.5/CVSS:3.1/AV:N/…"` into score and vector; either half may be missing. */
export function parseCvss(raw: string | undefined): { score?: number; vector?: string } {
  if (!raw) return {};
  const slash = raw.indexOf("/");
  const head = slash === -1 ? raw : raw.slice(0, slash);
  const rest = slash === -1 ? "" : raw.slice(slash + 1);
  const score = Number(head);
  return {
    ...(head && Number.isFinite(score) ? { score } : {}),
    ...(rest ? { vector: rest } : {}),
  };
}

const ECOSYSTEMS: Record<string, string> = {
  gav: "maven",
  npm: "npm",
  pypi: "pypi",
  go: "go",
  nuget: "nuget",
  deb: "deb",
  rpm: "rpm",
  alpine: "apk",
  gem: "gem",
  composer: "composer",
  cargo: "cargo",
  conda: "conda",
  docker: "docker",
  generic: "generic",
};

/** `npm://moment:2.29.3` into ecosystem, name and version. */
export function parseComponentId(id: string): {
  ecosystem?: string;
  name?: string;
  version?: string;
} {
  const m = /^([a-z0-9-]+):\/\/(.+)$/i.exec(id);
  if (!m) return {};
  const scheme = m[1]!.toLowerCase();
  const rest = m[2]!;
  const colon = rest.lastIndexOf(":");
  return {
    ecosystem: ECOSYSTEMS[scheme] ?? scheme,
    name: colon > 0 ? rest.slice(0, colon) : rest,
    ...(colon > 0 ? { version: rest.slice(colon + 1) } : {}),
  };
}

const DIGEST_FOLDER = /^sha256(?:__|:)([0-9a-f]{64})$/i;

/**
 * Describe one AQL row as an artifact. Docker manifests become `image`
 * artifacts named as a runtime pulls them; everything else a `package`.
 */
export function targetFor(baseUrl: string, repo: XrayRepo, item: AqlItem): Target | undefined {
  const storageRepo = item.repo ?? "";
  const name = item.name ?? "";
  if (!storageRepo || !name) return undefined;
  const path = item.path && item.path !== "." ? item.path : "";
  const full = [storageRepo, path, name].filter(Boolean).join("/");
  const uiUrl = `${baseUrl}/ui/repos/tree/General/${encodePath(full)}`;
  const xrayPath = `default/${full}`;
  const sha256 = item.sha256 ? item.sha256.toLowerCase() : undefined;

  const pkg = repo.packageType.toLowerCase();
  if (pkg === "docker" || pkg === "oci") {
    // `<image path>/<tag>/manifest.json`, or `<image path>/sha256__<digest>/manifest.json`
    // for a platform manifest under a multi-arch list.
    const segments = path.split("/").filter(Boolean);
    const last = segments.pop();
    if (!last || segments.length === 0) return undefined;
    const host = baseUrl.replace(/^https?:\/\//i, "");
    const digestFolder = DIGEST_FOLDER.exec(last);
    const digest = digestFolder
      ? `sha256:${digestFolder[1]!.toLowerCase()}`
      : sha256
        ? `sha256:${sha256}`
        : undefined;
    return {
      xrayPath,
      ...(sha256 ? { sha256 } : {}),
      artifact: {
        kind: "image",
        // A remote repository caches into `<key>-cache`; clients pull through `<key>`.
        name: `${host}/${repo.key}/${segments.join("/")}`,
        ...(digest ? { digest } : {}),
        ...(digestFolder ? {} : { tags: [last] }),
        url: uiUrl,
      },
    };
  }
  return {
    xrayPath,
    ...(sha256 ? { sha256 } : {}),
    artifact: {
      kind: "package",
      name: full,
      url: uiUrl,
    },
  };
}

/** The AQL that lists one repository's most recent scannable files. */
export function aqlFor(storageRepo: string, patterns: string[], limit: number): string {
  const names = patterns.map((p) =>
    p.includes("*") ? { name: { $match: p } } : { name: { $eq: p } },
  );
  const criteria = {
    repo: storageRepo,
    type: "file",
    ...(names.length === 1 ? names[0] : { $or: names }),
  };
  return (
    `items.find(${JSON.stringify(criteria)})` +
    `.include("repo","path","name","sha256","modified")` +
    `.sort({"$desc":["modified"]})` +
    `.limit(${limit})`
  );
}

function accessError(err: unknown, what: string): never {
  const status = statusOf(err);
  if (status === 401 || status === 403) {
    throw new VulnerabilityAccessError(
      `JFrog refused the ${what} (HTTP ${status}). The token needs Read on the indexed repositories, and the platform needs an Xray subscription.`,
      XRAY_HELP,
    );
  }
  throw err;
}

/** Map every security issue in one summary response to findings. */
export function findingsFromSummary(
  res: SummaryResponse | undefined,
  targets: Map<string, Target>,
): VulnerabilityFinding[] {
  const out: VulnerabilityFinding[] = [];
  const bySha = new Map<string, Target>();
  for (const t of targets.values()) {
    if (t.sha256) bySha.set(t.sha256, t);
  }
  for (const a of res?.artifacts ?? []) {
    // The summary echoes the path with the binary manager id in front; match
    // with and without it, then by checksum, so a formatting difference does
    // not silently drop an artifact's findings.
    const path = (a.general?.path ?? "").replace(/^\/+/, "");
    const target =
      targets.get(path) ??
      targets.get(`default/${path}`) ??
      bySha.get((a.general?.sha256 ?? "").toLowerCase());
    if (!target) continue;
    for (const issue of a.issues ?? []) {
      if ((issue.issue_type ?? "").toLowerCase() !== "security") continue;
      const issueId = issue.issue_id ?? "";
      const cves = (issue.cves ?? []).map((c) => c.cve ?? "").filter(Boolean);
      const advisoryId = cves[0] ?? issueId;
      if (!advisoryId) continue;
      const aliases = [...cves.slice(1), ...(issueId && issueId !== advisoryId ? [issueId] : [])];
      const firstCve = issue.cves?.[0];
      const cvss = parseCvss(firstCve?.cvss_v3);
      const scored = cvss.score !== undefined ? cvss : parseCvss(firstCve?.cvss_v2);
      const title = issue.summary || issue.extended_information?.short_description;
      const base: Omit<VulnerabilityFinding, "id"> = {
        advisoryId,
        ...(aliases.length ? { aliases } : {}),
        ...(title ? { title } : {}),
        severity: normalizeVulnerabilitySeverity(issue.severity, scored.score),
        ...(scored.score !== undefined ? { cvssScore: scored.score } : {}),
        ...(scored.vector ? { cvssVector: scored.vector } : {}),
        artifact: target.artifact,
        ...(target.artifact.url ? { url: target.artifact.url } : {}),
      };
      const components = issue.components ?? [];
      if (components.length === 0) {
        out.push({ id: `${target.xrayPath}|${issueId || advisoryId}`, ...base });
        continue;
      }
      for (const c of components) {
        const parsed = parseComponentId(c.component_id ?? "");
        const fixed = (c.fixed_versions ?? []).filter(Boolean);
        const installed = c.version || parsed.version;
        out.push({
          id: `${target.xrayPath}|${issueId || advisoryId}|${c.component_id ?? ""}`,
          ...base,
          ...(parsed.name ? { packageName: parsed.name } : {}),
          ...(parsed.ecosystem
            ? { packageEcosystem: parsed.ecosystem }
            : c.pkg_type
              ? { packageEcosystem: c.pkg_type.toLowerCase() }
              : {}),
          ...(installed ? { installedVersion: installed } : {}),
          // Xray lists the fixed versions; an empty list is not stated to mean
          // "no fix", so it stays unknown rather than `false`.
          ...(fixed.length ? { fixedVersion: fixed[0], fixAvailable: true } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Read the open Xray findings for the account. Throws
 * {@link VulnerabilityAccessError} when Xray is absent or refuses the token,
 * and rethrows any other failure rather than return a short list.
 */
export async function fetchJfrogVulnerabilityFindings(
  ctx: JfrogContext,
  repos: XrayRepo[],
): Promise<VulnerabilityFinding[]> {
  const indexed = repos
    .filter((r) => r.xrayIndex && r.rclass !== "virtual" && SCANNABLE[r.packageType.toLowerCase()])
    .slice(0, MAX_REPOS);

  const targets = new Map<string, Target>();
  for (const repo of indexed) {
    if (targets.size >= MAX_ARTIFACTS) break;
    const storageRepo = repo.rclass === "remote" ? `${repo.key}-cache` : repo.key;
    const limit = Math.min(MAX_ARTIFACTS_PER_REPO, MAX_ARTIFACTS - targets.size);
    let res: { results?: AqlItem[] } | undefined;
    try {
      res = await jfrogFetch<{ results?: AqlItem[] }>(ctx, "/artifactory/api/search/aql", {
        method: "POST",
        body: aqlFor(storageRepo, SCANNABLE[repo.packageType.toLowerCase()]!, limit),
        contentType: "text/plain",
      });
    } catch (err) {
      accessError(err, `artifact search in ${repo.key}`);
    }
    for (const item of res?.results ?? []) {
      const t = targetFor(ctx.baseUrl, repo, item);
      if (t) targets.set(t.xrayPath, t);
    }
  }
  if (targets.size === 0) return [];

  const paths = [...targets.keys()];
  let version: "v2" | "v1" = "v2";
  const findings: VulnerabilityFinding[] = [];
  for (let i = 0; i < paths.length; i += SUMMARY_BATCH) {
    const batch = paths.slice(i, i + SUMMARY_BATCH);
    let res: SummaryResponse | undefined;
    try {
      res = await jfrogFetch<SummaryResponse>(ctx, `/xray/api/${version}/summary/artifact`, {
        method: "POST",
        body: { paths: batch },
      });
    } catch (err) {
      if (statusOf(err) === 404 && version === "v2") {
        // Xray older than the v2 summary: v1 has the same shape minus components.
        version = "v1";
        i -= SUMMARY_BATCH;
        continue;
      }
      if (statusOf(err) === 404) {
        throw new VulnerabilityAccessError(
          "Xray is not available on this JFrog Platform (the summary API answered 404). Vulnerability findings need an Xray subscription.",
          XRAY_HELP,
        );
      }
      accessError(err, "Xray artifact summary");
    }
    // Per-path `errors` mean Xray holds no scan for that file (not indexed yet,
    // or a file type it does not scan); there is nothing to report for it.
    findings.push(...findingsFromSummary(res, targets));
  }
  return normalizeVulnerabilityFindings(findings);
}
