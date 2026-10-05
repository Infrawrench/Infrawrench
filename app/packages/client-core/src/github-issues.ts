import type { CloudFetch } from "./fetch";
import { JIRA_SOURCE_KINDS } from "./jira";

/**
 * GitHub issues (and pull requests) for findings, through the org's existing
 * GitHub App installation. Server contract: org-scoped
 * `/api/org/:orgId/github-issues/*` routes (web `api/routes/github-issues.ts`).
 *
 * The third tracker beside Jira and Linear, with two things those do not have:
 *
 * - **Dedupe by fingerprint.** Every issue body carries a hidden marker naming
 *   the finding, so filing the same finding again comments on the open issue
 *   instead of opening a second one, and the scan that notices a finding has
 *   gone away can close (or comment on) the issue it opened.
 * - **Pull requests.** When a finding's resource is managed by Terraform in a
 *   repository the org has mapped, and the fix is mechanical (a size attribute,
 *   or deleting the block of a confirmed orphan), the server can open a PR
 *   editing the HCL. Never merged by us; gated by an org setting and a click.
 *
 * Auth is the GitHub App installation token, minted server-side; nothing here
 * ever sees a credential. This module is the shared contract: web and desktop
 * reach it through `@infrawrench/ui`, mobile and the CLI call it directly.
 */

/**
 * The detectors a GitHub issue can come from: Jira's six plus idle
 * commitments, which only GitHub filing (through alert routing) covers.
 */
export const GITHUB_ISSUE_SOURCE_KINDS = [...JIRA_SOURCE_KINDS, "commitment_idle"] as const;

export type GithubIssueSourceKind = (typeof GITHUB_ISSUE_SOURCE_KINDS)[number];

/** Kinds the savings scan tracks, and so can resolve on its own. */
export const GITHUB_RESOLVABLE_SOURCE_KINDS: readonly GithubIssueSourceKind[] = [
  "orphan",
  "oversized",
];

export function isGithubIssueSourceKind(value: string): value is GithubIssueSourceKind {
  return (GITHUB_ISSUE_SOURCE_KINDS as readonly string[]).includes(value);
}

/** Human label for a source kind, used as the issue title prefix and a label. */
export function githubSourceKindLabel(kind: GithubIssueSourceKind): string {
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
    case "commitment_idle":
      return "Idle commitment";
    case "extended_support":
      return "Extended support";
  }
}

/** A repository reached through one of the org's GitHub App installations. */
export interface GithubRepoRef {
  installationId: number;
  /** `owner/name`. */
  fullName: string;
}

/**
 * What sends a finding to a non-default repository. Matched against the
 * finding's resource: the cost centre its allocation rules place it in, or a
 * tag on the resource. A `tagValue` of null matches any value of the key.
 */
export type GithubIssueRouteMatch =
  | { kind: "cost_centre"; costCentreId: string }
  | { kind: "tag"; tagKey: string; tagValue: string | null };

export interface GithubIssueRoute {
  id: string;
  match: GithubIssueRouteMatch;
  repo: GithubRepoRef;
  /** Added to the org-wide labels for issues this route sends. */
  labels: string[];
  /** Replace the org-wide assignees when non-empty. */
  assignees: string[];
}

/** What happens to an open issue when the scan sees its finding is gone. */
export type GithubResolveAction = "close" | "comment" | "none";

export const GITHUB_RESOLVE_ACTIONS: readonly GithubResolveAction[] = ["close", "comment", "none"];

/**
 * Where the Terraform behind a state document lives, so a pull request can
 * edit it. Keyed by the state's scope the same way IaC reconciliation picks a
 * document for a resource: an account id, or null for an org-wide state.
 */
export interface GithubIacSource {
  id: string;
  /** The IaC state scope: an account id, or null for the org-wide state. */
  iacAccountId: string | null;
  repo: GithubRepoRef;
  /** Null means the repository's default branch. */
  baseBranch: string | null;
  /** Directory holding the root module's `.tf` files; `""` is the repo root. */
  directory: string;
}

