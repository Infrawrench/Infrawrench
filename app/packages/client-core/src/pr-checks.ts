import type { BlastRadiusSeverity } from "./blast-radius";
import { formatMonthlyDelta } from "./cost-estimate";
import type { GithubPermissionLevel } from "./github-issues";

/**
 * Pre-merge checks on infrastructure pull requests. Server contract:
 * org-scoped `/api/org/:orgId/pr-checks/*` routes (web
 * `api/routes/pr-checks.ts`); the work itself runs in the github-watcher,
 * which polls the open pull requests of every enabled repository through the
 * org's existing GitHub App installation and posts one **check run** per head
 * commit (plus, optionally, one sticky comment it edits in place).
 *
 * What a check says, for every Terraform resource block the pull request
 * adds, edits or removes:
 *
 * - the **monthly cost delta**, from the plugins' own `estimateCost` (the
 *   create form's numbers), never a second price table;
 * - the **blast radius** of every existing resource it touches, from the
 *   same dependency graph and impact report the delete dialog shows;
 * - cheap **warnings** that already have callable logic: an oversized
 *   recommendation the edit ignores, a tag policy the new block violates, a
 *   posture rule the edit starts matching.
 *
 * `null` is never `0` anywhere in this contract: an unpriced change has a
 * `null` delta and an `unpricedReason`, and a total built over some unpriced
 * changes is `partial`. This module is the shared contract: web and desktop
 * reach it through `@infrawrench/ui`, the CLI imports its types directly.
 */

/** The check run's name, as it appears in the pull request's checks list. */
export const PR_CHECK_NAME = "Infrawrench: cost and blast radius";

/** Hidden marker in the sticky comment, so a lost comment id is recoverable. */
export const PR_CHECK_COMMENT_MARKER = "<!-- infrawrench-pr-check -->";

export const PR_CHECK_THRESHOLD_CONCLUSIONS = ["neutral", "failure"] as const;
export type PrCheckThresholdConclusion = (typeof PR_CHECK_THRESHOLD_CONCLUSIONS)[number];

export type PrCheckConclusion = "success" | "neutral" | "failure";

export const PR_CHECK_LIMITS = {
  /** Repositories one org may enable checks on. */
  maxRepositories: 100,
  /** Directory filters per repository. */
  maxDirectories: 20,
  maxDirectoryLength: 255,
  /** Largest monthly threshold accepted, in the estimate's currency. */
  maxCostThreshold: 10_000_000,
  /** Files a preview (or one pull request) is analysed over. */
  maxFiles: 50,
  /** Bytes per side of one file a preview accepts. */
  maxFileBytes: 512 * 1024,
} as const;

/** One repository with checks configured. */
export interface PrCheckRepository {
  id: string;
  installationId: number;
  /** `owner/name`. */
  repo: string;
  enabled: boolean;
  /** Also keep one summary comment on the pull request, edited in place. */
  commentEnabled: boolean;
  /**
   * A monthly cost increase above this (in the estimate's currency, USD for
   * every provider that prices today) turns the check `thresholdConclusion`.
   * Null never does.
   */
  costThreshold: number | null;
  thresholdConclusion: PrCheckThresholdConclusion;
  /**
   * Path prefixes the check looks in, without leading or trailing slashes.
   * Empty means the whole repository.
   */
  directories: string[];
  createdAt: string;
  updatedAt: string;
}

export type PrCheckRepositoryInput = Omit<PrCheckRepository, "id" | "createdAt" | "updatedAt">;

/** What an installation has accepted, for the permissions this needs. */
export interface PrCheckInstallationAccess {
  installationId: number;
  accountLogin: string | null;
  checks: GithubPermissionLevel;
  pullRequests: GithubPermissionLevel;
  contents: GithubPermissionLevel;
  suspended: boolean;
  manageUrl: string | null;
  checked: boolean;
}

export interface PrCheckStatus {
  appConfigured: boolean;
  installations: PrCheckInstallationAccess[];
  repositories: PrCheckRepository[];
}

export type PrCheckFileKind = "terraform" | "infrafile" | "kubernetes";

export interface PrCheckFile {
  path: string;
  kind: PrCheckFileKind;
  status: "added" | "modified" | "removed" | "renamed";
  /** False when the file was recognised but not analysed; `note` says why. */
  analysed: boolean;
  note: string | null;
}

