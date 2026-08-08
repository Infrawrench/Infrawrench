import type { CloudFetch } from "./fetch";

/**
 * Jira issue tracking for findings. Server contract: org-scoped
 * `/api/org/:orgId/jira/*` routes (see web `api/routes/jira.ts`).
 *
 * Infrawrench detects things a human has to act on — cost anomalies, orphaned
 * and oversized resources, posture findings, expiring credentials, failed
 * probes. Any of them can be filed as a Jira issue, and the resulting link is
 * kept so a list can show "already filed as OPS-412" rather than offering the
 * button again.
 *
 * Auth is the org's stored Jira API token, held server-side; nothing here ever
 * sees it. The integration comes back carrying only a `tokenHint`.
 *
 * This module is the shared contract: web and desktop reach it through
 * `@infrawrench/ui`, mobile calls these functions directly. Anything both
 * surfaces need — the source-kind union, the link index, the draft builder —
 * belongs here rather than in either UI package.
 */

/**
 * The detectors a filed issue can come from. Mirrored by the CHECK constraint
 * on `jira_issue_links.source_kind` and by the server's zod enum.
 */
export const JIRA_SOURCE_KINDS = [
  "cost_anomaly",
  "orphan",
  "oversized",
  "posture_finding",
  "expiring",
  "probe",
] as const;

export type JiraSourceKind = (typeof JIRA_SOURCE_KINDS)[number];

/** Human label for a source kind, for modal titles and issue labels. */
export function jiraSourceKindLabel(kind: JiraSourceKind): string {
  switch (kind) {
    case "cost_anomaly":
      return "Cost anomaly";
    case "orphan":
      return "Orphaned resource";
    case "oversized":
      return "Oversized resource";
    case "posture_finding":
      return "Posture finding";
    case "expiring":
      return "Expiring credential";
    case "probe":
      return "Failed probe";
  }
}

/**
 * The org's Jira connection, as the API returns it. The API token is never
 * present — {@link tokenHint} stands in for it.
 */
export interface JiraIntegration {
  /** Normalized site origin, e.g. `https://acme.atlassian.net`. */
  siteUrl: string;
  accountEmail: string;
  /** Redacted marker for the stored token, e.g. `…a7f2`. */
  tokenHint: string;
  /** Project the file-issue modal preselects. */
  defaultProjectKey: string | null;
  /** Issue type the modal preselects within the default project. */
  defaultIssueTypeId: string | null;
  updatedAt: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
  description: string | null;
}

