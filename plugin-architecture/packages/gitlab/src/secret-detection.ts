/**
 * GitLab secret detection: `SECRET_DETECTION` vulnerabilities as leaked-secret
 * findings, and resolving or dismissing one after the host acts on it.
 *
 * Verified against the GraphQL reference and `doc/api/vulnerabilities.md`
 * (gitlab-org/gitlab master, 2026-10):
 *
 * - GraphQL is the supported surface; the REST vulnerability and finding APIs
 *   are documented as being deprecated. `Project.vulnerabilities(reportType:
 *   [SECRET_DETECTION])` is read here through `projects(ids:)`, ten projects a
 *   request, over the same project fan-out every other child type uses.
 * - The vulnerability report is an **Ultimate** feature. On other tiers the
 *   field resolves to null or a field error; such projects are skipped. A
 *   batch or field that failed marks the page truncated, because its findings
 *   were not read, and a scan where every batch failed throws so the host
 *   shows why.
 * - Viewing needs Developer or above and `read_api`; changing state needs
 *   Maintainer (or Security Manager) and the `api` scope.
 * - No field carries the raw secret (it only exists in the job artifact), so
 *   findings never set `secret` and the host matches them by token type.
 *   `tokenType` is the Gitleaks rule id from the `gitleaks_rule_id`
 *   identifier (`gitlab_personal_access_token`, `AWS`), the ids other
 *   plugins list in their `tokenFormats.scannerTypes`.
 * - States: DETECTED and CONFIRMED are open; RESOLVED and DISMISSED are not.
 *   `vulnerabilityResolve` closes a rotated secret; `vulnerabilityDismiss`
 *   takes `FALSE_POSITIVE`, `USED_IN_TESTS` or `ACCEPTABLE_RISK`.
 */
import type {
  LeakedSecretFinding,
  LeakedSecretPage,
  LeakedSecretQuery,
  LeakedSecretResolution,
} from "@infrawrench/plugin-base";
import { type GitLabContext, glGraphql } from "./api.js";

/** Projects per GraphQL request; nested connections count toward query complexity. */
const PROJECT_BATCH = 10;
/** Vulnerabilities read per request. */
const PER_PROJECT = 100;
/** Pages read per project per scan, the first one included. Past this the page says truncated. */
const PROJECT_MAX_PAGES = 50;

interface GlVulnerability {
  id: string;
  title?: string | null;
  state: "DETECTED" | "CONFIRMED" | "RESOLVED" | "DISMISSED";
  detectedAt?: string | null;
  updatedAt?: string | null;
  webUrl?: string | null;
  dismissalReason?: string | null;
  identifiers?: Array<{
    externalType?: string | null;
    externalId?: string | null;
    name?: string | null;
  }>;
  location?: { file?: string | null; startLine?: string | number | null } | null;
}

interface VulnConnection {
  nodes?: GlVulnerability[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

interface ProjectsResponse {
  projects?: {
    nodes?: Array<{ fullPath: string; vulnerabilities?: VulnConnection | null } | null>;
  };
}

interface ProjectResponse {
  project?: { vulnerabilities?: VulnConnection | null } | null;
}

const VULN_FIELDS = `
  nodes {
    id title state detectedAt updatedAt webUrl dismissalReason
    identifiers { externalType externalId name }
    location { ... on VulnerabilityLocationSecretDetection { file startLine } }
  }
  pageInfo { hasNextPage endCursor }`;

const QUERY = `query($ids: [ID!], $first: Int) {
  projects(ids: $ids, first: ${PROJECT_BATCH}) {
    nodes {
      fullPath
      vulnerabilities(reportType: [SECRET_DETECTION], first: $first) {${VULN_FIELDS}
      }
    }
  }
}`;

/** The batch query cannot resume one project, so a project's later pages are read alone. */
const PROJECT_QUERY = `query($fullPath: ID!, $first: Int, $after: String) {
  project(fullPath: $fullPath) {
    vulnerabilities(reportType: [SECRET_DETECTION], first: $first, after: $after) {${VULN_FIELDS}
    }
  }
}`;

/** The Gitleaks rule id, else the identifier's name, else the title. */
export function vulnerabilityTokenType(v: GlVulnerability): string {
  const ids = v.identifiers ?? [];
  const rule = ids.find((i) => i.externalType === "gitleaks_rule_id" && i.externalId);
  if (rule?.externalId) return rule.externalId;
  return ids[0]?.externalId || ids[0]?.name || v.title || "secret";
}

export function toFinding(projectPath: string, v: GlVulnerability): LeakedSecretFinding {
  const open = v.state === "DETECTED" || v.state === "CONFIRMED";
  const line = v.location?.startLine != null ? Number(v.location.startLine) : NaN;
  return {
    ref: v.id,
    tokenType: vulnerabilityTokenType(v),
    ...(v.title ? { tokenTypeLabel: v.title } : {}),
    state: open ? "open" : "resolved",
    ...(open
      ? {}
      : {
          resolution:
            v.state === "DISMISSED" ? (v.dismissalReason ?? "dismissed").toLowerCase() : "resolved",
        }),
    location: {
      repository: projectPath,
      ...(v.location?.file ? { path: v.location.file } : {}),
      ...(Number.isFinite(line) ? { line } : {}),
    },
    ...(v.webUrl ? { url: v.webUrl } : {}),
    detectedAt: v.detectedAt ?? v.updatedAt ?? new Date(0).toISOString(),
    ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}),
  };
}

