import type { CloudFetch } from "./fetch";
import type { JiraSourceKind } from "./jira";

/**
 * Linear issue tracking for findings. Server contract: org-scoped
 * `/api/org/:orgId/linear/*` routes (see web `api/routes/linear.ts`).
 *
 * The second tracker next to Jira (`jira.ts`), covering the same six finding
 * kinds. The source-kind union is shared with Jira on purpose — a finding is
 * the same finding whichever tracker it lands in, and the UI's link index is
 * keyed by (kind, sourceId) for both.
 *
 * Auth is the org's stored Linear personal API key, held server-side; nothing
 * here ever sees it. The integration comes back carrying only a `keyHint`.
 *
 * This module is the shared contract: web and desktop reach it through
 * `@infrawrench/ui`, mobile calls these functions directly.
 */

/** Same six detectors as Jira — one finding vocabulary, two trackers. */
export type LinearSourceKind = JiraSourceKind;

/**
 * The org's Linear connection, as the API returns it. The API key is never
 * present — {@link keyHint} stands in for it. No site URL either: Linear has
 * one fixed API endpoint for every workspace.
 */
export interface LinearIntegration {
  /** Redacted marker for the stored key, e.g. `…a7f2`. */
  keyHint: string;
  /** Team the file-issue window preselects. A team id (UUID), never typed by hand. */
  defaultTeamId: string | null;
  updatedAt: string;
}

export interface LinearTeam {
  id: string;
  /** Short prefix identifiers are built from, e.g. `ENG` in `ENG-123`. */
  key: string;
  name: string;
}

export interface LinearIssueLink {
  id: string;
  sourceKind: LinearSourceKind;
  sourceId: string;
  /** e.g. `ENG-123`. */
  issueIdentifier: string;
  issueUrl: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface LinearVerifyResult {
  ok: boolean;
  id: string;
  name: string;
  email: string | null;
}

export interface SaveLinearIntegrationArgs {
  /**
   * Omit to keep the stored key. The form only ever shows the redacted hint,
   * so a blank field means "unchanged", not "clear it".
   */
  apiKey?: string;
  defaultTeamId?: string | null;
}

export interface CreateLinearIssueArgs {
  sourceKind: LinearSourceKind;
  sourceId: string;
  teamId: string;
  title: string;
  /** Markdown — sent to Linear as-is, unlike Jira's server-side ADF conversion. */
  description?: string;
  labelIds?: string[];
  projectId?: string;
}

export interface CreateLinearIssueResult {
  issue: { id: string; identifier: string; url: string };
  link: LinearIssueLink;
}

// --- Requests ---

/** The org's integration, or null when Linear has not been connected. */
export async function fetchLinearIntegration(
  api: CloudFetch,
  orgId: string,
): Promise<LinearIntegration | null> {
  const res = await api.org<{ integration: LinearIntegration | null }>(orgId, "/linear");
  return res?.integration ?? null;
}

export async function saveLinearIntegration(
  api: CloudFetch,
  orgId: string,
  args: SaveLinearIntegrationArgs,
): Promise<LinearIntegration | null> {
  return api.org<LinearIntegration>(orgId, "/linear", {
    method: "PUT",
    body: JSON.stringify(args),
  });
}

export async function deleteLinearIntegration(api: CloudFetch, orgId: string): Promise<void> {
  await api.org(orgId, "/linear", { method: "DELETE" });
}

/**
 * Check a key against Linear. Pass the key to test one before saving; omit it
 * to test the stored one.
 */
export async function verifyLinearCredentials(
  api: CloudFetch,
  orgId: string,
  args: Pick<SaveLinearIntegrationArgs, "apiKey"> = {},
): Promise<LinearVerifyResult | null> {
  return api.org<LinearVerifyResult>(orgId, "/linear/verify", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/** Teams for the team picker — nobody should have to type a team id. */
export async function fetchLinearTeams(api: CloudFetch, orgId: string): Promise<LinearTeam[]> {
  return (await api.org<LinearTeam[]>(orgId, "/linear/teams")) ?? [];
}

export async function createLinearIssue(
  api: CloudFetch,
  orgId: string,
  args: CreateLinearIssueArgs,
): Promise<CreateLinearIssueResult | null> {
  return api.org<CreateLinearIssueResult>(orgId, "/linear/issues", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/**
 * Links for a set of findings, in one request — the same batch shape as
 * `fetchJiraIssueLinks`, for the same reason: one request per page, not one
 * per row.
 */
export async function fetchLinearIssueLinks(
  api: CloudFetch,
  orgId: string,
  filter: { sourceKind?: LinearSourceKind; sourceIds?: string[] } = {},
): Promise<LinearIssueLink[]> {
  const params = new URLSearchParams();
  if (filter.sourceKind) params.set("sourceKind", filter.sourceKind);
  for (const id of filter.sourceIds ?? []) params.append("sourceId", id);
  const query = params.toString();
  return (
    (await api.org<LinearIssueLink[]>(orgId, `/linear/links${query ? `?${query}` : ""}`)) ?? []
  );
}

// --- Pure helpers ---

/** Key a link by kind + source — the same keying `jiraLinkKey` uses. */
export function linearLinkKey(sourceKind: LinearSourceKind, sourceId: string): string {
  return `${sourceKind}:${sourceId}`;
}

/**
 * Index links for O(1) per-row lookup. Where a finding has been filed more
 * than once, the newest wins — the API returns newest-first, so the first
 * entry for a key is kept and later ones ignored.
 */
export function indexLinearLinks(links: readonly LinearIssueLink[]): Map<string, LinearIssueLink> {
  const index = new Map<string, LinearIssueLink>();
  for (const link of links) {
    const key = linearLinkKey(link.sourceKind, link.sourceId);
    if (!index.has(key)) index.set(key, link);
  }
  return index;
}