export interface GithubIssueSettings {
  /** Master switch for filing (manual and routed). */
  enabled: boolean;
  defaultRepo: GithubRepoRef | null;
  labels: string[];
  assignees: string[];
  routes: GithubIssueRoute[];
  resolveAction: GithubResolveAction;
  /** Allow members with `github-issues:write` to open IaC pull requests. */
  pullRequestsEnabled: boolean;
  iacSources: GithubIacSource[];
  updatedAt: string | null;
}

export type GithubIssueSettingsInput = Omit<
  GithubIssueSettings,
  "updatedAt" | "routes" | "iacSources"
> & {
  routes: Array<Omit<GithubIssueRoute, "id"> & { id?: string }>;
  iacSources: Array<Omit<GithubIacSource, "id"> & { id?: string }>;
};

/** Bounds the server enforces, mirrored by the editor and the Terraform provider. */
export const GITHUB_ISSUE_LIMITS = {
  maxRoutes: 50,
  maxIacSources: 20,
  maxLabels: 20,
  maxAssignees: 10,
  maxLabelLength: 50,
  maxDirectoryLength: 512,
} as const;

/** The GitHub permission levels an installation can hold. */
export type GithubPermissionLevel = "none" | "read" | "write" | "admin";

/** One installation, with what it can do for this feature. */
export interface GithubInstallationAccess {
  installationId: number;
  accountLogin: string | null;
  issues: GithubPermissionLevel;
  pullRequests: GithubPermissionLevel;
  contents: GithubPermissionLevel;
  /** True when GitHub reports the installation suspended. */
  suspended: boolean;
  /** Where an owner approves new permissions; null when unknown. */
  manageUrl: string | null;
  /** False when GitHub could not be asked (the levels are then all "none"). */
  checked: boolean;
}

export interface GithubIssuesStatus {
  /** Whether the server has a GitHub App configured at all. */
  appConfigured: boolean;
  installations: GithubInstallationAccess[];
  settings: GithubIssueSettings;
}

export interface GithubLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface GithubAssignee {
  login: string;
  avatarUrl: string | null;
}

