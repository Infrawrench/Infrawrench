/**
 * Dependabot alerts: known advisories (CVE / GHSA) in the dependencies of the
 * owner's repositories, read with one owner-wide listing.
 *
 * - Organization: `GET /orgs/{org}/dependabot/alerts`.
 * - Enterprise: `GET /enterprises/{enterprise}/dependabot/alerts`, which only
 *   returns alerts from organizations where the token's user is an owner or a
 *   security manager.
 *
 * Both take `state=open` and paginate by cursor only: `per_page` (max 100)
 * plus the `after` cursor named in the `Link` header's `rel="next"` URL; page
 * numbers are not accepted. (GitHub REST docs, "REST API endpoints for
 * Dependabot alerts",
 * https://docs.github.com/en/rest/dependabot/alerts, verified 2026-10.)
 *
 * Access: the user must be an organization owner or security manager. A
 * fine-grained token needs the repository permission "Dependabot alerts"
 * (read) over all repositories; a classic token needs `security_events` (or
 * `repo`/`security_events` for the enterprise route). GitHub answers 403 for a
 * missing permission and 404 for an owner the token may not see, and both
 * mean the same thing to the user: grant access, then retry.
 *
 * What the alert does not say is left absent: there is no installed version
 * (only the vulnerable range) and no exploit flag. `first_patched_version` is
 * GitHub's own statement of whether a fix exists, so a `null` there is a real
 * "no patched version", not an unknown.
 */

import type { VulnerabilityFinding } from "@infrawrench/plugin-base";
import {
  VulnerabilityAccessError,
  normalizeVulnerabilityFindings,
  normalizeVulnerabilitySeverity,
} from "@infrawrench/plugin-base";
import type { GitHubContext } from "./api.js";
import { ghFetchWithHeaders, nextLink, ownerBase, statusOf } from "./api.js";

/** Pages of 100 read at most: 5,000 open alerts. Beyond that the read is partial. */
export const DEPENDABOT_MAX_PAGES = 50;

interface GhPatchedVersion {
  identifier?: string;
}

interface GhPackage {
  ecosystem?: string;
  name?: string;
}

interface GhCvss {
  score?: number | null;
  vector_string?: string | null;
}

/** One alert, as the org / enterprise list returns it (fields this module reads). */
export interface GhDependabotAlert {
  number?: number;
  state?: string;
  dependency?: {
    package?: GhPackage;
    manifest_path?: string;
    scope?: string | null;
    relationship?: string | null;
  };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    severity?: string;
    cvss?: GhCvss | null;
    cvss_severities?: { cvss_v3?: GhCvss | null; cvss_v4?: GhCvss | null } | null;
    identifiers?: Array<{ type?: string; value?: string }>;
    withdrawn_at?: string | null;
  };
  security_vulnerability?: {
    package?: GhPackage;
    severity?: string;
    vulnerable_version_range?: string;
    first_patched_version?: GhPatchedVersion | null;
  };
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  repository?: { full_name?: string; html_url?: string };
}

const HELP = {
  label: "Dependabot alert permissions",
  url: "https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-an-organization",
};

/**
 * The CVSS the advisory carries: v3 first (the scale every severity band in
 * the product is drawn from), then v4, then the legacy `cvss` object. GitHub
 * reports a score of 0 with a null vector for "not scored", which is skipped
 * rather than read as a score of zero.
 */
function pickCvss(a: GhDependabotAlert["security_advisory"]): GhCvss | undefined {
  const candidates = [a?.cvss_severities?.cvss_v3, a?.cvss_severities?.cvss_v4, a?.cvss];
  return candidates.find(
    (c): c is GhCvss => !!c && typeof c.score === "number" && c.score > 0 && !!c.vector_string,
  );
}