export interface JiraIssueLink {
  id: string;
  sourceKind: JiraSourceKind;
  sourceId: string;
  /** e.g. `OPS-412`. */
  issueKey: string;
  /** e.g. `https://acme.atlassian.net/browse/OPS-412`. */
  issueUrl: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface JiraVerifyResult {
  ok: boolean;
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}

export interface SaveJiraIntegrationArgs {
  siteUrl: string;
  accountEmail: string;
  /**
   * Omit to keep the stored token. The form only ever shows the redacted hint,
   * so a blank field means "unchanged", not "clear it".
   */
  apiToken?: string;
  defaultProjectKey?: string | null;
  defaultIssueTypeId?: string | null;
}

export interface CreateJiraIssueArgs {
  sourceKind: JiraSourceKind;
  sourceId: string;
  projectKey: string;
  issueTypeId: string;
  summary: string;
  description?: string;
  labels?: string[];
}

export interface CreateJiraIssueResult {
  issue: { id: string; key: string; url: string };
  link: JiraIssueLink;
}

// --- Requests ---

/** The org's integration, or null when Jira has not been connected. */
export async function fetchJiraIntegration(
  api: CloudFetch,
  orgId: string,
): Promise<JiraIntegration | null> {
  const res = await api.org<{ integration: JiraIntegration | null }>(orgId, "/jira");
  return res?.integration ?? null;
}

export async function saveJiraIntegration(
  api: CloudFetch,
  orgId: string,
  args: SaveJiraIntegrationArgs,
): Promise<JiraIntegration | null> {
  return api.org<JiraIntegration>(orgId, "/jira", {
    method: "PUT",
    body: JSON.stringify(args),
  });
}

export async function deleteJiraIntegration(api: CloudFetch, orgId: string): Promise<void> {
  await api.org(orgId, "/jira", { method: "DELETE" });
}

/**
 * Check credentials against Jira. Pass the token to test one before saving;
 * omit it to test the stored one.
 */
export async function verifyJiraCredentials(
  api: CloudFetch,
  orgId: string,
  args: Partial<Pick<SaveJiraIntegrationArgs, "siteUrl" | "accountEmail" | "apiToken">> = {},
): Promise<JiraVerifyResult | null> {
  return api.org<JiraVerifyResult>(orgId, "/jira/verify", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/** Projects for the project picker — nobody should have to type a project key. */
export async function fetchJiraProjects(api: CloudFetch, orgId: string): Promise<JiraProject[]> {
  return (await api.org<JiraProject[]>(orgId, "/jira/projects")) ?? [];
}

/** Issue types valid in one project, for the type picker. */
export async function fetchJiraIssueTypes(
  api: CloudFetch,
  orgId: string,
  projectKey: string,
): Promise<JiraIssueType[]> {
  return (
    (await api.org<JiraIssueType[]>(
      orgId,
      `/jira/projects/${encodeURIComponent(projectKey)}/issue-types`,
    )) ?? []
  );
}

export async function createJiraIssue(
  api: CloudFetch,
  orgId: string,
  args: CreateJiraIssueArgs,
): Promise<CreateJiraIssueResult | null> {
  return api.org<CreateJiraIssueResult>(orgId, "/jira/issues", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/**
 * Links for a set of findings, in one request.
 *
 * A list view calls this once before rendering rather than once per row — with
 * a hundred anomalies on screen the per-row shape would be a hundred requests
 * to render six badges.
 */
export async function fetchJiraIssueLinks(
  api: CloudFetch,
  orgId: string,
  filter: { sourceKind?: JiraSourceKind; sourceIds?: string[] } = {},
): Promise<JiraIssueLink[]> {
  const params = new URLSearchParams();
  if (filter.sourceKind) params.set("sourceKind", filter.sourceKind);
  for (const id of filter.sourceIds ?? []) params.append("sourceId", id);
  const query = params.toString();
  return (await api.org<JiraIssueLink[]>(orgId, `/jira/links${query ? `?${query}` : ""}`)) ?? [];
}

// --- Pure helpers ---

/** Key a link by kind + source, which is how a row looks itself up. */
export function jiraLinkKey(sourceKind: JiraSourceKind, sourceId: string): string {
  return `${sourceKind}:${sourceId}`;
}

/**
 * Index links for O(1) per-row lookup. Where a finding has been filed more than
 * once, the newest wins — the API returns newest-first, so the first entry for a
 * key is kept and later ones ignored.
 */
export function indexJiraLinks(links: readonly JiraIssueLink[]): Map<string, JiraIssueLink> {
  const index = new Map<string, JiraIssueLink>();
  for (const link of links) {
    const key = jiraLinkKey(link.sourceKind, link.sourceId);
    if (!index.has(key)) index.set(key, link);
  }
  return index;
}

export interface JiraIssueDraft {
  summary: string;
  description: string;
  labels: string[];
}

export interface BuildJiraIssueDraftArgs {
  sourceKind: JiraSourceKind;
  /** One-line headline, e.g. `EC2 spend up 240% on 2026-08-06`. */
  title: string;
  /** Ordered label/value context lines rendered under the headline. */
  details?: Array<{ label: string; value: string | number | null | undefined }>;
  /** Free-text paragraph appended after the details, e.g. a recommendation. */
  note?: string;
  /** Deep link back into Infrawrench, appended last. */
  appUrl?: string;
}

/**
 * Build the summary/description/labels a file-issue modal opens prefilled with.
 *
 * Shared rather than duplicated per surface: web, desktop, and mobile must file
 * issues that read identically, and the description is plain text here — the
 * server converts it to Atlassian Document Format, because ADF is a JSON
 * document shape no client should be assembling by hand.
 */
export function buildJiraIssueDraft(args: BuildJiraIssueDraftArgs): JiraIssueDraft {
  const lines: string[] = [];
  for (const detail of args.details ?? []) {
    if (detail.value === null || detail.value === undefined || detail.value === "") continue;
    lines.push(`${detail.label}: ${detail.value}`);
  }

  const blocks: string[] = [];
  if (lines.length > 0) blocks.push(lines.join("\n"));
  if (args.note) blocks.push(args.note);
  if (args.appUrl) blocks.push(`View in Infrawrench: ${args.appUrl}`);
  blocks.push("Filed from Infrawrench.");

  return {
    summary: `${jiraSourceKindLabel(args.sourceKind)}: ${args.title}`,
    description: blocks.join("\n\n"),
    // Jira rejects labels containing whitespace; the server sanitizes too, but
    // emitting valid labels here keeps the modal's preview honest.
    labels: ["infrawrench", args.sourceKind.replace(/_/g, "-")],
  };
}
