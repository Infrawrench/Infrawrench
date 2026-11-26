/**
 * Status glyphs every page shares: a commit status, a CI run or job, an issue
 * or branch's state. Each is an image with a name, so a row that shows
 * only the icon still reads to a screen reader.
 */
import type { CiRunStatus, StatusState } from "@infrawrench/git-contract";
import { Icon, type IconName } from "./icons";

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
  | "page-open"
  | "page-draft"
  | "page-merged"
  | "page-closed";

const THREAD: Record<ThreadKind, { icon: IconName; tone: string; label: string; text: string }> = {
  "issue-open": { icon: "circleDot", tone: "text-success", label: "Open issue", text: "Open" },
  "issue-closed": {
    icon: "checkCircle",
    tone: "text-notice",
    label: "Closed issue",
    text: "Closed",
  },
  "issue-not-planned": {
    icon: "circleSlash",
    tone: "text-on-surface-muted",
    label: "Closed as not planned",
    text: "Not planned",
  },
  "page-open": {
    icon: "circleChevronUp",
    tone: "text-on-surface-secondary",
    label: "Open branch",
    text: "Open",
  },
  "page-draft": {
    icon: "circleDashed",
    tone: "text-on-surface-muted",
    label: "Draft branch",
    text: "Draft",
  },
  "page-merged": { icon: "gitMerge", tone: "text-notice", label: "Merged branch", text: "Merged" },
  "page-closed": {
    icon: "circleSlash",
    tone: "text-on-surface-muted",
    label: "Closed branch",
    text: "Closed",
  },
};

export function issueKind(state: "open" | "closed", reason: string | null): ThreadKind {
  return state === "open"
    ? "issue-open"
    : reason === "not_planned"
      ? "issue-not-planned"
      : "issue-closed";
}

/** A branch page's state as a thread kind. */
export function pageKind(state: "open" | "closed" | "merged", draft: boolean): ThreadKind {
  return state === "merged"
    ? "page-merged"
    : state === "closed"
      ? "page-closed"
      : draft
        ? "page-draft"
        : "page-open";
}

export const threadKindLabel = (kind: ThreadKind): string => THREAD[kind].label;

/** An issue's or a branch's state as its glyph, in the state's colour. */
export function ThreadStateIcon({ kind, size = 14 }: { kind: ThreadKind; size?: number }) {
  const { icon, tone, label } = THREAD[kind];
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex ${tone}`}>
      <Icon name={icon} size={size} />
    </span>
  );
}

/** The state pill beside a thread's title: quiet, the state's colour on its glyph alone. */
export function ThreadStateBadge({ kind }: { kind: ThreadKind }) {
  const { icon, tone, text } = THREAD[kind];
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-on-surface">
      <Icon name={icon} size={13} className={tone} />
      {text}
    </span>
  );
}