export function mapDependabotAlert(alert: GhDependabotAlert): VulnerabilityFinding | undefined {
  const repo = alert.repository?.full_name;
  const advisory = alert.security_advisory;
  if (!repo || alert.number === undefined || !advisory) return undefined;
  if (advisory.withdrawn_at) return undefined;
  const cve = advisory.cve_id || undefined;
  const ghsa = advisory.ghsa_id || undefined;
  const advisoryId = cve ?? ghsa;
  if (!advisoryId) return undefined;
  const aliases = [
    ...new Set([ghsa ?? "", ...(advisory.identifiers ?? []).map((i) => i.value ?? "")]),
  ].filter((a) => a && a !== advisoryId);
  const cvss = pickCvss(advisory);
  const vuln = alert.security_vulnerability;
  const pkg = alert.dependency?.package ?? vuln?.package;
  const patched = vuln?.first_patched_version;
  const finding: VulnerabilityFinding = {
    id: `${repo}#${alert.number}`,
    advisoryId,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(advisory.summary ? { title: advisory.summary } : {}),
    severity: normalizeVulnerabilitySeverity(
      vuln?.severity ?? advisory.severity,
      cvss?.score ?? undefined,
    ),
    ...(cvss?.score ? { cvssScore: cvss.score } : {}),
    ...(cvss?.vector_string ? { cvssVector: cvss.vector_string } : {}),
    ...(pkg?.name ? { packageName: pkg.name } : {}),
    ...(pkg?.ecosystem ? { packageEcosystem: pkg.ecosystem } : {}),
    ...(patched?.identifier ? { fixedVersion: patched.identifier } : {}),
    // `first_patched_version` is required in the schema: an object when a
    // patched release exists, `null` when GitHub says none does. Only a
    // response that omits it entirely leaves the answer unknown.
    ...(vuln && "first_patched_version" in vuln ? { fixAvailable: !!patched?.identifier } : {}),
    artifact: {
      kind: "repository",
      name: repo,
      ...(alert.repository?.html_url ? { url: alert.repository.html_url } : {}),
    },
    ...(alert.created_at ? { firstSeenAt: alert.created_at } : {}),
    ...(alert.html_url ? { url: alert.html_url } : {}),
  };
  return finding;
}

/**
 * Every open Dependabot alert the owner's listing returns, up to
 * {@link DEPENDABOT_MAX_PAGES} pages. Any failure part-way through throws:
 * a short list would read as alerts having been fixed.
 */
export async function fetchDependabotFindings(ctx: GitHubContext): Promise<VulnerabilityFinding[]> {
  const path = `${ownerBase(ctx.owner)}/dependabot/alerts`;
  const out: VulnerabilityFinding[] = [];
  let after: string | undefined;
  for (let page = 0; page < DEPENDABOT_MAX_PAGES; page++) {
    let res: { data: GhDependabotAlert[]; headers: Record<string, string> };
    try {
      res = await ghFetchWithHeaders<GhDependabotAlert[]>(ctx, path, {
        state: "open",
        per_page: 100,
        ...(after ? { after } : {}),
      });
    } catch (err) {
      throw accessError(ctx, err) ?? err;
    }
    for (const alert of Array.isArray(res.data) ? res.data : []) {
      const f = mapDependabotAlert(alert);
      if (f) out.push(f);
    }
    // Follow only the cursor out of the `Link` URL, never the URL itself, so
    // the next request goes to the same host and path with the same filters.
    const next = nextLink(res.headers["link"])?.searchParams.get("after");
    if (!next || next === after) break;
    after = next;
  }
  return normalizeVulnerabilityFindings(out);
}

function accessError(ctx: GitHubContext, err: unknown): VulnerabilityAccessError | undefined {
  const status = statusOf(err);
  if (status !== 403 && status !== 404) return undefined;
  const detail =
    err instanceof Error ? err.message.replace(/^GitHub API error \d+ for [^:]+: /, "") : "";
  const who =
    ctx.owner.kind === "org"
      ? `the ${ctx.owner.slug} organization`
      : `the ${ctx.owner.slug} enterprise`;
  if (/disabled/i.test(detail)) {
    return new VulnerabilityAccessError(
      `Dependabot alerts are turned off for ${who}. Turn them on under Settings, Advanced Security (or Code security), then sync again.`,
      {
        label: "Enable Dependabot alerts",
        url: "https://docs.github.com/en/code-security/dependabot/dependabot-alerts/configuring-dependabot-alerts",
      },
    );
  }
  const token =
    ctx.owner.kind === "org"
      ? 'a fine-grained token needs the repository permission "Dependabot alerts" (read) on all repositories, or a classic token the security_events scope'
      : "a classic token needs the repo or security_events scope";
  return new VulnerabilityAccessError(
    `This token cannot read Dependabot alerts for ${who}${detail ? ` (${detail})` : ""}. The user must be an owner or security manager, and ${token}.`,
    HELP,
  );
}