export type PrCheckChangeAction = "create" | "update" | "delete";

export interface PrCheckEstimateSide {
  monthlyAmount: number;
  currency: string;
  partial: boolean;
}

export interface PrCheckWarning {
  kind: "rightsizing" | "tag-policy" | "posture" | "parse";
  severity: "notice" | "warning";
  message: string;
}

export interface PrCheckBlastRadius {
  directDependants: number;
  transitiveDependants: number;
  /** Dashboards, probes, status pages, workflows… naming the resource. */
  references: number;
  severity: BlastRadiusSeverity;
  headline: string;
  /** Up to five direct dependants, by display name. */
  topDependants: string[];
  /** How many gatherers could not answer. */
  unchecked: number;
}

export interface PrCheckChange {
  /** `type.name`, as the block declares it. */
  address: string;
  terraformType: string;
  action: PrCheckChangeAction;
  path: string;
  /** 1-based line of the block header on the side that has it. */
  line: number | null;
  /** The synced resource the block manages, matched through uploaded state. */
  resourceId: string | null;
  displayName: string | null;
  pluginId: string | null;
  resourceTypeId: string | null;
  /** Top-level attributes whose literal value differs (updates only). */
  changedAttributes: string[];
  /**
   * The block's `count` when it is a literal; null when it uses `for_each`
   * or an expression (the multiplicity is then unknown and the line partial).
   */
  count: number | null;
  before: PrCheckEstimateSide | null;
  after: PrCheckEstimateSide | null;
  /** After minus before, multiplied by `count`. Null when either side is unknown. */
  monthlyDelta: number | null;
  currency: string | null;
  unpricedReason: string | null;
  blastRadius: PrCheckBlastRadius | null;
  warnings: PrCheckWarning[];
}

export interface PrCheckTotals {
  /** Sum of the priced deltas in `currency`. Null when nothing priced. */
  monthlyDelta: number | null;
  currency: string | null;
  /** True when some change could not be priced, or priced only in part. */
  partial: boolean;
  pricedChanges: number;
  unpricedChanges: number;
  /** Changes priced in another currency, left out of the sum. */
  otherCurrencyChanges: number;
}

export interface PrCheckReport {
  generatedAt: string;
  files: PrCheckFile[];
  changes: PrCheckChange[];
  totals: PrCheckTotals;
  blast: {
    /** Existing resources the pull request updates or deletes. */
    touchedResources: number;
    /** Sum of direct and transitive dependants over those resources. */
    dependants: number;
    highestSeverity: BlastRadiusSeverity | null;
  };
  /** Whole-report caveats, one sentence each. */
  notes: string[];
  /** True when a cap stopped the analysis before every file or block. */
  truncated: boolean;
}

