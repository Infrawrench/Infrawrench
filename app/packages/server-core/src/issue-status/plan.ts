/**
 * What one status reading does to a stored link row. Pure (no database), so
 * the rules `sync.ts` applies are pinned by tests: an older reading never
 * overwrites a newer one, the first reading is a baseline, and only a known,
 * unfinished status moving to done may resolve the finding.
 */
import {
  issueBecameDone,
  issueStatusChanged,
  isIssueReadingFresh,
  isIssueStatusCategory,
  type IssueStatusCategory,
  type IssueStatusSnapshot,
} from "@infrawrench/client-core";

/** What a link row holds now. */
export interface StoredIssueStatus {
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  issueUpdatedAt: Date | null;
}

export interface IssueStatusPlan {
  /** False when the reading is older than what is stored: only stamp the sync time. */
  fresh: boolean;
  /** A known status moved to another one (publish an event). */
  changed: boolean;
  /** A known, unfinished status moved to done (may resolve the finding). */
  becameDone: boolean;
  /** Whether any stored column differs from the reading. */
  differs: boolean;
  previous: { status: string | null; statusCategory: IssueStatusCategory | null };
}

/** Decide what a reading does to a stored row. */
export function planIssueStatusUpdate(
  stored: StoredIssueStatus,
  reading: IssueStatusSnapshot,
): IssueStatusPlan {
  const previous = {
    status: stored.status,
    statusCategory: isIssueStatusCategory(stored.statusCategory) ? stored.statusCategory : null,
  };
  const fresh = isIssueReadingFresh(stored.issueUpdatedAt, reading.issueUpdatedAt);
  if (!fresh) return { fresh, changed: false, becameDone: false, differs: false, previous };
  const differs =
    stored.status !== reading.status ||
    previous.statusCategory !== reading.statusCategory ||
    stored.assignee !== reading.assignee ||
    (stored.issueUpdatedAt?.toISOString() ?? null) !== reading.issueUpdatedAt;
  return {
    fresh,
    changed: issueStatusChanged(previous, reading),
    becameDone: issueBecameDone(previous, reading),
    differs,
    previous,
  };
}
