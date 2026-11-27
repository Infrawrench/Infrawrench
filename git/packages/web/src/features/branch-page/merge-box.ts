/**
 * What the merge box shows, worked out from a branch page's `Mergeability`
 * and nothing else: one row each for reviews, checks and the branch, and what
 * the button at the bottom may do.
 */
import type { Mergeability, StatusState } from "@infrawrench/git-contract";

export type RowTone = "success" | "warning" | "danger" | "neutral";

export interface MergeRow {
  readonly tone: RowTone;
  readonly title: string;
  readonly detail: string | null;
}

export interface CheckRow {
  readonly context: string;
  /** Null: the base branch requires it and nothing has reported it yet. */
  readonly state: StatusState | null;
  readonly description: string | null;
  readonly targetUrl: string | null;
  /** The CI run behind it, whose page "Details" opens (`lib/checks.ts` `checkHref`). */
  readonly runId: string | null;
  readonly required: boolean;
}

export type MergeAction =
  /** Nothing stands in the way. */
  | { readonly mode: "merge" }
  /** Requirements are unmet and the viewer may merge past them. */
  | { readonly mode: "bypass"; readonly reasons: ReadonlyArray<string> }
  /** Something the viewer cannot override: the reason is shown instead of a button. */
  | { readonly mode: "blocked"; readonly reasons: ReadonlyArray<string> }
  /** The viewer has no say here (read access, a merged or closed branch). */
  | { readonly mode: "none" };

export interface MergeBoxModel {
  readonly reviews: MergeRow | null;
  readonly checks: MergeRow | null;
  readonly checkRows: ReadonlyArray<CheckRow>;
  readonly branch: MergeRow;
  readonly action: MergeAction;
  /** Ask again shortly: a trial merge or a check is still running. */
  readonly poll: boolean;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Every check a person should see: what reported, then what is required and has not. */
export function checkRows(checks: Mergeability["checks"]): CheckRow[] {
  const required = new Set(checks.required.map((item) => item.context));
  const rows: CheckRow[] = checks.statuses.map((status) => ({
    context: status.context,
    state: status.state,
    description: status.description,
    targetUrl: status.targetUrl,
    runId: status.runId,
    required: required.has(status.context),
  }));
  const reported = new Set(checks.statuses.map((status) => status.context));
  for (const item of checks.required) {
    if (!reported.has(item.context)) {
      rows.push({
        context: item.context,
        state: null,
        description: "Expected",
        targetUrl: null,
        runId: null,
        required: true,
      });
    }
  }
  const rank = (row: CheckRow): number =>
    row.state === "failure" || row.state === "error"
      ? 0
      : row.state === "pending" || row.state === null
        ? 1
        : 2;
  return rows.sort((a, b) => rank(a) - rank(b) || a.context.localeCompare(b.context));
}

function reviewRow(reviews: Mergeability["reviews"]): MergeRow | null {
  const { decision, approvals, requiredApprovals, changesRequested } = reviews;
  if (decision === "changes_requested") {
    return {
      tone: "danger",
      title: "Changes requested",
      detail: `${plural(changesRequested, "reviewer")} asked for changes`,
    };
  }
  if (decision === "approved") {
    return {
      tone: "success",
      title: "Approved",
      detail:
        requiredApprovals > 0
          ? `${approvals} of ${plural(requiredApprovals, "required approval")}`
          : plural(approvals, "approval"),
    };
  }
  if (decision === "review_required") {
    return {
      tone: "warning",
      title: "Review required",
      detail: `${approvals} of ${plural(requiredApprovals, "required approval")}`,
    };
  }
  return null;
}

function checksRow(rows: ReadonlyArray<CheckRow>): MergeRow | null {
  if (rows.length === 0) return null;
  const failed = rows.filter((row) => row.state === "failure" || row.state === "error");
  const waiting = rows.filter((row) => row.state === "pending" || row.state === null);
  const passed = rows.length - failed.length - waiting.length;
  const parts = [
    failed.length > 0 ? `${failed.length} failed` : null,
    waiting.length > 0 ? `${waiting.length} in progress` : null,
    passed > 0 ? `${passed} passed` : null,
  ].filter((part): part is string => part !== null);
  if (failed.length > 0) {
    return { tone: "danger", title: "Some checks failed", detail: parts.join(", ") };
  }
  if (waiting.length > 0) {
    return { tone: "warning", title: "Checks are running", detail: parts.join(", ") };
  }
  return { tone: "success", title: "All checks passed", detail: plural(passed, "check") };
}

function branchRow(mergeability: Mergeability, baseRef: string): MergeRow {
  const behind =
    mergeability.behindBy > 0
      ? `${plural(mergeability.behindBy, "commit")} behind ${baseRef}`
      : null;
  switch (mergeability.state) {
    case "conflicting":
      return {
        tone: "danger",
        title: "This branch has conflicts",
        detail: plural(mergeability.conflictFiles.length, "file"),
      };
    case "checking":
      return { tone: "warning", title: "Checking for conflicts", detail: null };
    case "clean":
      return { tone: "success", title: `No conflicts with ${baseRef}`, detail: behind };
    default:
      return { tone: "neutral", title: "Mergeability is not known", detail: behind };
  }
}

/** Blockers a rule's administrators may merge past. Everything else binds everyone. */
const SOFT = new Set([
  "checks_pending",
  "checks_failed",
  "approvals_required",
  "changes_requested",
]);

export function deriveMergeBox(mergeability: Mergeability, baseRef: string): MergeBoxModel {
  const rows = checkRows(mergeability.checks);
  const codes = mergeability.blockers.map((blocker) => blocker.code);
  const reasons = mergeability.blockers.map((blocker) => blocker.message);
  let action: MergeAction;
  if (codes.includes("merged") || codes.includes("closed") || codes.includes("no_permission")) {
    action = { mode: "none" };
  } else if (mergeability.canMerge && codes.length === 0) {
    action = { mode: "merge" };
  } else if (mergeability.canBypass && codes.every((code) => SOFT.has(code))) {
    action = { mode: "bypass", reasons };
  } else {
    action = { mode: "blocked", reasons };
  }
  return {
    reviews: reviewRow(mergeability.reviews),
    checks: checksRow(rows),
    checkRows: rows,
    branch: branchRow(mergeability, baseRef),
    action,
    poll:
      mergeability.state === "checking" ||
      rows.some((row) => row.state === "pending") ||
      codes.includes("checking") ||
      codes.includes("checks_pending"),
  };
}

export const MERGE_BUTTON: Record<"merge" | "squash" | "rebase", string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_LABEL: Record<"merge" | "squash" | "rebase", string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
};