export interface GithubIssueLink {
  id: string;
  sourceKind: GithubIssueSourceKind;
  sourceId: string;
  /** Stable hash of the finding, also written into the issue body. */
  fingerprint: string;
  repo: string;
  installationId: number;
  issueNumber: number;
  issueUrl: string;
  state: "open" | "closed";
  /** True when an alert routing rule filed it rather than a person. */
  autoFiled: boolean;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  createdByUserId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** The repository, labels and assignees a finding would be filed with. */
export interface GithubIssueRouteResolution {
  repo: GithubRepoRef | null;
  labels: string[];
  assignees: string[];
  /** The route that matched; null when the org default applies. */
  routeId: string | null;
}

export interface FileGithubIssueArgs {
  sourceKind: GithubIssueSourceKind;
  sourceId: string;
  title: string;
  /** Ordered label/value evidence rendered as a table in the body. */
  details?: Array<{ label: string; value: string | number | null | undefined }>;
  /** Free text appended after the evidence, e.g. the detector's reason. */
  note?: string;
  /** The Infrawrench resource, for routing and the "managed by Terraform" line. */
  resourceId?: string;
  /** Monthly money at stake, shown in the body. */
  monthlyCost?: { amount: number; currency: string };
  /** Shell commands that fix the finding, rendered as a code block. */
  remediation?: string[];
  /** Override the routed repository. */
  repo?: GithubRepoRef;
  labels?: string[];
  assignees?: string[];
  appUrl?: string;
}

export interface FileGithubIssueResult {
  /** `commented` when an open issue for the finding already existed. */
  action: "created" | "commented";
  link: GithubIssueLink;
}

/** A mechanical change to Terraform a pull request can carry. */
export type GithubIacChange = { kind: "resize"; recommendedSizeId: string } | { kind: "remove" };

export interface GithubPullRequestArgs {
  sourceKind: GithubIssueSourceKind;
  sourceId: string;
  resourceId: string;
  change: GithubIacChange;
}

export type GithubPullRequestPreview =
  | {
      eligible: true;
      repo: GithubRepoRef;
      baseBranch: string;
      path: string;
      terraformAddress: string;
      title: string;
      body: string;
      /** Unified diff of the one file the PR changes. */
      diff: string;
    }
  | { eligible: false; reason: string };

export interface GithubPullRequestResult {
  pullRequest: { number: number; url: string };
  link: GithubIssueLink | null;
}

// --- Requests ---

export async function fetchGithubIssuesStatus(
  api: CloudFetch,
  orgId: string,
): Promise<GithubIssuesStatus | null> {
  return api.org<GithubIssuesStatus>(orgId, "/github-issues");
}

export async function saveGithubIssueSettings(
  api: CloudFetch,
  orgId: string,
  settings: GithubIssueSettingsInput,
): Promise<GithubIssueSettings | null> {
  return api.org<GithubIssueSettings>(orgId, "/github-issues/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

function repoQuery(repo: GithubRepoRef): string {
  return `installationId=${repo.installationId}&repo=${encodeURIComponent(repo.fullName)}`;
}

/** Labels that exist in a repository, for the label picker. */
export async function fetchGithubLabels(
  api: CloudFetch,
  orgId: string,
  repo: GithubRepoRef,
): Promise<GithubLabel[]> {
  return (await api.org<GithubLabel[]>(orgId, `/github-issues/labels?${repoQuery(repo)}`)) ?? [];
}

/** People who can be assigned issues in a repository, for the assignee picker. */
export async function fetchGithubAssignees(
  api: CloudFetch,
  orgId: string,
  repo: GithubRepoRef,
): Promise<GithubAssignee[]> {
  return (
    (await api.org<GithubAssignee[]>(orgId, `/github-issues/assignees?${repoQuery(repo)}`)) ?? []
  );
}

/** Where a finding about this resource would be filed. */
export async function fetchGithubIssueRoute(
  api: CloudFetch,
  orgId: string,
  resourceId?: string,
): Promise<GithubIssueRouteResolution | null> {
  const q = resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : "";
  return api.org<GithubIssueRouteResolution>(orgId, `/github-issues/route${q}`);
}

export async function fileGithubIssue(
  api: CloudFetch,
  orgId: string,
  args: FileGithubIssueArgs,
): Promise<FileGithubIssueResult | null> {
  return api.org<FileGithubIssueResult>(orgId, "/github-issues/issues", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function fetchGithubIssueLinks(
  api: CloudFetch,
  orgId: string,
  filter: {
    sourceKind?: GithubIssueSourceKind;
    sourceIds?: string[];
    state?: "open" | "closed";
  } = {},
): Promise<GithubIssueLink[]> {
  const params = new URLSearchParams();
  if (filter.sourceKind) params.set("sourceKind", filter.sourceKind);
  if (filter.state) params.set("state", filter.state);
  for (const id of filter.sourceIds ?? []) params.append("sourceId", id);
  const query = params.toString();
  return (
    (await api.org<GithubIssueLink[]>(orgId, `/github-issues/links${query ? `?${query}` : ""}`)) ??
    []
  );
}

export async function previewGithubPullRequest(
  api: CloudFetch,
  orgId: string,
  args: GithubPullRequestArgs,
): Promise<GithubPullRequestPreview | null> {
  return api.org<GithubPullRequestPreview>(orgId, "/github-issues/pull-requests/preview", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function openGithubPullRequest(
  api: CloudFetch,
  orgId: string,
  args: GithubPullRequestArgs,
): Promise<GithubPullRequestResult | null> {
  return api.org<GithubPullRequestResult>(orgId, "/github-issues/pull-requests", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

// --- Pure helpers ---

export function githubLinkKey(sourceKind: string, sourceId: string): string {
  return `${sourceKind}:${sourceId}`;
}

/**
 * Index links for per-row lookup. An open link beats a closed one for the same
 * finding (a re-filed finding has both); otherwise the newest wins, and the
 * API returns newest first.
 */
export function indexGithubLinks(links: readonly GithubIssueLink[]): Map<string, GithubIssueLink> {
  const index = new Map<string, GithubIssueLink>();
  for (const link of links) {
    const key = githubLinkKey(link.sourceKind, link.sourceId);
    const existing = index.get(key);
    if (!existing || (existing.state === "closed" && link.state === "open")) index.set(key, link);
  }
  return index;
}

/** What a route matcher knows about a finding's resource. */
export interface GithubRouteFacts {
  costCentreId?: string | null;
  tags?: Record<string, string> | null;
}

/**
 * First matching route wins; no match falls back to the org default. Absent
 * facts never match: a finding with no resource is not "in" any cost centre.
 */
export function resolveGithubIssueRoute(
  settings: Pick<GithubIssueSettings, "defaultRepo" | "labels" | "assignees" | "routes">,
  facts: GithubRouteFacts,
): GithubIssueRouteResolution {
  for (const route of settings.routes) {
    if (routeMatches(route.match, facts)) {
      return {
        repo: route.repo,
        labels: uniqueStrings([...settings.labels, ...route.labels]),
        assignees: route.assignees.length > 0 ? [...route.assignees] : [...settings.assignees],
        routeId: route.id,
      };
    }
  }
  return {
    repo: settings.defaultRepo,
    labels: [...settings.labels],
    assignees: [...settings.assignees],
    routeId: null,
  };
}

function routeMatches(match: GithubIssueRouteMatch, facts: GithubRouteFacts): boolean {
  if (match.kind === "cost_centre") {
    return Boolean(facts.costCentreId) && facts.costCentreId === match.costCentreId;
  }
  const tags = facts.tags;
  if (!tags || !Object.prototype.hasOwnProperty.call(tags, match.tagKey)) return false;
  return match.tagValue === null || tags[match.tagKey] === match.tagValue;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

/** Settings an org that never opened the section reads back. */
export function defaultGithubIssueSettings(): GithubIssueSettings {
  return {
    enabled: false,
    defaultRepo: null,
    labels: ["infrawrench"],
    assignees: [],
    routes: [],
    resolveAction: "comment",
    pullRequestsEnabled: false,
    iacSources: [],
    updatedAt: null,
  };
}

/**
 * Validate a settings document. Returns an error string, or null when it is
 * acceptable. Shared by the server route and the editor.
 */
export function validateGithubIssueSettings(input: GithubIssueSettingsInput): string | null {
  const L = GITHUB_ISSUE_LIMITS;
  if (input.enabled && !input.defaultRepo) return "Choose a default repository before enabling";
  if (input.labels.length > L.maxLabels) return `At most ${L.maxLabels} labels`;
  if (input.assignees.length > L.maxAssignees) return `At most ${L.maxAssignees} assignees`;
  if (input.labels.some((l) => l.length === 0 || l.length > L.maxLabelLength)) {
    return `Labels must be 1 to ${L.maxLabelLength} characters`;
  }
  if (input.routes.length > L.maxRoutes) return `At most ${L.maxRoutes} routes`;
  for (const route of input.routes) {
    if (route.labels.length > L.maxLabels) return `At most ${L.maxLabels} labels per route`;
    if (route.assignees.length > L.maxAssignees) {
      return `At most ${L.maxAssignees} assignees per route`;
    }
    if (route.match.kind === "tag" && !route.match.tagKey.trim()) return "A tag route needs a key";
    if (route.match.kind === "cost_centre" && !route.match.costCentreId) {
      return "A cost centre route needs a cost centre";
    }
  }
  if (input.iacSources.length > L.maxIacSources) {
    return `At most ${L.maxIacSources} Terraform sources`;
  }
  const scopes = new Set<string>();
  for (const source of input.iacSources) {
    const key = source.iacAccountId ?? "";
    if (scopes.has(key)) return "Each IaC state scope can map to one repository";
    scopes.add(key);
    if (source.directory.length > L.maxDirectoryLength) return "Directory path is too long";
    if (source.directory.split("/").some((seg) => seg === "..")) {
      return "Directory paths cannot contain ..";
    }
  }
  return null;
}
