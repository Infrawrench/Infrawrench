/**
 * GitHub secret scanning: the org's alerts as leaked-secret findings, and
 * closing one after the host rotated the secret.
 *
 * Verified against the REST reference (docs.github.com, "Secret scanning",
 * API version 2026-03-10) and the fine-grained token permission tables
 * (2026-10):
 *
 * - `GET /orgs/{org}/secret-scanning/alerts` lists every repository's alerts.
 *   Callers must be an organization owner or security manager; fine-grained
 *   tokens need the repository permission "Secret scanning alerts" (read),
 *   classic tokens `repo` or `security_events`. There is no enterprise-wide
 *   listing, so an enterprise account returns nothing.
 * - The `secret` field carries the raw value unless `hide_secret=true`. We
 *   want it: the host fingerprints it and drops it, which is the only way to
 *   tell *which* stored token leaked.
 * - Paging is `per_page` (max 100) with `page`; `sort=updated` newest first so
 *   the cap keeps the findings that moved most recently.
 * - `PATCH /repos/{owner}/{repo}/secret-scanning/alerts/{n}` with
 *   `state: resolved` and a `resolution` of `revoked`, `false_positive`,
 *   `wont_fix` or `used_in_tests`. Needs "Secret scanning alerts" (write) and
 *   repository admin; a 400 means the resolution did not change, which we
 *   treat as already resolved. `resolution_comment` cannot be edited later.
 */
import type {
  LeakedSecretFinding,
  LeakedSecretPage,
  LeakedSecretQuery,
  LeakedSecretResolution,
} from "@infrawrench/plugin-base";
import { type GitHubContext, ghFetch, ownerBase, statusOf } from "./api.js";

interface GitHubSecretAlert {
  number: number;
  created_at: string;
  updated_at?: string | null;
  html_url?: string;
  state: "open" | "resolved";
  resolution?: string | null;
  secret_type: string;
  secret_type_display_name?: string;
  secret?: string;
  validity?: "active" | "inactive" | "unknown";
  publicly_leaked?: boolean | null;
  repository?: { full_name?: string };
  first_location_detected?: {
    path?: string;
    start_line?: number;
    commit_sha?: string;
  } | null;
}

/** `owner/repo#12`: the alert number is only unique within a repository. */
export function alertRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function parseAlertRef(ref: string): { repo: string; number: number } {
  const m = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`GitHub plugin: "${ref}" is not a secret scanning alert reference`);
  return { repo: m[1]!, number: Number(m[2]) };
}

export function toFinding(alert: GitHubSecretAlert): LeakedSecretFinding | null {
  const repo = alert.repository?.full_name;
  if (!repo) return null;
  const loc = alert.first_location_detected ?? undefined;
  return {
    ref: alertRef(repo, alert.number),
    tokenType: alert.secret_type,
    ...(alert.secret_type_display_name ? { tokenTypeLabel: alert.secret_type_display_name } : {}),
    ...(alert.secret ? { secret: alert.secret } : {}),
    state: alert.state === "resolved" ? "resolved" : "open",
    ...(alert.resolution ? { resolution: alert.resolution } : {}),
    location: {
      repository: repo,
      ...(loc?.path ? { path: loc.path } : {}),
      ...(typeof loc?.start_line === "number" ? { line: loc.start_line } : {}),
      ...(loc?.commit_sha ? { commitSha: loc.commit_sha } : {}),
    },
    ...(alert.html_url ? { url: alert.html_url } : {}),
    detectedAt: alert.created_at,
    ...(alert.updated_at ? { updatedAt: alert.updated_at } : {}),
    publiclyLeaked: alert.publicly_leaked === true,
    ...(alert.validity ? { validity: alert.validity } : {}),
  };
}

export async function listSecretScanningAlerts(
  ctx: GitHubContext,
  query: LeakedSecretQuery,
): Promise<LeakedSecretPage> {
  if (ctx.owner.kind !== "org") return { findings: [], truncated: false };
  const findings: LeakedSecretFinding[] = [];
  const maxPages = Math.max(1, Math.ceil(query.limit / 100));
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const batch = await ghFetch<GitHubSecretAlert[]>(
      ctx,
      `${ownerBase(ctx.owner)}/secret-scanning/alerts`,
      {
        query: {
          per_page: 100,
          page,
          sort: "updated",
          direction: "desc",
          ...(query.includeResolved ? {} : { state: "open" }),
        },
      },
    );
    for (const alert of batch) {
      const f = toFinding(alert);
      if (f) findings.push(f);
    }
    if (batch.length < 100) break;
    if (page === maxPages) truncated = true;
  }
  return {
    findings: findings.slice(0, query.limit),
    truncated: truncated || findings.length > query.limit,
  };
}

const RESOLUTION: Record<LeakedSecretResolution["reason"], string> = {
  revoked: "revoked",
  "false-positive": "false_positive",
  "wont-fix": "wont_fix",
  "used-in-tests": "used_in_tests",
};

export async function resolveSecretScanningAlert(
  ctx: GitHubContext,
  ref: string,
  resolution: LeakedSecretResolution,
): Promise<void> {
  const { repo, number } = parseAlertRef(ref);
  const [owner, name] = repo.split("/") as [string, string];
  try {
    await ghFetch(
      ctx,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secret-scanning/alerts/${number}`,
      {
        method: "PATCH",
        body: {
          state: "resolved",
          resolution: RESOLUTION[resolution.reason],
          ...(resolution.comment ? { resolution_comment: resolution.comment.slice(0, 280) } : {}),
        },
      },
    );
  } catch (err) {
    // 400: "the resolution did not change", i.e. already resolved that way.
    if (statusOf(err) === 400) return;
    throw err;
  }
}
