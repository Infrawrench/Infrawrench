import type { CloudFetch } from "./fetch";
import type { JiraSourceKind } from "./jira";
import type {
  IssueStatusFields,
  IssueStatusRefreshResult,
  IssueWebhookSetupResult,
  IssueWebhookState,
} from "./issue-status";

/**
 * Linear issue tracking for findings. Server contract: org-scoped
 * `/api/org/:orgId/linear/*` routes (see web `api/routes/linear.ts`).
 *
 * The second tracker next to Jira (`jira.ts`), covering the same six finding
 * kinds. The source-kind union is shared with Jira on purpose: a finding is
 * the same finding whichever tracker it lands in, and the UI's link index is
 * keyed by (kind, sourceId) for both.
 *
 * Auth is the org's stored Linear personal API key, held server-side; nothing
 * here ever sees it. The integration comes back carrying only a `keyHint`.
 *
 * This module is the shared contract: web and desktop reach it through
 * `@infrawrench/ui`, mobile calls these functions directly.
 */

/** Same six detectors as Jira: one finding vocabulary, two trackers. */
export type LinearSourceKind = JiraSourceKind;

/**
 * The org's Linear connection, as the API returns it. The API key is never
 * present: {@link keyHint} stands in for it. No site URL either: Linear has
 * one fixed API endpoint for every workspace.
 */
export interface LinearIntegration {
  /** Redacted marker for the stored key, e.g. `…a7f2`. */
  keyHint: string;
  /** Team the file-issue window preselects. A team id (UUID), never typed by hand. */
  defaultTeamId: string | null;
  /**
   * When an issue filed for a cost anomaly moves to done, record the anomaly
   * as explained. Optional for a client a release ahead of its server.
   */
  acknowledgeOnDone?: boolean | undefined;
  /** The live-status webhook; absent on servers that predate status sync. */
  webhook?: IssueWebhookState | undefined;
  updatedAt: string;
}

export interface LinearTeam {
  id: string;
  /** Short prefix identifiers are built from, e.g. `ENG` in `ENG-123`. */
  key: string;
  name: string;
}

export interface LinearIssueLink extends IssueStatusFields {
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
  /** Omit to keep the stored value. */
  acknowledgeOnDone?: boolean;
}

export interface CreateLinearIssueArgs {
  sourceKind: LinearSourceKind;
  sourceId: string;
  teamId: string;
  title: string;
  /** Markdown: sent to Linear as-is, unlike Jira's server-side ADF conversion. */
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

/** Teams for the team picker: nobody should have to type a team id. */
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
 * Links for a set of findings, in one request; the same batch shape as
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

/**
 * Set up the live-status webhook. With no secret it is created in Linear
 * through the stored key (`webhookCreate`, which Linear allows workspace
 * admins only). With `signingSecret` it records a webhook the person created
 * in Linear's settings themselves, pasting the signing secret Linear showed.
 */
export async function setupLinearWebhook(
  api: CloudFetch,
  orgId: string,
  args: { mode: "auto" } | { mode: "manual"; signingSecret: string } = { mode: "auto" },
): Promise<IssueWebhookSetupResult | null> {
  return api.org<IssueWebhookSetupResult>(orgId, "/linear/webhook", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/**
 * The receiver URL for a webhook created by hand in Linear's settings. Comes
 * first because Linear shows the signing secret only after the webhook exists.
 */
export async function reserveLinearWebhookUrl(
  api: CloudFetch,
  orgId: string,
): Promise<string | null> {
  const res = await api.org<{ url: string }>(orgId, "/linear/webhook/url", { method: "POST" });
  return res?.url ?? null;
}

/** Remove the live-status webhook (and delete it in Linear when we created it). */
export async function removeLinearWebhook(api: CloudFetch, orgId: string): Promise<void> {
  await api.org(orgId, "/linear/webhook", { method: "DELETE" });
}

/** Ask Linear for the current status of the org's filed issues now. */
export async function refreshLinearIssueStatuses(
  api: CloudFetch,
  orgId: string,
): Promise<IssueStatusRefreshResult | null> {
  return api.org<IssueStatusRefreshResult>(orgId, "/linear/links/refresh", { method: "POST" });
}

// --- Pure helpers ---

/** Key a link by kind + source: the same keying `jiraLinkKey` uses. */
export function linearLinkKey(sourceKind: LinearSourceKind, sourceId: string): string {
  return `${sourceKind}:${sourceId}`;
}

/**
 * Index links for O(1) per-row lookup. Where a finding has been filed more
 * than once, the newest wins: the API returns newest-first, so the first
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