export async function listSecretDetectionFindings(
  ctx: GitLabContext,
  projects: ReadonlyArray<{ id: number; path_with_namespace: string }>,
  query: LeakedSecretQuery,
): Promise<LeakedSecretPage> {
  const findings: LeakedSecretFinding[] = [];
  let truncated = false;
  let failures = 0;
  let batches = 0;
  let lastError = "";
  const collect = (fullPath: string, connection: VulnConnection) => {
    for (const v of connection.nodes ?? []) {
      const f = toFinding(fullPath, v);
      if (!query.includeResolved && f.state !== "open") continue;
      findings.push(f);
    }
  };
  /** Reads a project's pages after the batch's first one. False when some went unread. */
  const readLaterPages = async (fullPath: string, first: VulnConnection): Promise<boolean> => {
    let pageInfo = first.pageInfo;
    for (let page = 1; pageInfo?.hasNextPage; page++) {
      if (page >= PROJECT_MAX_PAGES || findings.length >= query.limit || !pageInfo.endCursor) {
        return false;
      }
      const res = await glGraphql<ProjectResponse>(ctx, PROJECT_QUERY, {
        fullPath,
        first: PER_PROJECT,
        after: pageInfo.endCursor,
      });
      const next = res.data?.project?.vulnerabilities;
      if (!next?.nodes) return false;
      collect(fullPath, next);
      pageInfo = next.pageInfo;
    }
    return true;
  };
  for (let i = 0; i < projects.length; i += PROJECT_BATCH) {
    if (findings.length >= query.limit) {
      truncated = true;
      break;
    }
    batches += 1;
    const ids = projects.slice(i, i + PROJECT_BATCH).map((p) => `gid://gitlab/Project/${p.id}`);
    try {
      const res = await glGraphql<ProjectsResponse>(ctx, QUERY, { ids, first: PER_PROJECT });
      const nodes = res.data?.projects?.nodes;
      if (!nodes) {
        failures += 1;
        truncated = true;
        lastError = res.errors?.[0]?.message ?? "no data";
        continue;
      }
      // Errors beside data null a field, so some project's findings went unread.
      if (res.errors?.length) truncated = true;
      for (const project of nodes) {
        if (!project?.vulnerabilities?.nodes) continue;
        collect(project.fullPath, project.vulnerabilities);
        const whole = await readLaterPages(project.fullPath, project.vulnerabilities).catch(
          () => false,
        );
        if (!whole) truncated = true;
      }
    } catch (err) {
      failures += 1;
      truncated = true;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (batches > 0 && failures === batches) {
    throw new Error(`GitLab plugin: secret detection findings could not be read (${lastError})`);
  }
  return {
    findings: findings.slice(0, query.limit),
    truncated: truncated || findings.length > query.limit,
  };
}

const DISMISSAL: Record<Exclude<LeakedSecretResolution["reason"], "revoked">, string> = {
  "false-positive": "FALSE_POSITIVE",
  "used-in-tests": "USED_IN_TESTS",
  "wont-fix": "ACCEPTABLE_RISK",
};

export async function resolveSecretDetectionFinding(
  ctx: GitLabContext,
  ref: string,
  resolution: LeakedSecretResolution,
): Promise<void> {
  const comment = resolution.comment?.slice(0, 50_000);
  const mutation =
    resolution.reason === "revoked"
      ? {
          name: "vulnerabilityResolve",
          query: `mutation($id: VulnerabilityID!, $comment: String) { vulnerabilityResolve(input: { id: $id, comment: $comment }) { errors } }`,
          variables: { id: ref, comment },
        }
      : {
          name: "vulnerabilityDismiss",
          query: `mutation($id: VulnerabilityID!, $comment: String, $reason: VulnerabilityDismissalReason) { vulnerabilityDismiss(input: { id: $id, comment: $comment, dismissalReason: $reason }) { errors } }`,
          variables: { id: ref, comment, reason: DISMISSAL[resolution.reason] },
        };
  const res = await glGraphql<Record<string, { errors?: string[] } | null>>(
    ctx,
    mutation.query,
    mutation.variables,
  );
  const messages = [
    ...(res.errors ?? []).map((e) => e.message ?? ""),
    ...(res.data?.[mutation.name]?.errors ?? []),
  ].filter(Boolean);
  // Resolving what is already in that state is success, not a failure.
  if (messages.length > 0 && !messages.every((m) => /already/i.test(m))) {
    throw new Error(`GitLab plugin: ${mutation.name} failed: ${messages.join("; ")}`);
  }
}
