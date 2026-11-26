/**
 * Status glyphs every page shares: a commit status, a CI run or job, an issue
 * or pull request's state. Each is an image with a name, so a row that shows
 * only the icon still reads to a screen reader.
 */
import type { CiRunStatus, StatusState } from "@infrawrench/git-contract";
import { Icon, type IconName } from "./icons";
import { useSidebarShell } from "../lib/shell";

export type CiGlyphStatus =
  CiRunStatus | "passed" | "failed" | "skipped" | "error" | "cancelled" | "running" | "waiting";

const CI_LABEL: Record<CiGlyphStatus, string> = {
  awaiting_approval: "Awaiting approval",
  queued: "Queued",
  pending: "Waiting",
  waiting: "Waiting",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  error: "Errored",
  rejected: "Rejected",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export const ciStatusLabel = (status: CiGlyphStatus): string => CI_LABEL[status];

/**
 * A CI run's or job's status on the app's 24x24 grid, the glyphs the app's CI
 * tab uses: a tick, a cross, a bang, a slashed ring for skipped, a square for
 * cancelled, a turning arc for running, an empty ring for waiting.
 */
export function CiStatusIcon({
  status,
  size = 14,
  className = "",
}: {
  status: CiGlyphStatus;
  size?: number;
  className?: string;
}) {
  const tone =
    status === "passed"
      ? "text-success"
      : status === "failed" || status === "error" || status === "rejected"
        ? "text-danger"
        : status === "running" || status === "awaiting_approval"
          ? "text-warning"
          : "text-on-surface-faint";
  const label = CI_LABEL[status];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
      className={`shrink-0 ${tone} ${status === "running" ? "animate-spin" : ""} ${className}`}
    >
      <title>{label}</title>
      {status === "running" ? (
        <>
          <circle cx="12" cy="12" r="9" opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" />
        </>
      ) : (
        <circle
          cx="12"
          cy="12"
          r="9"
          strokeDasharray={status === "queued" || status === "pending" ? "3 3.5" : undefined}
        />
      )}
      {status === "passed" ? <path d="m8 12.5 2.5 2.5L16 9.5" /> : null}
      {status === "failed" || status === "rejected" ? <path d="m9 9 6 6m0-6-6 6" /> : null}
      {status === "error" ? (
        <>
          <path d="M12 7.5v5" />
          <path d="M12 16.5h.01" />
        </>
      ) : null}
      {status === "skipped" ? <path d="m5.6 18.4 12.8-12.8" /> : null}
      {status === "cancelled" ? <rect x="9" y="9" width="6" height="6" rx="1" /> : null}
      {status === "awaiting_approval" ? (
        <>
          <path d="M10 9v6" />
          <path d="M14 9v6" />
        </>
      ) : null}
    </svg>
  );
}

const CHECK_OF: Record<StatusState, CiGlyphStatus> = {
  success: "passed",
  failure: "failed",
  error: "error",
  pending: "running",
};

/** One status context's state in a checks list. `null` is a check nothing has reported yet. */
export function CheckStateIcon({ state, size = 14 }: { state: StatusState | null; size?: number }) {
  return <CiStatusIcon status={state === null ? "waiting" : CHECK_OF[state]} size={size} />;
}

export type ThreadKind =
  | "issue-open"
  | "issue-closed"
  | "issue-not-planned"
  | "pull-open"
  | "pull-draft"
  | "pull-merged"
  | "pull-closed";

const THREAD: Record<ThreadKind, { icon: IconName; tone: string; label: string }> = {
  "issue-open": { icon: "circleDot", tone: "text-success", label: "Open issue" },
  "issue-closed": { icon: "checkCircle", tone: "text-notice", label: "Closed issue" },
  "issue-not-planned": {
    icon: "circleSlash",
    tone: "text-on-surface-muted",
    label: "Closed as not planned",
  },
  "pull-open": { icon: "gitPullRequest", tone: "text-success", label: "Open pull request" },
  "pull-draft": {
    icon: "gitPullRequestDraft",
    tone: "text-on-surface-muted",
    label: "Draft pull request",
  },
  "pull-merged": { icon: "gitMerge", tone: "text-notice", label: "Merged pull request" },
  "pull-closed": {
    icon: "gitPullRequestClosed",
    tone: "text-danger",
    label: "Closed pull request",
  },
};

export function issueKind(state: "open" | "closed", reason: string | null): ThreadKind {
  return state === "open"
    ? "issue-open"
    : reason === "not_planned"
      ? "issue-not-planned"
      : "issue-closed";
}

export function pullKind(state: "open" | "closed" | "merged", draft: boolean): ThreadKind {
  return state === "merged"
    ? "pull-merged"
    : state === "closed"
      ? "pull-closed"
      : draft
        ? "pull-draft"
        : "pull-open";
}

export const threadKindLabel = (kind: ThreadKind): string => THREAD[kind].label;

/** An issue's or pull request's state as its glyph, in the state's colour. */
export function ThreadStateIcon({ kind, size = 14 }: { kind: ThreadKind; size?: number }) {
  const { icon, tone, label } = THREAD[kind];
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex ${tone}`}>
      <Icon name={icon} size={size} />
    </span>
  );
}

const BADGE_TONE: Record<ThreadKind, string> = {
  "issue-open": "bg-success/15 text-success",
  "issue-closed": "bg-notice/15 text-notice",
  "issue-not-planned": "bg-surface-sunken text-on-surface-secondary",
  "pull-open": "bg-success/15 text-success",
  "pull-draft": "bg-surface-sunken text-on-surface-secondary",
  "pull-merged": "bg-notice/15 text-notice",
  "pull-closed": "bg-danger/15 text-danger",
};

const BADGE_TEXT: Record<ThreadKind, string> = {
  "issue-open": "Open",
  "issue-closed": "Closed",
  "issue-not-planned": "Not planned",
  "pull-open": "Open",
  "pull-draft": "Draft",
  "pull-merged": "Merged",
  "pull-closed": "Closed",
};

/** In the sidebar shell the pill is quiet: the state's colour is on its glyph alone. */
const QUIET_TONE: Record<ThreadKind, string> = {
  "issue-open": "text-on-surface-secondary",
  "issue-closed": "text-notice",
  "issue-not-planned": "text-on-surface-muted",
  "pull-open": "text-on-surface-secondary",
  "pull-draft": "text-on-surface-muted",
  "pull-merged": "text-notice",
  "pull-closed": "text-on-surface-muted",
};

/** The state pill beside a thread's title. */
export function ThreadStateBadge({ kind }: { kind: ThreadKind }) {
  const sidebar = useSidebarShell();
  if (sidebar) {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-on-surface">
        <Icon name={THREAD[kind].icon} size={13} className={QUIET_TONE[kind]} />
        {BADGE_TEXT[kind]}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${BADGE_TONE[kind]}`}
    >
      <Icon name={THREAD[kind].icon} size={13} />
      {BADGE_TEXT[kind]}
    </span>
  );
}