export interface PrCheckRun {
  id: string;
  repositoryId: string;
  repo: string;
  pullNumber: number;
  pullTitle: string | null;
  pullUrl: string | null;
  headSha: string;
  status: "running" | "completed" | "failed";
  conclusion: PrCheckConclusion | null;
  checkRunUrl: string | null;
  commentUrl: string | null;
  report: PrCheckReport | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A local file pair for a preview: null on one side means added/removed. */
export interface PrCheckPreviewFile {
  path: string;
  before: string | null;
  after: string | null;
}

export type PrCheckPreviewInput =
  | { repositoryId: string; pullNumber: number }
  | { files: PrCheckPreviewFile[]; repo?: string | undefined };

export interface PrCheckPreview {
  report: PrCheckReport;
  conclusion: PrCheckConclusion;
  title: string;
  /** The check run summary, as GitHub would render it. */
  markdown: string;
}

// --- Pure helpers shared by the server, the UI and the CLI ---

/** Normalise one directory filter: trimmed, no leading/trailing slashes. */
export function normalizePrCheckDirectory(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

/** Whether `path` sits inside one of `directories` (empty = everywhere). */
export function pathInPrCheckDirectories(path: string, directories: readonly string[]): boolean {
  if (directories.length === 0) return true;
  return directories.some((dir) => {
    const d = normalizePrCheckDirectory(dir);
    return d === "" || path === d || path.startsWith(`${d}/`);
  });
}

/**
 * What kind of infrastructure file a path is, judged by name (and, for YAML,
 * by content when it is at hand). Null for everything else.
 *
 * Kubernetes manifests are YAML documents with both `apiVersion:` and `kind:`
 * at the top level; without the content a `.yaml` path is not enough to say,
 * so callers that only have the path pass no content and get null for YAML.
 */
export function classifyPrCheckPath(path: string, content?: string | null): PrCheckFileKind | null {
  const base = path.split("/").pop() ?? path;
  if (base.endsWith(".tf")) return "terraform";
  if (base === "Infrafile") return "infrafile";
  if (/\.ya?ml$/i.test(base) && content) {
    return /^apiVersion:/m.test(content) && /^kind:/m.test(content) ? "kubernetes" : null;
  }
  return null;
}

/**
 * The check's conclusion: the configured one when the priced monthly
 * increase exceeds the threshold, success otherwise. A partial total is
 * still compared (it is a floor, so exceeding it means exceeding the real
 * one); an unknown total never trips the threshold, because "we could not
 * price it" must not read as "it is too expensive".
 */
export function prCheckConclusion(
  report: Pick<PrCheckReport, "totals">,
  settings: Pick<PrCheckRepository, "costThreshold" | "thresholdConclusion">,
): PrCheckConclusion {
  const delta = report.totals.monthlyDelta;
  if (settings.costThreshold !== null && delta !== null && delta > settings.costThreshold) {
    return settings.thresholdConclusion;
  }
  return "success";
}

/** The check run title: one line, under GitHub's limits. */
export function prCheckTitle(report: PrCheckReport): string {
  if (report.files.length === 0) return "No infrastructure changes";
  const parts: string[] = [];
  const { monthlyDelta, currency, partial } = report.totals;
  if (monthlyDelta !== null && currency) {
    const delta = formatMonthlyDelta(monthlyDelta, currency);
    parts.push(`${partial && monthlyDelta > 0 ? "at least " : ""}${delta}/month`);
  } else if (report.changes.length > 0) {
    parts.push("cost not priced");
  }
  if (report.blast.touchedResources > 0) {
    parts.push(
      `${report.blast.touchedResources} existing resource${report.blast.touchedResources === 1 ? "" : "s"} touched`,
    );
  }
  if (report.changes.length === 0) parts.push("no resource blocks changed");
  return parts.join(", ").slice(0, 200);
}

/** Validate a repository input; returns a message or null. */
export function validatePrCheckRepositoryInput(input: PrCheckRepositoryInput): string | null {
  if (!Number.isInteger(input.installationId) || input.installationId <= 0) {
    return "Pick a repository.";
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) return "Pick a repository.";
  if (input.costThreshold !== null) {
    if (!Number.isFinite(input.costThreshold) || input.costThreshold < 0) {
      return "The cost threshold must be zero or more.";
    }
    if (input.costThreshold > PR_CHECK_LIMITS.maxCostThreshold) {
      return "The cost threshold is too large.";
    }
  }
  if (input.directories.length > PR_CHECK_LIMITS.maxDirectories) {
    return `At most ${PR_CHECK_LIMITS.maxDirectories} directories.`;
  }
  for (const dir of input.directories) {
    if (normalizePrCheckDirectory(dir).length > PR_CHECK_LIMITS.maxDirectoryLength) {
      return "A directory is too long.";
    }
    if (dir.split("/").some((part) => part === "..")) return "Directories cannot contain '..'.";
  }
  return null;
}

/**
 * GitHub permissions an installation still has to approve before checks can
 * be posted: `checks: write` always, `pull_requests` read to list pull
 * requests (write when the sticky comment is on), `contents: read` to read
 * the files on both sides of the diff.
 */
export function prCheckMissingPermissions(
  access: PrCheckInstallationAccess | undefined,
  commentEnabled: boolean,
): string[] {
  if (!access || !access.checked) return [];
  const writable = (level: GithubPermissionLevel) => level === "write" || level === "admin";
  const readable = (level: GithubPermissionLevel) => level !== "none";
  const missing: string[] = [];
  if (!writable(access.checks)) missing.push("checks");
  if (commentEnabled ? !writable(access.pullRequests) : !readable(access.pullRequests)) {
    missing.push("pull_requests");
  }
  if (!readable(access.contents)) missing.push("contents");
  return missing;
}
